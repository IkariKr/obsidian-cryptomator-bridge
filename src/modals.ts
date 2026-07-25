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
    contentEl.createEl('h2', { text: '配置私密笔记库' });

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
      text: '请先使用 Cryptomator Desktop 在控制 Vault 的同步根下创建同名密文目录（如 Work.cryptomator），再完成此配置。',
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
        btn.setButtonText('确认配置').setCta().onClick(() => {
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
    const { contentEl } = this.contentEl;
    contentEl?.empty();
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
