import { access } from 'node:fs/promises';
import { BridgeError, MountError, UnownedMountError } from './errors';
import { checkPrerequisites } from './prerequisites';
import type { PrerequisiteResult } from './prerequisites';
import { CliSupervisor } from './cliSupervisor';
import { VaultLauncher } from './vaultLauncher';
import { BridgeStateMachine } from './stateMachine';
import type { BridgeSettings, BridgeRuntimeState } from './types';

/** 控制器依赖注入项。 / Dependency injection options for the controller. */
export interface ControllerOptions {
  getSettings: () => BridgeSettings;
  getCurrentVaultPath: () => string | undefined;
  supervisor?: SupervisorPort;
  launcher?: VaultLauncher;
  prerequisiteChecker?: (
    settings: BridgeSettings,
    currentObsidianVaultPath?: string,
  ) => Promise<PrerequisiteResult>;
}

interface SupervisorPort {
  readonly ownsProcess: boolean;
  unlock(settings: BridgeSettings, password: string): Promise<unknown>;
  stop(mountPath: string): Promise<unknown>;
  cleanup(mountPath: string): Promise<void>;
}

/**
 * 编排设置、状态机、前置检查、CLI 监督器和 Vault 启动器。
 * Orchestrates settings, state machine, prerequisite checks, CLI supervision, and vault launching.
 */
export class BridgeController {
  readonly stateMachine = new BridgeStateMachine();
  readonly supervisor: SupervisorPort;
  readonly launcher: VaultLauncher;
  private readonly options: ControllerOptions;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.supervisor = options.supervisor ?? new CliSupervisor({ onUnexpectedExit: () => this.handleUnexpectedExit() });
    this.launcher = options.launcher ?? new VaultLauncher();
  }

  get state(): BridgeRuntimeState {
    return this.stateMachine.state;
  }

  async reconcile(): Promise<void> {
    if (this.state.state === 'error') {
      this.stateMachine.transition({ type: 'RECONCILE' });
    }
    const settings = this.options.getSettings();
    if (await this.mountIsAccessible(settings.mountPath)) {
      const error = new UnownedMountError();
      this.stateMachine.transition({ type: 'FAILED', message: error.message });
      throw error;
    }
    this.stateMachine.transition({ type: 'PREREQUISITES_OK' });
  }

  async unlock(password: string, confirmWarnings: (warnings: string[]) => Promise<boolean>): Promise<void> {
    if (this.state.state !== 'idle') {
      throw new MountError('当前状态不允许开始解锁。');
    }

    const settings = this.options.getSettings();
    this.stateMachine.transition({ type: 'MOUNT_REQUESTED' });
    try {
      const prerequisiteChecker = this.options.prerequisiteChecker ?? checkPrerequisites;
      const prerequisites = await prerequisiteChecker(settings, this.options.getCurrentVaultPath());
      if (prerequisites.warnings.length > 0 && !(await confirmWarnings(prerequisites.warnings))) {
        throw new MountError('用户取消了同步目录风险确认。');
      }
      this.stateMachine.transition({ type: 'PREREQUISITES_OK' });
      await this.supervisor.unlock({ ...settings, ...prerequisites.normalizedSettings }, password);
      this.stateMachine.transition({ type: 'MOUNT_READY' });
      this.launcher.open(settings.privateVaultName);
    } catch (error) {
      const currentState = this.stateMachine.state.state;
      if (currentState !== 'error') {
        const message = error instanceof BridgeError ? error.message : '解锁失败，请检查依赖和路径配置。';
        this.stateMachine.transition({ type: 'FAILED', message });
      }
      throw error;
    }
  }

  async lock(): Promise<void> {
    if (this.state.state !== 'mounted') {
      throw new MountError('当前没有已挂载的私密 Vault。');
    }

    const settings = this.options.getSettings();
    this.stateMachine.transition({ type: 'UNMOUNT_REQUESTED' });
    try {
      await this.supervisor.stop(settings.mountPath);
      this.stateMachine.transition({ type: 'UNMOUNTED' });
    } catch (error) {
      const message = error instanceof BridgeError ? error.message : '锁定失败，请关闭私密 Vault 中的文件后重试。';
      this.stateMachine.transition({ type: 'FAILED', message });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.supervisor.ownsProcess) {
      return;
    }
    const settings = this.options.getSettings();
    try {
      await this.supervisor.cleanup(settings.mountPath);
      if (this.state.state === 'mounted' || this.state.state === 'unmounting') {
        this.stateMachine.transition({ type: 'UNMOUNTED' });
      }
    } catch (error) {
      if (this.state.state !== 'error') {
        this.stateMachine.transition({ type: 'FAILED', message: '插件退出时无法确认挂载已安全卸载。' });
      }
    }
  }

  private async mountIsAccessible(mountPath: string): Promise<boolean> {
    try {
      await access(mountPath);
      return true;
    } catch {
      return false;
    }
  }

  private handleUnexpectedExit(): void {
    if (this.state.state === 'mounted' || this.state.state === 'mounting') {
      this.stateMachine.transition({ type: 'FAILED', message: 'Cryptomator CLI 意外退出，请检查挂载状态并人工恢复。' });
    }
  }
}
