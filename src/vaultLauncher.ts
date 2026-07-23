import { ConfigurationError } from './errors';

/** Vault 启动器依赖注入项。 / Dependency injection options for the vault launcher. */
export interface VaultLauncherOptions {
  openExternal?: (uri: string) => void;
}

/**
 * 通过标准 Obsidian URI 打开已注册 Vault；业务层不依赖 Electron 内部 API。
 * Open a registered vault through the standard Obsidian URI; business code does not depend on Electron internals.
 */
export class VaultLauncher {
  private readonly openExternal: (uri: string) => void;

  constructor(options: VaultLauncherOptions = {}) {
    this.openExternal = options.openExternal ?? ((uri) => window.open(uri, '_blank'));
  }

  buildUri(privateVaultName: string): string {
    if (!privateVaultName || /[\\/\0]/u.test(privateVaultName)) {
      throw new ConfigurationError('privateVaultName 不是有效的已注册 Vault 名称。');
    }
    return `obsidian://open?vault=${encodeURIComponent(privateVaultName)}&paneType=window`;
  }

  open(privateVaultName: string): string {
    const uri = this.buildUri(privateVaultName);
    this.openExternal(uri);
    return uri;
  }
}
