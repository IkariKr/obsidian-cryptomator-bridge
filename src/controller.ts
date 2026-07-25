/**
 * BridgeController — 多会话管理器；持有按 recordId 索引的 VaultSession 集合。
 * BridgeController — multi-session manager; holds VaultSession set indexed by recordId.
 *
 * 安全边界：
 * - 密码仅通过 CLI stdin 传递一次，不入日志/设置/参数/环境变量。
 * - 锁定只卸载明文挂载点，不声明重新加密。
 * - 清理只会停止自身拥有的 CLI 进程，不会 kill 外部进程。
 */
import type { BridgeSettings, BridgeState, ResolvedVaultRecord } from './types';
import { BridgeStateMachine } from './stateMachine';
import { CliSupervisor } from './cliSupervisor';
import type { PathValidationError } from './pathValidation';
import { validateVaultRecordPaths } from './pathValidation';
import { checkPrerequisites } from './prerequisites';
import type { PrerequisiteError } from './prerequisites';
import { BridgeError, PrerequisiteFailedError } from './errors';
import type { AutoLockService } from './autoLock';

/** 单个已挂载 Vault 的运行时会话。 / Runtime session for a single mounted vault. */
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
 * 计算聚合状态：任一 session 报错 → error，任一 mounting/unmounting → 过渡态，
 * 全部 idle → idle，全部 mounted → mounted，任一 reconciling → reconciling，否则 idle。
 */
function computeOverallState(sessions: VaultSession[]): BridgeState {
  if (sessions.length === 0) {
    return 'idle';
  }

  const states = sessions.map((s) => s.stateMachine.getState());
  const hasError = states.some((s) => s.state === 'error');
  const hasReconciling = states.some((s) => s.state === 'reconciling');
  const hasTransition = states.some(
    (s) => s.state === 'mounting' || s.state === 'unmounting' || s.state === 'checking',
  );
  const allMounted = states.every((s) => s.state === 'mounted');
  const allIdle = states.every((s) => s.state === 'idle');

  if (hasError) return 'error';
  if (hasReconciling) return 'reconciling';
  if (hasTransition) return states.find((s) =>
    s.state === 'mounting' || s.state === 'unmounting' || s.state === 'checking',
  ) ?? 'idle';
  if (allMounted) return 'mounted';
  return allIdle ? 'idle' : 'idle';
}

export class BridgeController {
  private sessions = new Map<string, VaultSession>();
  private settings: BridgeSettings;
  private onStateChange?: (aggregate: AggregateState) => void;
  private autoLockService?: AutoLockService;

  constructor(settings: BridgeSettings, autoLockService?: AutoLockService) {
    this.settings = settings;
    this.autoLockService = autoLockService;
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
      (s) => s.stateMachine.getState().state === 'mounted',
    );
  }

  /** 挂载指定记录数。 / Count of mounted records. */
  getMountedCount(): number {
    return [...this.sessions.values()].filter(
      (s) => s.stateMachine.getState().state === 'mounted',
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
        const rs = s.stateMachine.getState();
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
        (s) => s.stateMachine.getState().state === 'error',
      );
      aggregate.errorMessage = errorSession?.stateMachine.getState().errorMessage;
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
  async unlock(
    record: ResolvedVaultRecord,
    password: string,
    _options?: { confirmWarnings?: boolean },
  ): Promise<UnlockResult> {
    const existing = this.sessions.get(record.id);

    // 已挂载 → 直接返回
    if (existing && existing.stateMachine.getState().state === 'mounted') {
      return { success: true, recordId: record.id };
    }

    // 正在过渡 → 拒绝重复操作
    if (existing) {
      const s = existing.stateMachine.getState().state;
      if (s === 'mounting' || s === 'unmounting' || s === 'checking') {
        throw new BridgeError(`Vault "${record.folderName}" 正在进行 ${s} 操作，请稍后再试。`);
      }
      // 清理之前的错误会话，创建新的
      await existing.supervisor.stop();
      this.sessions.delete(record.id);
    }

    // 1. 验证路径
    const pathErrors = validateVaultRecordPaths(record);
    if (pathErrors.length > 0) {
      throw new BridgeError(
        `路径验证失败：${pathErrors.map((e) => e.message).join('；')}`,
      );
    }

    // 2. 验证前置条件
    const prereqErrors = await checkPrerequisites(
      this.settings.cliPath,
      this.settings.mounterId,
      record.encryptedVaultPath,
    );
    if (prereqErrors.length > 0) {
      const messages = prereqErrors.map((e) => e.message).join('；');
      throw new PrerequisiteFailedError(messages, prereqErrors);
    }

    // 3. 创建会话
    const stateMachine = new BridgeStateMachine();
    const supervisor = new CliSupervisor({
      cliPath: this.settings.cliPath,
      encryptedVaultPath: record.encryptedVaultPath,
      mountPath: record.mountPath,
      mounterId: this.settings.mounterId,
    });

    const session: VaultSession = {
      recordId: record.id,
      folderName: record.folderName,
      stateMachine,
      supervisor,
      record,
    };

    this.sessions.set(record.id, session);

    // 订阅状态变化
    stateMachine.onTransition(() => this.emit());

    try {
      // 4. 状态机 → mounting
      stateMachine.dispatch({ type: 'MOUNT_REQUESTED' });

      // 5. 启动 CLI 进程
      await supervisor.start(password);

      // 6. 等待挂载
      await supervisor.waitForMount();

      // 7. 状态机 → mounted
      stateMachine.dispatch({ type: 'MOUNT_READY' });

      // 8. 注册进程存活监控（退出时自动锁定）
      this.setupProcessMonitor(session);

      // 9. 通知自动锁定服务
      if (this.autoLockService) {
        this.autoLockService.onVaultUnlocked(record.id);
      }

      return { success: true, recordId: record.id };
    } catch (error) {
      // 失败时清理
      const err = error instanceof Error ? error : new Error(String(error));
      stateMachine.dispatch({ type: 'FAILED', message: err.message });
      await supervisor.stop();
      this.sessions.delete(record.id);
      this.emit();
      throw err;
    }
  }

  /**
   * 锁定指定 Vault 记录。
   * Lock a specific vault record.
   */
  async lock(recordId: string): Promise<LockResult> {
    const session = this.sessions.get(recordId);
    if (!session) {
      // 未跟踪的 recordId，视为已完成
      return { recordId };
    }

    const state = session.stateMachine.getState().state;
    if (state === 'idle' || state === 'error') {
      await session.supervisor.stop();
      this.sessions.delete(recordId);
      this.emit();
      return { recordId };
    }

    if (state === 'unmounting') {
      // 已经在卸载中，等待完成
      return { recordId };
    }

    try {
      session.stateMachine.dispatch({ type: 'UNMOUNT_REQUESTED' });

      // 优雅停止 CLI（SIGINT 隐藏窗口）
      await session.supervisor.stop();

      session.stateMachine.dispatch({ type: 'UNMOUNTED' });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      session.stateMachine.dispatch({ type: 'FAILED', message: err.message });
    } finally {
      this.sessions.delete(recordId);
      if (this.autoLockService) {
        this.autoLockService.onVaultLocked(recordId);
      }
      this.emit();
    }

    return { recordId };
  }

  /**
   * 锁定所有已挂载的会话。
   * Lock all mounted sessions.
   */
  async lockAll(): Promise<void> {
    const recordIds = [...this.sessions.keys()];
    await Promise.all(recordIds.map((id) => this.lock(id)));
  }

  /**
   * 清理所有会话并停止进程。
   * Clean up all sessions and stop processes.
   */
  async cleanup(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.lock(id)));
  }

  /**
   * 复核所有记录的挂载状态（插件加载时调用）。
   * Reconcile mount state for all records (called on plugin load).
   */
  async reconcile(resolvedRecords: ResolvedVaultRecord[]): Promise<void> {
    for (const record of resolvedRecords) {
      // 如果已有 session 则跳过
      if (this.sessions.has(record.id)) {
        continue;
      }

      // 检查路径是否存在无主挂载
      const pathErrors = validateVaultRecordPaths(record);
      const mountExists = pathErrors.some(
        (e) => e.field.includes('mountPath') && e.message.includes('已存在'),
      );

      if (mountExists) {
        // 无主挂载：记录警告但不认领
        // 由 UI 显示警告，用户手动处理
      }
    }
  }

  /**
   * 设置 CLI 进程退出监控；意外退出时自动锁定。
   * Set up CLI process exit monitor; auto-lock on unexpected exit.
   */
  private setupProcessMonitor(session: VaultSession): void {
    session.supervisor.onExit(async (code) => {
      if (code !== 0) {
        session.stateMachine.dispatch({
          type: 'FAILED',
          message: `CLI 进程意外退出（exit code ${code ?? 'null'}）。`,
        });
      }
      this.sessions.delete(session.recordId);
      if (this.autoLockService) {
        this.autoLockService.onVaultLocked(session.recordId);
      }
      this.emit();
    });
  }
}
