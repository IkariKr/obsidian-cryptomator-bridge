import { Plugin, PluginSettingTab, Setting, Notice, App, TFolder } from 'obsidian';
import { DEFAULT_SETTINGS, loadSettings } from './settings';
import { BridgeController } from './controller';
import { requestConfirmation, requestPassword } from './modals';
import type { BridgeSettings } from './types';

/**
 * Obsidian desktop 插件入口；不持久化密码。
 * Obsidian desktop plugin entry point; never persists passwords.
 */
export default class CryptomatorBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  controller!: BridgeController;
  private ribbonEl?: HTMLElement;
  private statusBarEl?: HTMLElement;

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.controller = new BridgeController({
      getSettings: () => this.settings,
      getCurrentVaultPath: () => this.getCurrentVaultPath(),
    });
    this.addSettingTab(new BridgeSettingTab(this.app, this));
    this.addCommand({
      id: 'unlock-private-vault',
      name: '解锁私密 Vault',
      callback: () => void this.unlockPrivateVault(),
    });
    this.addCommand({
      id: 'lock-private-vault',
      name: '锁定私密 Vault',
      callback: () => void this.lockPrivateVault(),
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFolder)) {
        return;
      }
      const state = this.controller.state.state;
      const mounted = state === 'mounted';
      const ready = state === 'idle' || mounted;
      menu.addItem((item) => {
        item
          .setTitle(mounted ? '锁定私密 Vault' : '解锁私密 Vault')
          .setIcon(mounted ? 'lock' : 'unlock')
          .setDisabled(!ready)
          .onClick(() => void this.togglePrivateVault());
      });
    }));
    this.ribbonEl = this.addRibbonIcon('lock', 'Cryptomator Bridge：解锁/锁定私密 Vault', () => {
      void this.togglePrivateVault();
    });
    this.statusBarEl = this.addStatusBarItem();
    this.updateUiState();
    void this.controller.reconcile()
      .catch((error) => this.showError(error))
      .finally(() => this.updateUiState());
  }

  onunload(): void {
    void this.controller?.cleanup();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 打开一次性密码输入并执行解锁流程。
   * Open the one-shot password prompt and execute the unlock flow.
   */
  async unlockPrivateVault(): Promise<void> {
    const password = await requestPassword(this.app);
    if (password === null) {
      return;
    }

    try {
      await this.controller.unlock(
        password,
        async (warnings) => requestConfirmation(this.app, '确认挂载位置', warnings.join('\n')),
      );
      new Notice('私密 Vault 已挂载，正在打开独立窗口。');
    } catch (error) {
      this.showError(error);
    } finally {
      this.updateUiState();
    }
  }

  /**
   * 请求用户关闭私密文件后执行安全锁定。
   * Lock the private vault after the user closes private files.
   */
  async lockPrivateVault(): Promise<void> {
    const confirmed = await requestConfirmation(
      this.app,
      '锁定私密 Vault',
      '请先关闭私密 Vault 中打开的文件和窗口，然后继续锁定。',
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.controller.lock();
      new Notice('私密 Vault 已安全锁定。');
    } catch (error) {
      this.showError(error);
    } finally {
      this.updateUiState();
    }
  }

  private async togglePrivateVault(): Promise<void> {
    if (this.controller.state.state === 'mounted') {
      await this.lockPrivateVault();
      return;
    }
    if (this.controller.state.state === 'idle') {
      await this.unlockPrivateVault();
      return;
    }
    new Notice('插件正在检查状态或上一次操作失败，请稍后重试或打开设置查看。');
  }

  private updateUiState(): void {
    const state = this.controller?.state.state ?? 'reconciling';
    const labels: Record<string, string> = {
      reconciling: '检查中',
      idle: '已锁定',
      checking: '检查依赖中',
      mounting: '解锁中',
      mounted: '已解锁',
      unmounting: '锁定中',
      error: '需要处理',
    };
    const label = labels[state] ?? state;
    this.statusBarEl?.setText(`Cryptomator Bridge：${label}`);
    const ribbonTitle = state === 'mounted'
      ? 'Cryptomator Bridge：锁定私密 Vault'
      : 'Cryptomator Bridge：解锁私密 Vault';
    this.ribbonEl?.setAttribute('aria-label', ribbonTitle);
    this.ribbonEl?.setAttribute('title', ribbonTitle);
  }

  private showError(error: unknown): void {
    new Notice(error instanceof Error ? error.message : '操作失败，请检查设置和依赖。');
  }

  private getCurrentVaultPath(): string | undefined {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return adapter.getBasePath?.();
  }
}

class BridgeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CryptomatorBridgePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Cryptomator Bridge' });
    containerEl.createEl('p', {
      text: '密码只在解锁操作期间输入，不会保存到插件设置。',
    });

    new Setting(containerEl)
      .setName('操作')
      .addButton((button) => button.setButtonText('解锁').setCta().onClick(() => void this.plugin.unlockPrivateVault()))
      .addButton((button) => button.setButtonText('锁定').onClick(() => void this.plugin.lockPrivateVault()));

    this.addPathSetting('Cryptomator CLI 路径', 'cliPath');
    this.addPathSetting('加密 Vault 路径', 'encryptedVaultPath');
    this.addPathSetting('挂载路径', 'mountPath');
    this.addTextSetting('挂载器 ID', 'mounterId');
    this.addTextSetting('私密 Vault 名称', 'privateVaultName');
  }

  private addPathSetting(name: string, key: 'cliPath' | 'encryptedVaultPath' | 'mountPath'): void {
    new Setting(this.containerEl)
      .setName(name)
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }

  private addTextSetting(name: string, key: 'mounterId' | 'privateVaultName'): void {
    new Setting(this.containerEl)
      .setName(name)
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }
}
