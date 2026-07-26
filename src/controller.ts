/**
 * BridgeController — 多会话管理器；持有按 recordId 索引的 VaultSession 集合。
 * BridgeController — multi-session manager; holds VaultSession set indexed by recordId.
 *
 * 安全边界：
 * - 密码仅通过 CLI stdin 传递一次，不入日志/设置/参数/环境变量。
 * - 锁定只卸载明文挂载点，不声明重新加密。
 * - 清理只会停止自身拥有的 CLI 进程，不会 kill 外部进程。
 * - 卸载失败（句柄占用/挂载仍可访问）时保留会话为 error，不伪造已锁定状态。
 *
 * Security boundary:
 * - The password is passed once through CLI stdin only; never logged/persisted/argv/env.
 * - Locking only unmounts the plaintext mount point; it never claims re-encryption.
 * - Cleanup stops only the CLI process this instance owns; it never kills external processes.
 * - On unmount failure (open handle / still-accessible mount) the session stays in error, never faking a locked state.
 */
import type { BridgeSettings, BridgeState, ResolvedVaultRecord } from './types';
import { BridgeStateMachine } from './stateMachine';
import { CliSupervisor, type CliExitResult } from './cliSupervisor';
import { validateVaultRecordPaths } from './pathValidation';
import { checkPrerequisites } from './prerequisites';
import { BridgeError, PrerequisiteFailedError } from './errors';

/** 单个 Vault 的运行时会话。 / Runtime session for a single vault. */
export interface VaultSession {
  recordId: string;
  folderName: string;
  stateMachine: BridgeStateMachine;
  supervisor: CliSupervisor;
  record: ResolvedVaultRecord;
}

/** 多会话聚合状态，用于 UI 展示。 / Aggregate multi-session state for UI display. */
export interface AggregateState {
  overallState: BridgeState;
  sessions: Array<{
    recordId: string;
    folderName: string;
    state: BridgeState;
    errorMessage?: string;
  }>;
  errorMessage?: string;
}

export interface UnlockResult {
  success: true;
  recordId: string;
}

export interface LockResult {
  recordId: string;
}

/**
 * 计算聚合状态：任一 session 报错 → error，任一过渡态 → 该过渡态，
 * 全部 mounted → mounted，任一 reconciling → reconciling，否则 idle。
 * Compute aggregate state: any error → error, any transition → that transition,
 * all mounted → mounted, any reconciling → reconciling, otherwise idle.
 */
function computeOverallState(sessions: VaultSession[]): BridgeState {
  if (sessions.length === 0) {
    return 'idle';
  }

  const states = sessions.map((s) => s.stateMachine.state.state);
  if (states.some((s) => s === 'error')) return 'error';
  const transition = states.find(
    (s) => s === 'mounting' || s === 'unmounting' || s === 'checking',
  );
  if (transition) return transition;
  if (states.some((s) => s === 'reconciling')) return 'reconciling';
  if (states.every((s) => s === 'mounted')) return 'mounted';
  return 'idle';
}

export class BridgeController {
  private sessions = new Map<string, VaultSession>();
  private settings: BridgeSettings;
  private onStateChange?: (aggregate: AggregateState) => void;

  constructor(
    settings: BridgeSettings,
    private readonly currentControlVaultPath?: string,
  ) {
    this.settings = settings;
  }

  /** 更新设置引用（如设置页保存后）。 / Update settings reference (e.g., after settings tab save). */
  updateSettings(settings: BridgeSettings): void {
    this.settings = settings;
  }

  /** 注册 UI 状态变更回调。 / Register UI state change callback. */
  onStateChanged(callback: (aggregate: AggregateState) => void): void {
    this.onStateChange = callback;
  }

  /** 获取当前所有会话的只读视图。 / Get read-only view of all current sessions. */
  getAllSessions(): ReadonlyMap<string, VaultSession> {
    return this.sessions;
  }

  /** 是否有任何记录已挂载。 / Whether any record is mounted. */
  isAnyMounted(): boolean {
    return [...this.sessions.values()].some(
      (s) => s.stateMachine.state.state === 'mounted',
    );
  }

  /** 挂载中的记录数。 / Count of mounted records. */
  getMountedCount(): number {
    return [...this.sessions.values()].filter(
      (s) => s.stateMachine.state.state === 'mounted',
    ).length;
  }

  /** 获取已有会话（即使未挂载）。 / Get existing session (even if not mounted). */
  getSession(recordId: string): VaultSession | undefined {
    return this.sessions.get(recordId);
  }

  /** 发射聚合状态给回调。 / Emit aggregate state to callback. */
  private emit(): void {
    if (!this.onStateChange) {
      return;
    }
    const sessions = [...this.sessions.values()];
    const aggregate: AggregateState = {
      overallState: computeOverallState(sessions),
      sessions: sessions.map((s) => {
        const rs = s.stateMachine.state;
        return {
          recordId: s.recordId,
          folderName: s.folderName,
          state: rs.state,
          errorMessage: rs.errorMessage,
        };
      }),
    };

    if (aggregate.overallState === 'error') {
      const errorSession = sessions.find(
        (s) => s.stateMachine.state.state === 'error',
      );
      aggregate.errorMessage = errorSession?.stateMachine.state.errorMessage;
    }

    this.onStateChange(aggregate);
  }

  /**
   * 解锁指定 Vault 记录。
   * - 对已挂载的记录再次解锁会直接返回成功。
   * - 密码仅通过 CLI stdin 传递一次。
   * Unlock a specific vault record.
   * - Unlocking an already-mounted record returns success immediately.
   * - Password is passed only once through CLI stdin.
   */
  async unlock(record: ResolvedVaultRecord, passwordInput: string): Promise<UnlockResult> {
    const existing = this.sessions.get(record.id);

    // 已挂载 → 直接返回。 / Already mounted → return immediately.
    if (existing && existing.stateMachine.state.state === 'mounted') {
      return { success: true, recordId: record.id };
    }

    // 正在过渡 → 拒绝重复操作。 / In transition → reject duplicate operation.
    if (existing) {
      const s = existing.stateMachine.state.state;
      if (s === 'mounting' || s === 'unmounting' || s === 'checking') {
        throw new BridgeError(
          `Vault "${record.folderName}" 正在进行 ${s} 操作，请稍后再试。`,
          'busy',
        );
      }
      // 清理之前的 idle/error 会话（若仍持有进程则先安全停止）。
      // Clean up the previous idle/error session (safely stop first if a process is still held).
      await this.disposeSession(existing);
    }

    // 1. 验证路径。 / Validate paths.
    const pathErrors = validateVaultRecordPaths(record, this.currentControlVaultPath);
    if (pathErrors.length > 0) {
      throw new BridgeError(
        `路径验证失败：${pathErrors.map((e) => e.message).join('；')}`,
        'path-validation',
      );
    }

    // 2. 验证前置条件。 / Validate prerequisites.
    const prereqErrors = await checkPrerequisites(
      this.settings.cliPath,
      this.settings.mounterId,
      record.encryptedVaultPath,
    );
    if (prereqErrors.length > 0) {
      const messages = prereqErrors.map((e) => e.message).join('；');
      throw new PrerequisiteFailedError(messages, prereqErrors);
    }

    // 3. 创建会话；进程意外退出交给监控回调处理。
    // Create the session; unexpected process exit is handled by the monitor callback.
    const stateMachine = new BridgeStateMachine();
    const supervisor = new CliSupervisor({
      onUnexpectedExit: (exit) => this.handleUnexpectedExit(record.id, exit),
    });

    const session: VaultSession = {
      recordId: record.id,
      folderName: record.folderName,
      stateMachine,
      supervisor,
      record,
    };
    this.sessions.set(record.id, session);

    try {
      // 4. 状态机走完 reconciling → idle → checking → mounting。
      // Advance the state machine reconciling → idle → checking → mounting.
      stateMachine.transition({ type: 'PREREQUISITES_OK' }); // reconciling → idle
      stateMachine.transition({ type: 'MOUNT_REQUESTED' }); // idle → checking
      stateMachine.transition({ type: 'PREREQUISITES_OK' }); // checking → mounting
      this.emit();

      // 5. 启动 CLI 并等待挂载（密码仅经 stdin 传递一次）。
      // Start the CLI and wait for the mount (password passed once via stdin).
      await supervisor.unlock(
        {
          cliPath: this.settings.cliPath,
          encryptedVaultPath: record.encryptedVaultPath,
          mountPath: record.mountPath,
          mounterId: this.settings.mounterId,
        },
        passwordInput,
      );

      // 6. 状态机 → mounted。 / State machine → mounted.
      stateMachine.transition({ type: 'MOUNT_READY' });
      this.emit();

      return { success: true, recordId: record.id };
    } catch (error) {
      // 失败时保留 error 会话供 UI 展示与恢复；supervisor.unlock 已释放自身进程引用。
      // On failure keep the error session for UI display and recovery; supervisor.unlock already released its process ref.
      const err = error instanceof Error ? error : new Error(String(error));
      if (stateMachine.state.state !== 'error') {
        stateMachine.transition({ type: 'FAILED', message: err.message });
      }
      this.emit();
      throw err;
    } finally {
      passwordInput = '';
    }
  }

  /**
   * 锁定指定 Vault 记录。仅在 CLI 退出且挂载不可访问时返回 idle；否则保留 error。
   * Lock a specific vault record. Returns idle only when the CLI exited and the mount is inaccessible; otherwise keeps error.
   */
  async lock(recordId: string): Promise<LockResult> {
    const session = this.sessions.get(recordId);
    if (!session) {
      // 未跟踪的 recordId，视为已完成。 / Untracked recordId; treat as done.
      return { recordId };
    }

    const state = session.stateMachine.state.state;

    // idle / error / reconciling：无需卸载流程，安全释放已死进程后移除会话。
    // idle / error / reconciling: no unmount flow needed; release any dead process and drop the session.
    if (state === 'idle' || state === 'error' || state === 'reconciling') {
      await this.disposeSession(session);
      this.sessions.delete(recordId);
      this.emit();
      return { recordId };
    }

    // 已在卸载中：等待其自身完成。 / Already unmounting: let it finish.
    if (state === 'unmounting') {
      return { recordId };
    }

    // mounted / mounting / checking：执行优雅停止。
    // mounted / mounting / checking: perform the graceful stop.
    try {
      // 仅从 mounted 才能进入 unmounting；过渡态直接尝试停止进程。
      // Only mounted can enter unmounting; for transient states just try to stop the process.
      if (state === 'mounted') {
        session.stateMachine.transition({ type: 'UNMOUNT_REQUESTED' });
        this.emit();
      }

      await session.supervisor.stop(session.record.mountPath);

      if (state === 'mounted') {
        session.stateMachine.transition({ type: 'UNMOUNTED' });
      } else {
        session.stateMachine.transition({ type: 'FAILED', message: '挂载在完成前被停止。' });
      }
      this.sessions.delete(recordId);
      this.emit();
      return { recordId };
    } catch (error) {
      // 卸载失败：保留会话为 error（进程句柄仍由本实例持有），不伪造已锁定。
      // Unmount failed: keep the session in error (process handle still owned), never fake a locked state.
      const err = error instanceof Error ? error : new Error(String(error));
      session.stateMachine.transition({ type: 'FAILED', message: err.message });
      this.emit();
      throw err;
    }
  }

  /**
   * 锁定所有跟踪中的会话；聚合失败以便调用方提示用户。
   * Lock all tracked sessions; aggregate failures so the caller can notify the user.
   */
  async lockAll(): Promise<void> {
    const recordIds = [...this.sessions.keys()];
    const results = await Promise.allSettled(recordIds.map((id) => this.lock(id)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      const messages = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join('；');
      throw new BridgeError(`部分私密笔记库锁定失败：${messages}`, 'lock-all');
    }
  }

  /**
   * 清理所有会话并停止进程；用于插件卸载。
   * Clean up all sessions and stop processes; used on plugin unload.
   */
  async cleanup(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.lock(id)));
  }

  /**
   * 复核所有记录的挂载状态（插件加载时调用）。
   * 发现无主挂载（挂载目录已存在但本实例未持有进程）时，进入可恢复 error，不认领、不卸载。
   * Reconcile mount state for all records (called on plugin load).
   * When an unowned mount is found (mount dir exists but this instance owns no process) it enters a recoverable error;
   * it never claims or unmounts.
   */
  async reconcile(resolvedRecords: ResolvedVaultRecord[]): Promise<void> {
    for (const record of resolvedRecords) {
      if (this.sessions.has(record.id)) {
        continue;
      }

      const pathErrors = validateVaultRecordPaths(record, this.currentControlVaultPath);
      const mountExists = pathErrors.some(
        (e) => e.field.includes('mountPath') && e.message.includes('已存在'),
      );

      if (mountExists) {
        const stateMachine = new BridgeStateMachine();
        const supervisor = new CliSupervisor();
        stateMachine.transition({
          type: 'FAILED',
          message:
            `检测到无主挂载目录 ${record.folderName}${'.cryptomator-mount'}；` +
            '请手动确认或删除后重试。插件不会自动认领或卸载它。',
        });
        this.sessions.set(record.id, {
          recordId: record.id,
          folderName: record.folderName,
          stateMachine,
          supervisor,
          record,
        });
      }
    }
    this.emit();
  }

  /**
   * 处理 CLI 进程意外退出：会话进入可恢复 error，等待用户重试或锁定清理。
   * Handle unexpected CLI exit: the session enters a recoverable error, awaiting user retry or lock cleanup.
   */
  private handleUnexpectedExit(recordId: string, exit: CliExitResult): void {
    const session = this.sessions.get(recordId);
    if (!session) {
      return;
    }
    const current = session.stateMachine.state.state;
    if (current === 'error') {
      return;
    }
    session.stateMachine.transition({
      type: 'FAILED',
      message: `CLI 进程意外退出（code ${exit.code ?? 'null'}，signal ${exit.signal ?? 'null'}）。`,
    });
    this.emit();
  }

  /**
   * 安全释放一个会话仍持有的进程；不改变会话状态，仅用于移除前的清理。
   * Safely release any process still held by a session; does not change session state, only pre-removal cleanup.
   */
  private async disposeSession(session: VaultSession): Promise<void> {
    if (session.supervisor.ownsProcess) {
      await session.supervisor.stop(session.record.mountPath);
    }
  }
}

export { BridgeError, PrerequisiteFailedError } from './errors';
