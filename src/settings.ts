import type { BridgeSettings } from './types';

export const SETTINGS_SCHEMA_VERSION = 1 as const;

/**
 * 默认设置不包含密码或本机路径。
 * Default settings contain neither a password nor a machine-specific path.
 */
export const DEFAULT_SETTINGS: BridgeSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  cliPath: '',
  encryptedVaultPath: '',
  mountPath: '',
  mounterId: '',
  privateVaultName: '',
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
  if (raw.schemaVersion === undefined) {
    return { ...raw, schemaVersion: SETTINGS_SCHEMA_VERSION };
  }

  return raw;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  const fields: Array<keyof Omit<BridgeSettings, 'schemaVersion'>> = [
    'cliPath',
    'encryptedVaultPath',
    'mountPath',
    'mounterId',
    'privateVaultName',
  ];

  for (const field of fields) {
    if (!isNonEmptyString(raw[field])) {
      errors.push(`${field} 不能为空。`);
    }
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    errors.push(`不支持的 schemaVersion：${String(raw.schemaVersion)}。`);
  }

  if ('password' in raw || 'passphrase' in raw || 'secret' in raw) {
    errors.push('密码不得属于插件设置。');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      cliPath: (raw.cliPath as string).trim(),
      encryptedVaultPath: (raw.encryptedVaultPath as string).trim(),
      mountPath: (raw.mountPath as string).trim(),
      mounterId: (raw.mounterId as string).trim(),
      privateVaultName: (raw.privateVaultName as string).trim(),
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
