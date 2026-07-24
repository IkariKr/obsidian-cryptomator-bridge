import { App, Modal, Setting } from 'obsidian';
import type { BridgeSettings } from './types';

/**
 * 一次性密码输入框；关闭后不保存输入值。
 * One-shot password input modal; the entered value is not saved after closing.
 */
export class PasswordModal extends Modal {
  private resolveResult: ((value: string | null) => void) | null;

  constructor(app: App, resolveResult: (value: string | null) => void) {
    super(app);
    this.resolveResult = resolveResult;
  }

  onOpen(): void {
    this.titleEl.setText('解锁 Cryptomator Vault');
    this.contentEl.createEl('p', { text: '密码只用于本次解锁，不会保存到插件设置。' });
    const input = this.contentEl.createEl('input', { type: 'password', attr: { autocomplete: 'off' } });
    input.addClass('cryptomator-bridge-password-input');
    input.focus();

    const submit = () => {
      const value = input.value;
      input.value = '';
      const resolve = this.resolveResult;
      this.resolveResult = null;
      resolve?.(value);
      this.close();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('解锁').setCta().onClick(submit))
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    const resolve = this.resolveResult;
    this.resolveResult = null;
    resolve?.(null);
    this.contentEl.empty();
  }
}

/** 打开一次性密码对话框。 / Open the one-shot password dialog. */
export function requestPassword(app: App): Promise<string | null> {
  return new Promise((resolve) => new PasswordModal(app, resolve).open());
}

/** 首次配置向导返回的非敏感字段；不包含密码。 / Non-sensitive fields returned by the first-use setup wizard; contains no password. */
export type SetupDraft = Pick<BridgeSettings, 'cliPath' | 'syncRootPath' | 'encryptedVaultRelativePath' | 'mountPath' | 'mounterId' | 'privateVaultName'>;

/**
 * 引导用户先用 Cryptomator Desktop 创建 Vault，再登记本机桥接配置。
 * Guides the user to create a Vault with Cryptomator Desktop before registering local bridge settings.
 */
export class SetupModal extends Modal {
  private resolveResult: ((value: SetupDraft | null) => void) | null;
  private readonly initial: SetupDraft;
  private readonly sourceFolderPath?: string;

  constructor(app: App, initial: SetupDraft, sourceFolderPath: string | undefined, resolveResult: (value: SetupDraft | null) => void) {
    super(app);
    this.initial = initial;
    this.sourceFolderPath = sourceFolderPath;
    this.resolveResult = resolveResult;
  }

  onOpen(): void {
    this.titleEl.setText('配置私密笔记库');
    this.contentEl.createEl('p', {
      text: '请先在 Cryptomator Desktop 中于当前控制 Vault 的 Nutstore 同步范围内创建 Vault，然后填写下面的本机配置。密码只在 Cryptomator Desktop 或解锁时输入，不会交给插件。',
    });
    if (this.sourceFolderPath) {
      this.contentEl.createEl('p', { text: `待迁移文件夹：${this.sourceFolderPath}` });
    }

    const inputs = {
      cliPath: this.addInput('Cryptomator CLI 路径', this.initial.cliPath),
      syncRootPath: this.addInput('当前控制 Vault 内的 Nutstore 同步根目录', this.initial.syncRootPath),
      encryptedVaultRelativePath: this.addInput('密文 Vault 相对路径（默认 PrivateNotes.cryptomator）', this.initial.encryptedVaultRelativePath),
      mountPath: this.addInput('本机明文挂载路径（默认系统临时目录）', this.initial.mountPath),
      mounterId: this.addInput('WinFsp mounter ID（由 CLI 自动探测）', this.initial.mounterId),
      privateVaultName: this.addInput('已注册的私密 Obsidian Vault 名称', this.initial.privateVaultName),
    };
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('保存并继续').setCta().onClick(() => {
        const value: SetupDraft = {
          cliPath: inputs.cliPath.value.trim(),
          syncRootPath: inputs.syncRootPath.value.trim(),
          encryptedVaultRelativePath: inputs.encryptedVaultRelativePath.value.trim(),
          mountPath: inputs.mountPath.value.trim(),
          mounterId: inputs.mounterId.value.trim(),
          privateVaultName: inputs.privateVaultName.value.trim(),
        };
        const resolve = this.resolveResult;
        this.resolveResult = null;
        resolve?.(value);
        this.close();
      }))
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    const resolve = this.resolveResult;
    this.resolveResult = null;
    resolve?.(null);
    this.contentEl.empty();
  }

  private addInput(name: string, value: string): HTMLInputElement {
    const input = this.contentEl.createEl('input', { type: 'text', attr: { autocomplete: 'off' } });
    input.setAttribute('aria-label', name);
    input.placeholder = name;
    input.value = value;
    return input;
  }
}

/** 打开首次配置向导。 / Open the first-use setup wizard. */
export function requestVaultSetup(app: App, initial: SetupDraft, sourceFolderPath?: string): Promise<SetupDraft | null> {
  return new Promise((resolve) => new SetupModal(app, initial, sourceFolderPath, resolve).open());
}

/**
 * 对同步根目录等风险提示要求用户明确确认。
 * Require explicit user confirmation for warnings such as unknown sync roots.
 */
export class ConfirmationModal extends Modal {
  private resolveResult: ((confirmed: boolean) => void) | null;

  constructor(app: App, title: string, message: string, resolveResult: (confirmed: boolean) => void) {
    super(app);
    this.resolveResult = resolveResult;
    this.titleEl.setText(title);
    this.contentEl.createEl('p', { text: message });
  }

  onOpen(): void {
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('继续').setCta().onClick(() => this.finish(true)))
      .addButton((button) => button.setButtonText('取消').onClick(() => this.finish(false)));
  }

  onClose(): void {
    const resolve = this.resolveResult;
    this.resolveResult = null;
    resolve?.(false);
    this.contentEl.empty();
  }

  private finish(confirmed: boolean): void {
    const resolve = this.resolveResult;
    this.resolveResult = null;
    if (!resolve) {
      return;
    }
    resolve?.(confirmed);
    this.close();
  }
}

/** 打开需要明确确认的风险提示。 / Open a warning that requires explicit confirmation. */
export function requestConfirmation(app: App, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => new ConfirmationModal(app, title, message, resolve).open());
}
