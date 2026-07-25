import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { MountError, UnownedMountError } from './errors';
import { RedactedDiagnostics } from './diagnostics';

const DEFAULT_MOUNT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** CLI 退出结果。 / Result of CLI process exit. */
export interface CliExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** 解锁所需参数。 / Parameters required for unlock. */
export interface UnlockParams {
  cliPath: string;
  encryptedVaultPath: string;
  mountPath: string;
  mounterId: string;
}

/** 监督器可配置项。 / Configurable options for the supervisor. */
export interface SupervisorOptions {
  mountTimeoutMs?: number;
  onUnexpectedExit?: (exit: CliExitResult) => void;
  onExit?: (code: number | null) => void;
  spawnProcess?: SpawnProcess;
}

/** 受控 spawn seam，便于无真实 CLI 的单元测试。 / Controlled spawn seam for unit tests without a real CLI. */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { shell: false; windowsHide: boolean; detached: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcessWithoutNullStreams;

/** 解锁完成后的有界诊断结果。 / Bounded diagnostics returned after unlock. */
export interface UnlockResult {
  diagnostics: { stdout: ReturnType<RedactedDiagnostics['summary']>; stderr: ReturnType<RedactedDiagnostics['summary']> };
}

/**
 * 构造结构化 CLI 参数数组；密码永远不在参数中。
 * Build structured CLI argument arrays; the password is never included in arguments.
 */
export function createUnlockArgs(params: UnlockParams): readonly string[] {
  return [
    'unlock',
    '--password:stdin',
    `--mounter=${params.mounterId}`,
    `--mountPoint=${params.mountPath}`,
    params.encryptedVaultPath,
  ];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function canAccess(directoryPath: string): Promise<boolean> {
  try {
    await access(directoryPath, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForMountAvailability(
  child: ChildProcessWithoutNullStreams,
  mountPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new MountError('CLI 在挂载完成前退出，请检查密码、WinFsp 和路径配置。');
    }
    if (await canAccess(mountPath)) {
      return;
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw new MountError('挂载在限定时间内未变为可访问状态。');
}

async function waitForMountInaccessibility(mountPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canAccess(mountPath))) {
      return true;
    }
    await wait(POLL_INTERVAL_MS);
  }
  return false;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<CliExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function mapExitError(exit: CliExitResult, stderr: string): MountError {
  if (/InvalidPassphraseException|invalid passphrase|wrong password/iu.test(stderr)) {
    return new MountError('密码错误，或密码与所选密文 Vault 不匹配。');
  }
  if (exit.signal !== null) {
    return new MountError('CLI 被意外停止，挂载未完成。');
  }
  return new MountError('Cryptomator CLI 未能完成挂载。');
}

/**
 * 只监督当前实例创建的 CLI 进程；停止使用 SIGINT，并等待挂载点消失。
 * Supervises only the CLI process created by this instance; stops with SIGINT and waits for mount disappearance.
 */
export class CliSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitPromise: Promise<CliExitResult> | null = null;
  private stopRequested = false;
  private readonly mountTimeoutMs: number;
  private readonly spawnProcess: SpawnProcess;

  constructor(private readonly options: SupervisorOptions = {}) {
    this.mountTimeoutMs = options.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? (spawn as unknown as SpawnProcess);
  }

  get ownsProcess(): boolean {
    return this.child !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async unlock(params: UnlockParams, password: string): Promise<UnlockResult> {
    if (this.child) {
      throw new MountError('当前实例已经持有一个 CLI 进程。');
    }
    if (await canAccess(params.mountPath)) {
      throw new UnownedMountError();
    }

    const stdout = new RedactedDiagnostics([params.cliPath, params.encryptedVaultPath, params.mountPath], [password]);
    const stderr = new RedactedDiagnostics([params.cliPath, params.encryptedVaultPath, params.mountPath], [password]);
    const child = this.spawnProcess(params.cliPath, createUnlockArgs(params), {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stopRequested = false;
    this.exitPromise = waitForExit(child);
    void this.exitPromise.then((exit) => {
      if (!this.stopRequested) {
        this.options.onUnexpectedExit?.(exit);
      }
      this.options.onExit?.(exit.code);
    }).catch(() => undefined);
    child.stdout.on('data', (chunk: Buffer) => stdout.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.consume(chunk));

    const passwordBytes = Buffer.from(password, 'utf8');
    password = '';
    const stdinPayload = Buffer.alloc(passwordBytes.length + 1);
    passwordBytes.copy(stdinPayload);
    stdinPayload[stdinPayload.length - 1] = 0x0a;
    passwordBytes.fill(0);
    child.stdin.end(stdinPayload, () => stdinPayload.fill(0));

    try {
      await waitForMountAvailability(child, params.mountPath, this.mountTimeoutMs);
      return { diagnostics: { stdout: stdout.summary(), stderr: stderr.summary() } };
    } catch (error) {
      if (child.exitCode === null) {
        this.stopRequested = true;
        child.kill('SIGINT');
        await this.exitPromise.catch(() => undefined);
        await waitForMountInaccessibility(params.mountPath, this.mountTimeoutMs);
      }
      this.child = null;
      this.exitPromise = null;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw mapExitError({ code: child.exitCode, signal: child.signalCode }, stderr.summary().text);
      }
      if (error instanceof MountError || error instanceof UnownedMountError) {
        throw error;
      }
      throw mapExitError({ code: child.exitCode, signal: child.signalCode }, stderr.summary().text);
    }
  }

  async stop(mountPath: string): Promise<CliExitResult> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    if (!child || !exitPromise) {
      throw new MountError('当前实例没有可停止的 CLI 进程。');
    }

    this.stopRequested = true;
    if (child.exitCode === null) {
      child.kill('SIGINT');
    }
    const exit = await exitPromise.catch(() => ({ code: child.exitCode, signal: child.signalCode }));
    const inaccessible = await waitForMountInaccessibility(mountPath, this.mountTimeoutMs);
    if (!inaccessible) {
      throw new MountError('CLI 已退出，但挂载点仍可访问；插件不会伪造已锁定状态。');
    }

    this.child = null;
    this.exitPromise = null;
    return exit;
  }

  async cleanup(mountPath: string): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.stop(mountPath);
  }
}
