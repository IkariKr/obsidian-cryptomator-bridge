/**
 * 弹窗组件；仅从插件主模块实例化。
 * Modal components; instantiated only from the plugin main module.
 */
import { App, Modal, Setting } from 'obsidian';

/**
 * 配置新私密笔记库的向导弹窗。
 * - folderName 由所选文件夹预填，不可编辑。
 * - 强制收集 Nutstore 排除确认。
 * Wizard modal for configuring a new private vault.
 * - folderName is pre-filled from the selected folder and non-editable.
 * - Nutstore exclusion confirmation is mandatory.
 */
export class VaultSetupModal extends Modal {
  private folderName: string;
  private nutstoreExclusionConfirmed = false;
  private resolvePromise?: (result: VaultSetupResult | null) => void;

  constructor(app: App, folderName: string) {
    super(app);
    this.folderName = folderName;
  }

  open(): Promise<VaultSetupResult | null> {
    super.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '创建私密笔记库' });

    // folderName 展示（不可编辑）
    new Setting(contentEl)
      .setName('文件夹名称')
      .setDesc('加密文件夹名称，将用于派生 .cryptomator 和 .cryptomator-mount 目录。')
      .addText((text) => {
        text.setValue(this.folderName).setDisabled(true);
      });

    // Nutstore 排除确认
    new Setting(contentEl)
      .setName('Nutstore 排除规则确认')
      .setDesc(`请先在 Nutstore 客户端配置排除规则：${'**'}${'/*.cryptomator-mount'}，确保明文挂载不会被同步。`)
      .addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          this.nutstoreExclusionConfirmed = value;
        });
      });

    // 提示信息
    contentEl.createEl('p', {
      text: '插件将在当前控制 Vault 根目录内创建标准 Cryptomator Format 8 密文目录。创建后会显示一次恢复密钥，必须在确认保存后才能完成。',
      cls: 'setting-item-description',
    });

    // 按钮
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => {
          this.resolvePromise?.(null);
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('继续创建').setCta().onClick(() => {
          if (!this.nutstoreExclusionConfirmed) {
            contentEl.createEl('p', {
              text: '请先确认已在 Nutstore 中配置排除规则。',
              cls: 'mod-warning',
            });
            return;
          }
          this.resolvePromise?.({
            folderName: this.folderName,
            nutstoreExclusionConfirmed: this.nutstoreExclusionConfirmed,
          });
          this.close();
        }),
      );
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = undefined;
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}

export interface VaultSetupResult {
  folderName: string;
  nutstoreExclusionConfirmed: boolean;
}

/**
 * 密码输入弹窗；密码仅通过 CLI stdin 传递，不入日志。
 * Password input modal; password is only passed through CLI stdin, never logged.
 */
export class PasswordModal extends Modal {
  private password = '';
  private resolvePromise?: (password: string | null) => void;

  constructor(app: App, private readonly folderName: string) {
    super(app);
  }

  open(): Promise<string | null> {
    super.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `解锁 ${this.folderName}` });

    let passwordInput: HTMLInputElement;
    new Setting(contentEl)
      .setName('密码')
      .setDesc('密码仅用于本次解锁，不会存储或记录。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = '输入 Cryptomator 密码';
        text.onChange((value) => {
          this.password = value;
        });
        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });
        passwordInput = text.inputEl;
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => {
          this.resolvePromise?.(null);
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('解锁').setCta().onClick(() => {
          this.submit();
        }),
      );

    // 自动聚焦
    setTimeout(() => passwordInput?.focus(), 100);
  }

  private submit(): void {
    const pw = this.password;
    this.password = '';
    this.resolvePromise?.(pw || null);
    this.close();
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = undefined;
    }
    this.password = '';
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * 新 Vault 密码弹窗；两次输入只在当前创建流程内存在。
 * New-vault password dialog; both entries exist only during the current creation flow.
 */
export class NewVaultPasswordModal extends Modal {
  private password = '';
  private confirmation = '';
  private resolvePromise?: (result: string | null) => void;

  constructor(app: App, private readonly folderName: string) {
    super(app);
  }

  open(): Promise<string | null> {
    super.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `为 ${this.folderName} 设置新密码` });
    contentEl.createEl('p', { text: '密码至少 8 个字符，仅用于本次创建与紧接着的一次解锁，不会保存、记录或传入命令行。' });
    new Setting(contentEl).setName('新密码').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((value) => { this.password = value; });
    });
    new Setting(contentEl).setName('确认新密码').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((value) => { this.confirmation = value; });
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });
    });
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('取消').onClick(() => { this.resolvePromise?.(null); this.close(); }))
      .addButton((btn) => btn.setButtonText('创建').setCta().onClick(() => this.submit()));
  }

  private submit(): void {
    const password = this.password;
    const confirmation = this.confirmation;
    this.password = '';
    this.confirmation = '';
    if (!password || password !== confirmation) {
      this.contentEl.createEl('p', { text: '两次密码必须一致且不能为空。', cls: 'mod-warning' });
      return;
    }
    this.resolvePromise?.(password);
    this.close();
  }

  onClose(): void {
    this.resolvePromise?.(null);
    this.resolvePromise = undefined;
    this.password = '';
    this.confirmation = '';
    this.contentEl.empty();
  }
}

/**
 * 只显示一次恢复密钥；关闭或取消会导致暂存 Vault 回滚。
 * Displays the recovery key once; closing or cancelling rolls back the staged vault.
 */
export class RecoveryKeyModal extends Modal {
  private acknowledged = false;
  private recoveryKey: string;
  private resolvePromise?: (confirmed: boolean) => void;

  constructor(app: App, recoveryKey: string) {
    super(app);
    this.recoveryKey = recoveryKey;
  }

  open(): Promise<boolean> {
    super.open();
    return new Promise((resolve) => { this.resolvePromise = resolve; });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '立即保存恢复密钥' });
    contentEl.createEl('p', { text: '此密钥可在忘记密码时恢复 Vault。它仅显示这一次；请抄写到离线、安全的位置，不要存入同步目录。' });
    const keyEl = contentEl.createEl('textarea', { text: this.recoveryKey });
    keyEl.readOnly = true;
    keyEl.rows = 8;
    keyEl.addClass('cryptomator-recovery-key');
    new Setting(contentEl).setName('我已安全保存恢复密钥').addToggle((toggle) => {
      toggle.setValue(false).onChange((value) => { this.acknowledged = value; });
    });
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('取消并删除暂存 Vault').onClick(() => { this.resolvePromise?.(false); this.close(); }))
      .addButton((btn) => btn.setButtonText('我已保存，完成创建').setCta().onClick(() => {
        if (!this.acknowledged) {
          contentEl.createEl('p', { text: '请先确认已安全保存恢复密钥。', cls: 'mod-warning' });
          return;
        }
        this.resolvePromise?.(true);
        this.close();
      }));
  }

  onClose(): void {
    this.resolvePromise?.(false);
    this.resolvePromise = undefined;
    this.recoveryKey = '';
    this.contentEl.empty();
  }
}

/**
 * 通用确认弹窗。
 * Generic confirmation modal.
 */
export class ConfirmModal extends Modal {
  private resolvePromise?: (confirmed: boolean) => void;

  constructor(app: App, private readonly title: string, private readonly message: string, private readonly confirmText = '确认') {
    super(app);
  }

  open(): Promise<boolean> {
    super.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => {
          this.resolvePromise?.(false);
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText(this.confirmText).setWarning().setCta().onClick(() => {
          this.resolvePromise?.(true);
          this.close();
        }),
      );
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = undefined;
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Nutstore 排除规则阻断弹窗；除非用户确认已配置排除规则，否则不允许解锁。
 * Nutstore exclusion gating modal; blocks unlock unless the user confirms the exclusion rule.
 */
export class NutstoreExclusionModal extends Modal {
  private confirmed = false;
  private resolvePromise?: (confirmed: boolean) => void;

  constructor(app: App, private readonly folderName: string) {
    super(app);
  }

  open(): Promise<boolean> {
    super.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '需要配置 Nutstore 排除规则' });

    contentEl.createEl('p', {
      text: `解锁「${this.folderName}」前，必须在 Nutstore 中配置排除规则，防止明文挂载目录被同步到云端。`,
    });

    contentEl.createEl('div', { cls: 'setting-item' }, (el) => {
      el.createEl('p', {
        text: `排除规则：${'**'}${'/*.cryptomator-mount'}`,
        cls: 'setting-item-description',
      });
      el.createEl('p', {
        text: '请在 Nutstore 客户端 → 设置 → 忽略文件/文件夹 → 添加此规则后，勾选下方确认。',
        cls: 'setting-item-description',
      });
    });

    new Setting(contentEl)
      .setName('我已配置排除规则')
      .addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          this.confirmed = value;
        });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText('取消').onClick(() => {
          this.resolvePromise?.(false);
          this.close();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('我已配置，继续解锁').setCta().onClick(() => {
          if (!this.confirmed) {
            return;
          }
          this.resolvePromise?.(true);
          this.close();
        }),
      );
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = undefined;
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}
