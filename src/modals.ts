import { App, Modal, Setting } from 'obsidian';

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
