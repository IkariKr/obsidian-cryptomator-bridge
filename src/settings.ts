import os from 'node:os';
import path from 'node:path';
import type { AutoLockSettings, BridgeSettings } from './types';

export const SETTINGS_SCHEMA_VERSION = 2 as const;

export const DEFAULT_AUTO_LOCK_SETTINGS: AutoLockSettings = {
  idleLockMinutes: 15,
  lockOnScreenLock: true,
};

/** 首次配置使用的安全默认值；不会自动创建 Vault 或挂载目录。 / Safe first-use defaults; no Vault or mount directory is created automatically. */
export const DEFAULT_ENCRYPTED_VAULT_RELATIVE_PATH = 'PrivateNotes.cryptomator';
export const DEFAULT_MOUNT_PATH = path.join(os.tmpdir(), 'obsidian-cryptomator-bridge-mount');

/**
 * 默认设置不包含密码或本机路径。
 * Default settings contain neither a password nor a machine-specific path.
 */
export const DEFAULT_SETTINGS: BridgeSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  cliPath: '',
  syncRootPath: '',
  encryptedVaultRelativePath: '',
  mountPath: '',
  mounterId: '',
  privateVaultName: '',
  autoLock: { ...DEFAULT_AUTO_LOCK_SETTINGS },
};

/** 设置校验结果。 / Result of settings validation. */
export type SettingsValidationResult =
  | { valid: true; settings: BridgeSettings }
  | { valid: false; errors: string[] };

/**
 * 将当前及历史设置整理为最新设置版本；缺少版本号的首版数据按 v1 迁移。
 * Normalize current and legacy settings to the latest schema; versionless first-release data migrates to v1.
 */
export function migrateSettings(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion === undefined || raw.schemaVersion === 1) {
    const legacyEncryptedVaultPath = typeof raw.encryptedVaultPath === 'string' ? raw.encryptedVaultPath.trim() : '';
    const separatorIndex = Math.max(legacyEncryptedVaultPath.lastIndexOf('\\'), legacyEncryptedVaultPath.lastIndexOf('/'));
    const syncRootPath = separatorIndex > 0 ? legacyEncryptedVaultPath.slice(0, separatorIndex) : '';
    const encryptedVaultRelativePath = separatorIndex > 0 ? legacyEncryptedVaultPath.slice(separatorIndex + 1) : '';
    return {
      ...raw,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      syncRootPath: typeof raw.syncRootPath === 'string' ? raw.syncRootPath : syncRootPath,
      encryptedVaultRelativePath: typeof raw.encryptedVaultRelativePath === 'string'
        ? raw.encryptedVaultRelativePath
        : encryptedVaultRelativePath,
      autoLock: raw.autoLock ?? { ...DEFAULT_AUTO_LOCK_SETTINGS },
    };
  }

  return raw;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAutoLock(value: unknown, errors: string[]): AutoLockSettings | null {
  if (!value || typeof value !== 'object') {
    errors.push('autoLock 必须是对象。');
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isInteger(raw.idleLockMinutes) || (raw.idleLockMinutes as number) < 0 || (raw.idleLockMinutes as number) > 24 * 60) {
    errors.push('autoLock.idleLockMinutes 必须是 0 到 1440 的整数。');
  }
  if (typeof raw.lockOnScreenLock !== 'boolean') {
    errors.push('autoLock.lockOnScreenLock 必须是布尔值。');
  }
  if (errors.length > 0) {
    return null;
  }
  return {
    idleLockMinutes: raw.idleLockMinutes as number,
    lockOnScreenLock: raw.lockOnScreenLock as boolean,
  };
}

/**
 * 校验并迁移设置数据；未知字段被忽略，密码字段永远不会被接受。
 * Validate and migrate settings; unknown fields are ignored and password fields are never accepted.
 */
export function validateSettings(input: unknown): SettingsValidationResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['设置必须是对象。'] };
  }

  const raw = input as Record<string, unknown>;
  const errors: string[] = [];
  const fields: Array<Exclude<keyof BridgeSettings, 'schemaVersion' | 'autoLock'>> = [
    'cliPath',
    'syncRootPath',
    'encryptedVaultRelativePath',
    'mountPath',
    'mounterId',
    'privateVaultName',
  ];

  for (const field of fields) {
    if (!isNonEmptyString(raw[field])) {
      errors.push(`${field} 不能为空。`);
    }
  }

  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    errors.push(`不支持的 schemaVersion：${String(raw.schemaVersion)}。`);
  }

  const autoLock = validateAutoLock(raw.autoLock, errors);

  if ('password' in raw || 'passphrase' in raw || 'secret' in raw) {
    errors.push('密码不得属于插件设置。');
  }

  if (errors.length > 0 || !autoLock) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      cliPath: (raw.cliPath as string).trim(),
      syncRootPath: (raw.syncRootPath as string).trim(),
      encryptedVaultRelativePath: (raw.encryptedVaultRelativePath as string).trim(),
      mountPath: (raw.mountPath as string).trim(),
      mounterId: (raw.mounterId as string).trim(),
      privateVaultName: (raw.privateVaultName as string).trim(),
      autoLock,
    },
  };
}

/**
 * 从 Obsidian 持久化数据加载设置；无效数据回退为安全默认值。
 * Load settings from Obsidian persisted data; invalid data falls back to safe defaults.
 */
export function loadSettings(input: unknown): BridgeSettings {
  const result = validateSettings(migrateSettings(input));
  return result.valid ? result.settings : { ...DEFAULT_SETTINGS };
}

/**
 * 使用当前控制 Vault 根目录填充空的同步根目录；已有明确配置不被静默覆盖。
 * Fills an empty sync root with the current control Vault root; never silently overwrites an explicit value.
 */
export function applyCurrentVaultDefaults(settings: BridgeSettings, currentVaultPath?: string): BridgeSettings {
  const normalizedCurrentPath = currentVaultPath?.trim();
  if (settings.syncRootPath || !normalizedCurrentPath) {
    return settings;
  }
  return { ...settings, syncRootPath: normalizedCurrentPath };
}

/**
 * 填充首次使用的静态路径默认值；已有明确配置不会被静默覆盖。
 * Fills static first-use path defaults; existing explicit values are never silently overwritten.
 */
export function applyStaticDefaults(settings: BridgeSettings, currentVaultPath?: string): BridgeSettings {
  const withSyncRoot = applyCurrentVaultDefaults(settings, currentVaultPath);
  return {
    ...withSyncRoot,
    encryptedVaultRelativePath: withSyncRoot.encryptedVaultRelativePath || DEFAULT_ENCRYPTED_VAULT_RELATIVE_PATH,
    mountPath: withSyncRoot.mountPath || DEFAULT_MOUNT_PATH,
  };
}
