import type { AutoLockSettings } from './types';

/** 由桌面运行时提供的系统活动信息。 / System activity information supplied by the desktop runtime. */
export interface SystemActivityMonitor {
  readonly available?: boolean;
  getSystemIdleSeconds(): number;
  onScreenLock(listener: () => void): () => void;
}

/** 可替换的计时器边界，避免单元测试依赖真实时间。 / Replaceable timer boundary so unit tests do not depend on real time. */
export interface IntervalScheduler {
  setInterval(handler: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/** 自动锁定请求来源。 / Source of an automatic lock request. */
export type AutoLockReason = 'idle' | 'screen-lock';

/** 自动锁定管理器配置。 / Automatic-lock manager options. */
export interface AutoLockManagerOptions {
  monitor: SystemActivityMonitor;
  isMounted: () => boolean;
  lock: (reason: AutoLockReason) => Promise<void>;
  onError?: (error: unknown, reason: AutoLockReason) => void;
  scheduler?: IntervalScheduler;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * 在系统空闲或锁屏时请求同一条安全锁定流程；不处理密码或解锁。
 * Requests the same safe lock flow on system idle or screen lock; never handles passwords or unlocking.
 */
export class AutoLockManager {
  private policy: AutoLockSettings = { idleLockMinutes: 0, lockOnScreenLock: false };
  private timer: ReturnType<typeof setInterval> | null = null;
  private removeScreenLockListener: (() => void) | null = null;
  private running = false;
  private lockInFlight = false;
  private idleLockRequested = false;
  private readonly scheduler: IntervalScheduler;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: AutoLockManagerOptions) {
    this.scheduler = options.scheduler ?? {
      setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
      clearInterval: (handle) => clearInterval(handle),
    };
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(policy: AutoLockSettings): void {
    this.running = true;
    this.update(policy);
  }

  update(policy: AutoLockSettings): void {
    this.policy = { ...policy };
    this.idleLockRequested = false;
    this.stopListeners();
    if (!this.running) {
      return;
    }
    if (this.policy.idleLockMinutes > 0) {
      this.timer = this.scheduler.setInterval(() => void this.checkIdle(), this.pollIntervalMs);
    }
    if (this.policy.lockOnScreenLock) {
      this.removeScreenLockListener = this.options.monitor.onScreenLock(() => void this.requestLock('screen-lock'));
    }
  }

  stop(): void {
    this.running = false;
    this.stopListeners();
  }

  /** 立即检查空闲时间，供计时器和单元测试调用。 / Check idle time immediately for timers and unit tests. */
  async checkIdle(): Promise<void> {
    if (!this.running || this.policy.idleLockMinutes <= 0) {
      return;
    }
    const thresholdSeconds = this.policy.idleLockMinutes * 60;
    if (this.options.monitor.getSystemIdleSeconds() < thresholdSeconds) {
      this.idleLockRequested = false;
      return;
    }
    if (this.options.isMounted() && !this.idleLockRequested) {
      this.idleLockRequested = true;
      await this.requestLock('idle');
    }
  }

  private stopListeners(): void {
    if (this.timer) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    this.removeScreenLockListener?.();
    this.removeScreenLockListener = null;
  }

  private async requestLock(reason: AutoLockReason): Promise<void> {
    if (!this.running || this.lockInFlight || !this.options.isMounted()) {
      return;
    }
    this.lockInFlight = true;
    try {
      await this.options.lock(reason);
    } catch (error) {
      this.options.onError?.(error, reason);
    } finally {
      this.lockInFlight = false;
    }
  }
}
