import { powerMonitor, remote } from 'electron';
import type { SystemActivityMonitor } from './autoLock';

interface PowerMonitorLike {
  getSystemIdleTime(): number;
  on(event: 'lock-screen', listener: () => void): void;
  removeListener(event: 'lock-screen', listener: () => void): void;
}

function resolvePowerMonitor(): PowerMonitorLike | undefined {
  const direct = powerMonitor as unknown as PowerMonitorLike | undefined;
  if (direct && typeof direct.getSystemIdleTime === 'function') {
    return direct;
  }

  // Obsidian plugins run in Electron's renderer; older desktop builds expose the main-process monitor through remote.
  // Obsidian 插件运行在 Electron renderer；旧版桌面构建通过 remote 暴露主进程监控器。
  try {
    const mainElectron = remote?.require('electron') as { powerMonitor?: PowerMonitorLike } | undefined;
    if (mainElectron?.powerMonitor && typeof mainElectron.powerMonitor.getSystemIdleTime === 'function') {
      return mainElectron.powerMonitor;
    }
  } catch {
    // Fall through to the explicit degraded monitor below.
  }
  return undefined;
}

/**
 * Electron 桌面活动适配器；仅由 Windows Desktop 插件入口创建。
 * Electron desktop activity adapter; created only by the Windows Desktop plugin entry point.
 */
export function createDesktopActivityMonitor(): SystemActivityMonitor {
  const monitor = resolvePowerMonitor();
  if (!monitor) {
    return {
      available: false,
      getSystemIdleSeconds: () => 0,
      onScreenLock: () => () => undefined,
    };
  }
  return {
    available: true,
    getSystemIdleSeconds: () => monitor.getSystemIdleTime(),
    onScreenLock: (listener) => {
      monitor.on('lock-screen', listener);
      return () => monitor.removeListener('lock-screen', listener);
    },
  };
}
