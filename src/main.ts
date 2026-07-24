import { Plugin, PluginSettingTab, Setting, Notice, App, FileSystemAdapter, TFolder } from 'obsidian';
import { applyStaticDefaults, DEFAULT_SETTINGS, loadSettings, validateSettings } from './settings';
import { BridgeController } from './controller';
import { requestConfirmation, requestPassword, requestVaultSetup, type SetupDraft } from './modals';
import type { BridgeSettings } from './types';
import { AutoLockManager, type AutoLockReason } from './autoLock';
import { createDesktopActivityMonitor } from './desktopActivityMonitor';
import { migrateFolderContents, removeMigratedSource } from './migration';
import { MigrationError } from './errors';
import path from 'node:path';
import { discoverWinFspMounterId } from './prerequisites';

/**
 * Obsidian desktop 插件入口；不持久化密码。
 * Obsidian desktop plugin entry point; never persists passwords.
 */
export default class CryptomatorBridgePlugin extends Plugin {
  settings: BridgeSettings = { ...DEFAULT_SETTINGS };
  controller!: BridgeController;
  private ribbonEl?: HTMLElement;
  private statusBarEl?: HTMLElement;
  private autoLock?: AutoLockManager;

  async onload(): Promise<void> {
    const loadedSettings = loadSettings(await this.loadData());
    this.settings = await this.applyAutomaticDefaults(loadedSettings);
    if (JSON.stringify(this.settings) !== JSON.stringify(loadedSettings)) {
      await this.saveData(this.settings);
    }
    this.controller = new BridgeController({
      getSettings: () => this.settings,
      getCurrentVaultPath: () => this.getCurrentVaultPath(),
    });
    const activityMonitor = createDesktopActivityMonitor();
    this.autoLock = new AutoLockManager({
      monitor: activityMonitor,
      isMounted: () => this.controller.state.state === 'mounted',
      lock: async (reason) => this.lockPrivateVault(false, reason),
      onError: (error, reason) => this.showAutoLockError(error, reason),
    });
    this.autoLock.start(this.settings.autoLock);
    if (activityMonitor.available === false && (this.settings.autoLock.idleLockMinutes > 0 || this.settings.autoLock.lockOnScreenLock)) {
      new Notice('当前 Obsidian 环境无法提供系统空闲/锁屏事件，自动锁定暂不可用；手动锁定仍可使用。');
    }
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
      const configured = validateSettings(this.settings).valid;
      const ready = (state === 'idle' && configured) || mounted;
      menu.addItem((item) => {
        item
          .setTitle(mounted ? '锁定私密笔记库' : configured ? '解锁私密笔记库' : '配置私密笔记库')
          .setIcon(mounted ? 'lock' : configured ? 'unlock' : 'settings')
          .setDisabled(!ready)
          .onClick(() => configured ? void this.togglePrivateVault() : void this.openSetup(file));
      });
      if (configured) {
        menu.addItem((item) => item
          .setTitle('迁移此文件夹到私密笔记库')
          .setIcon('shield')
          .setDisabled(!ready)
          .onClick(() => void this.migrateFolder(file)));
      }
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
    this.autoLock?.stop();
    void this.controller?.cleanup();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.autoLock?.update(this.settings.autoLock);
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
  async lockPrivateVault(interactive = true, reason?: AutoLockReason): Promise<void> {
    if (interactive) {
      const confirmed = await requestConfirmation(
        this.app,
        '锁定私密笔记库',
        '请先关闭私密 Vault 中打开的文件和窗口，然后继续锁定。',
      );
      if (!confirmed) {
        return;
      }
    }
    try {
      await this.controller.lock();
      new Notice(reason ? '私密笔记库已自动锁定。' : '私密笔记库已安全锁定。');
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

  private async migrateFolder(folder: TFolder): Promise<void> {
    if (folder.path.length === 0) {
      new Notice('不能迁移当前控制 Vault 根目录；请选择一个具体文件夹。');
      return;
    }
    if (!validateSettings(this.settings).valid) {
      await this.openSetup(folder);
      return;
    }
    if (this.controller.state.state !== 'mounted') {
      if (this.controller.state.state !== 'idle') {
        new Notice('插件当前不可执行迁移，请等待状态检查完成。');
        return;
      }
      const password = await requestPassword(this.app);
      if (password === null) {
        return;
      }
      try {
        await this.controller.unlock(
          password,
          async (warnings) => requestConfirmation(this.app, '确认挂载位置', warnings.join('\n')),
        );
      } catch (error) {
        this.showError(error);
        this.updateUiState();
        return;
      }
    }

    const controlVaultPath = this.getCurrentVaultPath();
    if (!controlVaultPath) {
      this.showError(new MigrationError('无法取得当前控制 Vault 的本机路径。'));
      return;
    }
    const sourcePath = path.resolve(controlVaultPath, ...folder.path.split('/'));
    try {
      const result = await migrateFolderContents(sourcePath, this.settings.mountPath);
      const deleteSource = await requestConfirmation(
        this.app,
        '删除原明文文件夹？',
        `已复制并校验 ${result.files} 个文件。默认保留原文件夹；只有确认删除后，原明文副本才会被移除。此操作不可撤销。`,
      );
      if (deleteSource) {
        await removeMigratedSource(sourcePath, controlVaultPath, this.settings.mountPath);
      }
      new Notice(deleteSource
        ? '文件夹已迁移并删除原明文副本。'
        : '文件夹已复制，但原明文仍在 Nutstore 控制 Vault 中；请勿将其视为已完成加密。');
    } catch (error) {
      this.showError(error);
    } finally {
      this.updateUiState();
    }
  }

  private async openSetup(folder?: TFolder): Promise<void> {
    const initialSettings = await this.applyAutomaticDefaults(this.settings);
    this.settings = initialSettings;
    const initial: SetupDraft = {
      cliPath: initialSettings.cliPath,
      syncRootPath: initialSettings.syncRootPath,
      encryptedVaultRelativePath: initialSettings.encryptedVaultRelativePath,
      mountPath: initialSettings.mountPath,
      mounterId: initialSettings.mounterId,
      privateVaultName: initialSettings.privateVaultName,
    };
    const draft = await requestVaultSetup(this.app, initial, folder?.path);
    if (!draft) {
      return;
    }
    const candidate = await this.applyAutomaticDefaults({ ...this.settings, ...draft });
    const validation = validateSettings(candidate);
    if (!validation.valid) {
      new Notice(`配置不完整：${validation.errors.join(' ')}`);
      return;
    }
    this.settings = validation.settings;
    await this.saveSettings();
    new Notice('配置已保存；正在检查 Vault 并继续。');
    if (folder) {
      await this.migrateFolder(folder);
    }
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

  private showAutoLockError(error: unknown, reason: AutoLockReason): void {
    const cause = error instanceof Error ? error.message : '未知错误';
    const label = reason === 'screen-lock' ? '锁屏' : '空闲超时';
    new Notice(`${label}自动锁定失败：${cause}`);
  }

  private getCurrentVaultPath(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }

  private async applyAutomaticDefaults(settings: BridgeSettings): Promise<BridgeSettings> {
    const withStaticDefaults = applyStaticDefaults(settings, this.getCurrentVaultPath());
    if (withStaticDefaults.mounterId || !withStaticDefaults.cliPath) {
      return withStaticDefaults;
    }
    const mounterId = await discoverWinFspMounterId(withStaticDefaults.cliPath);
    return mounterId ? { ...withStaticDefaults, mounterId } : withStaticDefaults;
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
    this.addPathSetting('同步根目录', 'syncRootPath');
    this.addTextSetting('密文 Vault 相对路径', 'encryptedVaultRelativePath', '相对于同步根目录，例如 PrivateNotes.cryptomator。');
    this.addPathSetting('挂载路径', 'mountPath');
    this.addTextSetting('挂载器 ID', 'mounterId');
    this.addTextSetting('私密 Vault 名称', 'privateVaultName');
    this.addAutoLockSettings();
  }

  private addPathSetting(name: string, key: 'cliPath' | 'syncRootPath' | 'mountPath'): void {
    new Setting(this.containerEl)
      .setName(name)
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }

  private addTextSetting(
    name: string,
    key: 'encryptedVaultRelativePath' | 'mounterId' | 'privateVaultName',
    description?: string,
  ): void {
    const setting = new Setting(this.containerEl).setName(name);
    if (description) {
      setting.setDesc(description);
    }
    setting
      .addText((text) =>
        text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }

  private addAutoLockSettings(): void {
    new Setting(this.containerEl)
      .setName('空闲自动锁定（分钟）')
      .setDesc('设为 0 可关闭空闲自动锁定；锁定仅卸载明文挂载点，不会再次加密。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.setValue(String(this.plugin.settings.autoLock.idleLockMinutes));
        text.onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
            new Notice('空闲自动锁定必须是 0 到 1440 的整数分钟。');
            return;
          }
          this.plugin.settings.autoLock = { ...this.plugin.settings.autoLock, idleLockMinutes: minutes };
          await this.plugin.saveSettings();
        });
      });

    new Setting(this.containerEl)
      .setName('Windows 锁屏时自动锁定')
      .setDesc('锁屏时立即尝试安全卸载；若文件仍被占用，会在返回后提示恢复处理。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoLock.lockOnScreenLock)
        .onChange(async (value) => {
          this.plugin.settings.autoLock = { ...this.plugin.settings.autoLock, lockOnScreenLock: value };
          await this.plugin.saveSettings();
        }));
  }

}
