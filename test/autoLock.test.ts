import { describe, expect, it, vi } from 'vitest';
import { AutoLockManager, type SystemActivityMonitor } from '../src/autoLock';

function monitorFixture(): { monitor: SystemActivityMonitor; setIdleSeconds: (value: number) => void; triggerScreenLock: () => void } {
  let idleSeconds = 0;
  let listener: (() => void) | null = null;
  return {
    monitor: {
      getSystemIdleSeconds: () => idleSeconds,
      onScreenLock: (nextListener) => {
        listener = nextListener;
        return () => { listener = null; };
      },
    },
    setIdleSeconds: (value) => { idleSeconds = value; },
    triggerScreenLock: () => listener?.(),
  };
}

describe('automatic locking', () => {
  it('locks once when the configured idle threshold is reached and resets after activity', async () => {
    const fixture = monitorFixture();
    const lock = vi.fn(async () => undefined);
    const manager = new AutoLockManager({ monitor: fixture.monitor, isMounted: () => true, lock });
    manager.start({ idleLockMinutes: 1, lockOnScreenLock: false });
    fixture.setIdleSeconds(60);
    await manager.checkIdle();
    await manager.checkIdle();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenLastCalledWith('idle');
    fixture.setIdleSeconds(0);
    await manager.checkIdle();
    fixture.setIdleSeconds(60);
    await manager.checkIdle();
    expect(lock).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('locks on Windows screen lock only when enabled and only for a mounted Vault', async () => {
    const fixture = monitorFixture();
    const lock = vi.fn(async () => undefined);
    let mounted = true;
    const manager = new AutoLockManager({ monitor: fixture.monitor, isMounted: () => mounted, lock });
    manager.start({ idleLockMinutes: 0, lockOnScreenLock: true });
    fixture.triggerScreenLock();
    await Promise.resolve();
    expect(lock).toHaveBeenCalledWith('screen-lock');
    mounted = false;
    fixture.triggerScreenLock();
    await Promise.resolve();
    expect(lock).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it('reports an automatic-lock failure without retrying the same idle period', async () => {
    const fixture = monitorFixture();
    const error = new Error('open handle');
    const onError = vi.fn();
    const manager = new AutoLockManager({
      monitor: fixture.monitor,
      isMounted: () => true,
      lock: async () => { throw error; },
      onError,
    });
    manager.start({ idleLockMinutes: 1, lockOnScreenLock: false });
    fixture.setIdleSeconds(60);
    await manager.checkIdle();
    await manager.checkIdle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, 'idle');
    manager.stop();
  });
});
