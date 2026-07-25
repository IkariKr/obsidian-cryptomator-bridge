/**
 * Cryptomator Bridge 插件主入口。
 * - 同 Vault 同级布局：<folder>.cryptomator（密文）+ <folder>.cryptomator-mount（明文挂载）。
 * - 多文件夹级 Vault 记录列表；右键菜单按文件夹定位记录。
 * - Nutstore 排除门禁：解锁前必须确认排除规则已配置。
 *
 * Cryptomator Bridge plugin main entry point.
 * - Same-vault sibling layout: <folder>.cryptomator (ciphertext) + <folder>.cryptomator-mount (plaintext mount).
 * - Multi-folder vault record list; context menu matches records by folder.
 * - Nutstore exclusion gating: unlock blocked until Nutstore exclusion confirmed.
 */
import { join } from 'node:path';
import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type { BridgeSettings, VaultRecord } from './types';
import {
  loadSettings,
  migrateSettings,
  applyCurrentVaultDefaults,
  applyAutoDetectedDefaults,
  resolveVaultRecords,
  ENCRYPTED_VAULT_SUFFIX,
  MOUNT_SUFFIX,
} from './settings';
import { BridgeController } from './controller';
import { discoverMounters } from './prerequisites';
import { migrateFolderContents, removeMigratedSource } from './migration';
import { AutoLockManager } from './autoLock';
import { createDesktopActivityMonitor } from './desktopActivityMonitor';
import {
  VaultSetupModal,
  PasswordModal,
  ConfirmModal,
  NutstoreExclusionModal,
} from './modals';

export default class CryptomatorBridgePlugin extends Plugin {
  // 覆盖基类可选的 settings 声明为本插件的具体类型。 / Narrow the base optional settings declaration to this plugin's concrete type.
  declare settings: BridgeSettings;
  controller!: BridgeController;
  private autoLockManager?: AutoLockManager;
  private statusBarEl!: HTMLElement;
  private ribbonIconEl?: HTMLElement;

  async onload(): Promise<void> {
    // 1. 加载并迁移设置
    const raw = await this.loadData();
    const migrated = migrateSettings(raw);
    let settings = applyCurrentVaultDefaults(
      loadSettings(migrated),
      this.getVaultBasePath(),
    );

    // 1b. 自动检测 CLI 路径和挂载器 ID（仅当为空时）
    settings = await applyAutoDetectedDefaults(settings);
    this.settings = settings;

    // 2. 创建控制器
    this.controller = new BridgeController(this.settings, this.getVaultBasePath());
    this.controller.onStateChanged((aggregate) => {
      this.updateUiState(aggregate);
    });

    // 3. 自动锁定
    this.setupAutoLock();

    // 4. 注册命令（全局锁定所有 Vault）
    this.addCommand({
      id: 'lock-all-vaults',
      name: '锁定全部私密笔记库',
      callback: () => this.lockAll(),
    });

    // 5. 右键菜单（按文件夹定位记录）
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder) || file.isRoot()) {
          return;
        }
        this.addFolderMenuItems(menu, file);
      }),
    );

    // 6. 设置页
    this.addSettingTab(new BridgeSettingTab(this.app, this));

    // 7. 功能区图标
    this.ribbonIconEl = this.addRibbonIcon('lock', 'Cryptomator Bridge', () => {
      // 点击图标：锁定全部（如果有已挂载），否则显示状态
      if (this.controller.isAnyMounted()) {
        this.lockAll();
      }
    });

    // 8. 状态栏
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('cryptomator-bridge-status');
    this.updateUiState({ overallState: 'idle', sessions: [] });

    // 9. 复核现有挂载
    const resolved = resolveVaultRecords(this.settings);
    await this.controller.reconcile(resolved);
  }

  async onunload(): Promise<void> {
    await this.controller.cleanup();
    this.autoLockManager?.stop();
  }

  /**
   * 通过受支持的 FileSystemAdapter 获取控制 Vault 的绝对路径；非桌面适配器返回 undefined。
   * Get the control Vault absolute path via the supported FileSystemAdapter; returns undefined on non-desktop adapters.
   */
  private getVaultBasePath(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }

  // ──────────── 右键菜单 ────────────

  private addFolderMenuItems(menu: import('obsidian').Menu, folder: TFolder): void {
    const folderName = folder.name;
    if (folderName.endsWith(ENCRYPTED_VAULT_SUFFIX) || folderName.endsWith(MOUNT_SUFFIX)) {
      return;
    }
    const record = this.settings.vaultRecords.find((r) => r.folderName === folderName);
    const session = record ? this.controller.getSession(record.id) : undefined;
    const isMounted = session?.stateMachine.state.state === 'mounted';

    if (!record) {
      // 未配置：提供配置入口
      menu.addItem((item) => {
        item
          .setTitle('配置为私密笔记库')
          .setIcon('lock')
          .onClick(() => void this.configureAndUnlockVault(folderName));
      });
    } else if (isMounted) {
      // 已挂载：提供锁定入口
      menu.addItem((item) => {
        item
          .setTitle('锁定私密笔记库')
          .setIcon('unlock')
          .onClick(() => this.lockVault(record.id, folderName));
      });
    } else {
      // 已配置但锁定：提供解锁和移除配置入口
      menu.addItem((item) => {
        item
          .setTitle('解锁私密笔记库')
          .setIcon('lock')
          .onClick(() => this.unlockVault(record, folderName));
      });
      menu.addItem((item) => {
        item
          .setTitle('移除私密笔记库配置')
          .setIcon('trash')
          .onClick(() => this.removeVaultRecord(record.id, folderName));
      });
    }

    // 始终提供迁移入口
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle('迁移到私密笔记库')
        .setIcon('folder-input')
        .onClick(() => void this.migrateFolderToVault(folder));
    });
  }

  // ──────────── 配置 / 解锁 / 锁定 / 迁移 ────────────

  private async configureAndUnlockVault(folderName: string): Promise<void> {
    try {
      const record = await this.configureVault(folderName);
      if (!record) {
        return;
      }
      // 配置完成后立即进入解锁，避免用户保存配置后不知道下一步操作。
      // Continue to unlock immediately after setup so the next action is explicit to the user.
      await this.unlockVault(record, folderName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      new Notice(`配置失败：${err.message}`);
    }
  }

  private async configureVault(folderName: string): Promise<VaultRecord | undefined> {
    const result = await new VaultSetupModal(this.app, folderName).open();
    if (!result) {
      return undefined;
    }

    // 添加新记录
    const newRecord: VaultRecord = {
      id: crypto.randomUUID?.() ?? `${folderName}-${Date.now().toString(36)}`,
      folderName: result.folderName,
      nutstoreExclusionConfirmed: result.nutstoreExclusionConfirmed,
    };

    this.settings.vaultRecords.push(newRecord);
    try {
      await this.saveSettings();
    } catch (error) {
      this.settings.vaultRecords = this.settings.vaultRecords.filter((record) => record.id !== newRecord.id);
      throw error;
    }
    new Notice(`已配置私密笔记库：${folderName}`);
    return newRecord;
  }

  private async unlockVault(record: VaultRecord, folderName: string): Promise<void> {
    // 门禁：Nutstore 排除确认
    if (!record.nutstoreExclusionConfirmed) {
      const confirmed = await new NutstoreExclusionModal(this.app, folderName).open();
      if (!confirmed) {
        return;
      }
      // 持久化确认
      record.nutstoreExclusionConfirmed = true;
      await this.saveSettings();
    }

    // 密码输入
    let password = await new PasswordModal(this.app, folderName).open();
    if (!password) {
      return;
    }

    try {
      // 解析记录路径
      const resolved = resolveVaultRecords(this.settings);
      const resolvedRecord = resolved.find((r) => r.id === record.id);
      if (!resolvedRecord) {
        new Notice(`找不到记录配置：${folderName}`);
        return;
      }

      const result = await this.controller.unlock(resolvedRecord, password);
      if (result.success) {
        // 明文挂载目录由 Obsidian 的文件系统监视自动发现，无需手动刷新文件树。
        // The plaintext mount directory is auto-discovered by Obsidian's file watcher; no manual refresh needed.
        new Notice(`${folderName} 已解锁，明文目录 ${folderName}.cryptomator-mount 将出现在文件树中。`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      new Notice(`解锁失败：${err.message}`);
    } finally {
      password = '';
    }
  }

  private async lockVault(recordId: string, folderName: string): Promise<void> {
    const confirmed = await new ConfirmModal(
      this.app,
      '锁定私密笔记库',
      `确定要锁定「${folderName}」吗？\n锁定后明文挂载目录将消失，文件安全保留在密文目录中。`,
      '锁定',
    ).open();

    if (!confirmed) {
      return;
    }

    try {
      await this.controller.lock(recordId);
      new Notice(`${folderName} 已锁定`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      new Notice(`锁定失败：${err.message}`);
    }
  }

  private async lockAll(): Promise<void> {
    const count = this.controller.getMountedCount();
    if (count === 0) {
      new Notice('当前没有已解锁的私密笔记库。');
      return;
    }

    const confirmed = await new ConfirmModal(
      this.app,
      '锁定全部私密笔记库',
      `确定要锁定全部 ${count} 个已解锁的私密笔记库吗？`,
      '锁定全部',
    ).open();

    if (!confirmed) {
      return;
    }

    try {
      await this.controller.lockAll();
      new Notice('全部私密笔记库已锁定。');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      new Notice(`锁定失败：${err.message}`);
    }
  }

  private async removeVaultRecord(recordId: string, folderName: string): Promise<void> {
    const confirmed = await new ConfirmModal(
      this.app,
      '移除私密笔记库配置',
      `确定要移除「${folderName}」的配置吗？\n此操作仅移除插件记录，不会删除密文目录或挂载目录。`,
      '移除',
    ).open();

    if (!confirmed) {
      return;
    }

    this.settings.vaultRecords = this.settings.vaultRecords.filter((r) => r.id !== recordId);
    await this.saveSettings();
    new Notice(`已移除私密笔记库配置：${folderName}`);
  }

  private async migrateFolderToVault(folder: TFolder): Promise<void> {
    if (folder.isRoot()) {
      new Notice('不能迁移当前控制 Vault 根目录；请选择一个具体文件夹。');
      return;
    }
    if (folder.name.endsWith(ENCRYPTED_VAULT_SUFFIX) || folder.name.endsWith(MOUNT_SUFFIX)) {
      new Notice('Cryptomator 密文目录或明文挂载目录不能作为迁移源。');
      return;
    }

    // 迁移入口也负责引导首次配置，避免用户先看到一个无法执行的确认框。
    // The migration entry also guides first-time setup, avoiding a confirmation dialog for an unavailable action.
    let record = this.settings.vaultRecords.find((r) => r.folderName === folder.name);
    if (!record) {
      try {
        record = await this.configureVault(folder.name);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        new Notice(`迁移准备失败：${err.message}`);
        return;
      }
      if (!record) {
        return;
      }
    }

    // 未挂载时直接进入解锁流程；密码仍只在本次操作中通过 CLI stdin 使用。
    // If it is not mounted, enter the unlock flow; the password remains one-use CLI stdin input.
    let session = this.controller.getSession(record.id);
    if (!session || session.stateMachine.state.state !== 'mounted') {
      try {
        await this.unlockVault(record, folder.name);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        new Notice(`迁移准备失败：${err.message}`);
        return;
      }
      session = this.controller.getSession(record.id);
      if (!session || session.stateMachine.state.state !== 'mounted') {
        new Notice(`「${folder.name}」尚未解锁，迁移已取消。`);
        return;
      }
    }

    const confirmed = await new ConfirmModal(
      this.app,
      '迁移到私密笔记库',
      `此操作将把「${folder.name}」的内容复制到对应的私密笔记库挂载目录中。\n复制完成后会逐文件校验，您需要确认后才能删除原始明文文件夹。`,
      '开始迁移',
    ).open();

    if (!confirmed) {
      return;
    }

    const resolved = resolveVaultRecords(this.settings);
    const resolvedRecord = resolved.find((r) => r.id === record.id);
    if (!resolvedRecord) {
      new Notice('找不到记录配置。');
      return;
    }

    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) {
      new Notice('无法获取 Vault 路径。');
      return;
    }

    // folder.path 为 Vault 相对路径，需解析为绝对路径供文件系统操作使用。
    // folder.path is vault-relative; resolve it to an absolute path for filesystem operations.
    const absoluteSourcePath = join(vaultPath, folder.path);

    try {
      const report = await migrateFolderContents(
        absoluteSourcePath,
        resolvedRecord.mountPath,
      );

      new Notice(`迁移报告：${report.files} 个文件已复制。`);

      // 询问是否删除源
      if (report.files > 0) {
        const deleteConfirm = await new ConfirmModal(
          this.app,
          '删除原始文件',
          `所有 ${report.files} 个文件已验证并复制到加密挂载目录。\n是否删除原始明文文件夹「${folder.name}」？\n⚠ 删除不可撤销。`,
          '删除明文文件夹',
        ).open();

        if (deleteConfirm) {
          await removeMigratedSource(absoluteSourcePath, vaultPath, resolvedRecord.mountPath);
          new Notice(`已删除源文件夹「${folder.name}」。`);
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      new Notice(`迁移失败：${err.message}`);
    }
  }

  // ──────────── 自动锁定 ────────────

  private setupAutoLock(): void {
    const monitor = createDesktopActivityMonitor();
    if (
      monitor.available === false &&
      (this.settings.autoLock.idleLockMinutes > 0 || this.settings.autoLock.lockOnScreenLock)
    ) {
      new Notice('当前桌面环境无法提供空闲/锁屏事件，自动锁定暂不可用；手动锁定仍可使用。');
    }
    this.autoLockManager = new AutoLockManager({
      monitor,
      isMounted: () => this.controller.isAnyMounted(),
      lock: async () => {
        await this.controller.lockAll();
        new Notice('私密笔记库已自动锁定。');
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`自动锁定失败：${message}`);
      },
    });
    this.autoLockManager.start(this.settings.autoLock);
  }

  // ──────────── 状态栏 ────────────

  private updateUiState(aggregate: {
    overallState: string;
    sessions: Array<{ folderName: string; state: string; errorMessage?: string }>;
    errorMessage?: string;
  }): void {
    const mounted = aggregate.sessions.filter((s) => s.state === 'mounted');
    const total = this.settings.vaultRecords.length;

    if (aggregate.overallState === 'error') {
      this.statusBarEl.setText(`🔴 ${aggregate.errorMessage ?? '错误'}`);
    } else if (mounted.length > 0) {
      this.statusBarEl.setText(`🟢 已解锁 ${mounted.length}/${total}`);
    } else if (total > 0) {
      this.statusBarEl.setText(`🔒 ${total} 个私密笔记库已锁定`);
    } else {
      this.statusBarEl.setText('🔒 未配置私密笔记库');
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.controller.updateSettings(this.settings);
    // 同步自动锁定策略变更（空闲分钟/锁屏开关）。 / Propagate auto-lock policy changes (idle minutes / screen-lock toggle).
    this.autoLockManager?.update(this.settings.autoLock);
  }
}

// ──────────── 设置页 ────────────

class BridgeSettingTab extends PluginSettingTab {
  private plugin: CryptomatorBridgePlugin;

  constructor(app: import('obsidian').App, plugin: CryptomatorBridgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    containerEl.createEl('h2', { text: 'Cryptomator Bridge 设置' });

    // ── 常规设置 ──
    containerEl.createEl('h3', { text: '常规' });

    new Setting(containerEl)
      .setName('Cryptomator CLI 路径')
      .setDesc('CryptomatorCLI.exe 的完整路径（通常位于 Cryptomator 安装目录）。')
      .addText((text) =>
        text
          .setPlaceholder('C:\\Program Files\\Cryptomator\\CryptomatorCLI.exe')
          .setValue(settings.cliPath)
          .onChange(async (value) => {
            settings.cliPath = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('发现挂载器').onClick(async () => {
          if (!settings.cliPath) {
            new Notice('请先填写 CLI 路径。');
            return;
          }
          try {
            const mounters = await discoverMounters(settings.cliPath);
            if (mounters.length > 0) {
              settings.mounterId = mounters[0];
              await this.plugin.saveSettings();
              this.display();
              new Notice(`已发现挂载器：${mounters[0]}`);
            } else {
              new Notice('未发现可用的挂载器，请确认 WinFsp 已安装。');
            }
          } catch (error) {
            new Notice('挂载器发现失败，请检查 CLI 路径。');
          }
        }),
      );

    new Setting(containerEl)
      .setName('同步根路径')
      .setDesc('控制 Vault 路径（即当前 Obsidian Vault），默认自动填充。')
      .addText((text) =>
        text
          .setPlaceholder('/path/to/control-vault')
          .setValue(settings.syncRootPath)
          .onChange(async (value) => {
            settings.syncRootPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('挂载器 ID')
      .setDesc('Cryptomator 挂载方式：WinFsp（Windows 推荐）、WebDAV 等。')
      .addText((text) =>
        text
          .setPlaceholder('org.cryptomator.frontend.webdav.mount.WebDavMounter')
          .setValue(settings.mounterId)
          .onChange(async (value) => {
            settings.mounterId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── 自动锁定 ──
    containerEl.createEl('h3', { text: '自动锁定' });

    new Setting(containerEl)
      .setName('空闲锁定（分钟）')
      .setDesc('系统空闲 N 分钟后自动锁定所有私密笔记库；设为 0 关闭。')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.max = '1440';
        text.setValue(String(settings.autoLock.idleLockMinutes));
        text.onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            settings.autoLock.idleLockMinutes = parsed;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('锁屏时自动锁定')
      .setDesc('Windows 锁屏（Win+L）时自动锁定所有私密笔记库。')
      .addToggle((toggle) =>
        toggle.setValue(settings.autoLock.lockOnScreenLock).onChange(async (value) => {
          settings.autoLock.lockOnScreenLock = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── 私密笔记库记录列表 ──
    containerEl.createEl('h3', { text: '私密笔记库记录' });

    if (settings.vaultRecords.length === 0) {
      containerEl.createEl('p', {
        text: '暂无配置。右键点击控制 Vault 中的文件夹 → "配置为私密笔记库" 来添加。',
        cls: 'setting-item-description',
      });
    } else {
      for (const record of settings.vaultRecords) {
        const recordSetting = new Setting(containerEl)
          .setName(record.folderName)
          .setDesc(
            `密文目录：${record.folderName}.cryptomator | ` +
            `挂载目录：${record.folderName}.cryptomator-mount | ` +
            `Nutstore 排除：${record.nutstoreExclusionConfirmed ? '✅ 已确认' : '⚠ 未确认'}`,
          )
          .addButton((btn) =>
            btn
              .setButtonText('移除')
              .setWarning()
              .onClick(async () => {
                const confirmed = await new ConfirmModal(
                  this.app,
                  '移除记录',
                  `确定要移除「${record.folderName}」的配置吗？`,
                  '移除',
                ).open();
                if (confirmed) {
                  settings.vaultRecords = settings.vaultRecords.filter(
                    (r) => r.id !== record.id,
                  );
                  await this.plugin.saveSettings();
                  this.display();
                  new Notice(`已移除：${record.folderName}`);
                }
              }),
          );

        // 排除确认重置按钮
        if (record.nutstoreExclusionConfirmed) {
          recordSetting.addButton((btn) =>
            btn.setButtonText('重置排除确认').onClick(async () => {
              record.nutstoreExclusionConfirmed = false;
              await this.plugin.saveSettings();
              this.display();
              new Notice(`已重置排除确认：${record.folderName}`);
            }),
          );
        }
      }
    }
  }
}
