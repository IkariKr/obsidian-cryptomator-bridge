import path from 'node:path';
import type { AutoLockSettings, BridgeSettings, VaultRecord } from './types';
import { detectWindowsCliPath, discoverMounters, migrateLegacyMounterId } from './prerequisites';

export const SETTINGS_SCHEMA_VERSION = 3 as const;

export const DEFAULT_AUTO_LOCK_SETTINGS: AutoLockSettings = {
  idleLockMinutes: 15,
  lockOnScreenLock: true,
};

/** 加密文件夹预留后缀，不得由用户修改。 / Reserved suffixes for encrypted folders; must not be user-editable. */
export const ENCRYPTED_VAULT_SUFFIX = '.cryptomator' as const;
export const MOUNT_SUFFIX = '.cryptomator-mount' as const;

/** 生成不依赖外部库的唯一 ID。 / Generate a unique ID without external library dependencies. */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 默认设置不包含密码或本机路径。
 * Default settings contain neither a password nor a machine-specific path.
 */
export const DEFAULT_SETTINGS: BridgeSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  cliPath: '',
  syncRootPath: '',
  mounterId: '',
  vaultRecords: [],
  autoLock: { ...DEFAULT_AUTO_LOCK_SETTINGS },
};

/** 根据 folderName 派生密文相对路径。 / Derive encrypted relative path from folderName. */
export function deriveEncryptedRelativePath(folderName: string): string {
  return `${folderName}${ENCRYPTED_VAULT_SUFFIX}`;
}

/** 根据 folderName 派生挂载相对路径。 / Derive mount relative path from folderName. */
export function deriveMountRelativePath(folderName: string): string {
  return `${folderName}${MOUNT_SUFFIX}`;
}

/**
 * 判断文件夹名称是否会与插件保留的 Cryptomator 目录冲突。
 * Check whether a folder name conflicts with plugin-reserved Cryptomator directories.
 */
export function isReservedVaultFolderName(folderName: string): boolean {
  return folderName.endsWith(ENCRYPTED_VAULT_SUFFIX) || folderName.endsWith(MOUNT_SUFFIX);
}

/** 设置校验结果。 / Result of settings validation. */
export type SettingsValidationResult =
  | { valid: true; settings: BridgeSettings }
  | { valid: false; errors: string[] };

/**
 * 将当前及历史设置整理为最新设置版本；缺少版本号的首版数据按 v1→v2→v3 迁移。
 * Normalize current and legacy settings to the latest schema; versionless first-release data migrates through v1→v2→v3.
 */
export function migrateSettings(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const raw = input as Record<string, unknown>;
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined;

  // v1 / versionless → v2（先迁移为 v2，再走 v2→v3）
  if (version === undefined || version === 1) {
    const legacyEncryptedVaultPath = typeof raw.encryptedVaultPath === 'string' ? raw.encryptedVaultPath.trim() : '';
    const separatorIndex = Math.max(legacyEncryptedVaultPath.lastIndexOf('\\'), legacyEncryptedVaultPath.lastIndexOf('/'));
    const syncRootPath = separatorIndex > 0 ? legacyEncryptedVaultPath.slice(0, separatorIndex) : '';
    const encryptedVaultRelativePath = separatorIndex > 0 ? legacyEncryptedVaultPath.slice(separatorIndex + 1) : '';
    raw.schemaVersion = 2;
    raw.syncRootPath = typeof raw.syncRootPath === 'string' ? raw.syncRootPath : syncRootPath;
    raw.encryptedVaultRelativePath = typeof raw.encryptedVaultRelativePath === 'string'
      ? raw.encryptedVaultRelativePath
      : encryptedVaultRelativePath;
    raw.autoLock = raw.autoLock ?? { ...DEFAULT_AUTO_LOCK_SETTINGS };
  }

  // v2 → v3：将旧单 Vault 配置转为 vaultRecords 列表
  if (raw.schemaVersion === 2) {
    const vaultRecords: VaultRecord[] = [];
    const oldEncryptedRelPath = typeof raw.encryptedVaultRelativePath === 'string' ? (raw.encryptedVaultRelativePath as string).trim() : '';
    const oldVaultName = typeof raw.privateVaultName === 'string' ? (raw.privateVaultName as string).trim() : '';

    // 从旧字段提取 folderName：去掉 .cryptomator 后缀或直接使用 vaultName
    let folderName = '';
    if (oldEncryptedRelPath) {
      folderName = oldEncryptedRelPath.endsWith(ENCRYPTED_VAULT_SUFFIX)
        ? oldEncryptedRelPath.slice(0, -ENCRYPTED_VAULT_SUFFIX.length)
        : oldEncryptedRelPath;
    } else if (oldVaultName) {
      folderName = oldVaultName;
    }

    if (folderName) {
      vaultRecords.push({
        id: generateId(),
        folderName,
        nutstoreExclusionConfirmed: false,
      });
    }

    // 删除旧字段，避免校验报错
    delete raw.encryptedVaultRelativePath;
    delete raw.mountPath;
    delete raw.privateVaultName;

    raw.schemaVersion = 3;
    raw.vaultRecords = vaultRecords;
    raw.autoLock = raw.autoLock ?? { ...DEFAULT_AUTO_LOCK_SETTINGS };
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

/** 校验单条 VaultRecord。 / Validate a single VaultRecord. */
function validateVaultRecord(record: unknown, index: number, errors: string[]): VaultRecord | null {
  if (!record || typeof record !== 'object') {
    errors.push(`vaultRecords[${index}] 必须是对象。`);
    return null;
  }
  const r = record as Record<string, unknown>;

  if (!isNonEmptyString(r.id)) {
    errors.push(`vaultRecords[${index}].id 不能为空。`);
  }
  const folderName = typeof r.folderName === 'string' ? r.folderName.trim() : '';
  if (!folderName) {
    errors.push(`vaultRecords[${index}].folderName 不能为空。`);
  } else if (/[\\/\0]/u.test(folderName)) {
    errors.push(`vaultRecords[${index}].folderName 包含非法路径分隔符或空字符。`);
  } else if (/[<>:"|?*\u0000-\u001F]/u.test(folderName) || /[. ]$/u.test(folderName)) {
    errors.push(`vaultRecords[${index}].folderName 包含 Windows 不支持的字符或结尾。`);
  } else if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(folderName)) {
    errors.push(`vaultRecords[${index}].folderName 不能使用 Windows 保留设备名。`);
  } else if (isReservedVaultFolderName(folderName)) {
    errors.push(`vaultRecords[${index}].folderName 不得包含 ${ENCRYPTED_VAULT_SUFFIX} 或 ${MOUNT_SUFFIX} 后缀。`);
  }
  if (typeof r.nutstoreExclusionConfirmed !== 'boolean') {
    errors.push(`vaultRecords[${index}].nutstoreExclusionConfirmed 必须是布尔值。`);
  }

  if (errors.length > 0) {
    return null;
  }

  return {
    id: r.id as string,
    folderName,
    nutstoreExclusionConfirmed: r.nutstoreExclusionConfirmed as boolean,
  };
}

/** 校验 vaultRecords 列表；不允许重复 id 或 folderName。 / Validate vaultRecords list; duplicate id or folderName is rejected. */
function validateVaultRecords(value: unknown, errors: string[]): VaultRecord[] | null {
  if (!Array.isArray(value)) {
    errors.push('vaultRecords 必须是数组。');
    return null;
  }
  const records: VaultRecord[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const record = validateVaultRecord(value[i], i, errors);
    if (!record) {
      continue;
    }
    if (seenIds.has(record.id)) {
      errors.push(`vaultRecords 包含重复 id：${record.id}。`);
    }
    if (seenNames.has(record.folderName)) {
      errors.push(`vaultRecords 包含重复 folderName：${record.folderName}。`);
    }
    seenIds.add(record.id);
    seenNames.add(record.folderName);
    records.push(record);
  }
  if (errors.length > 0) {
    return null;
  }
  return records;
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

  const stringFields: Array<'cliPath' | 'syncRootPath' | 'mounterId'> = [
    'cliPath',
    'syncRootPath',
    'mounterId',
  ];

  for (const field of stringFields) {
    if (!isNonEmptyString(raw[field])) {
      errors.push(`${field} 不能为空。`);
    }
  }

  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    errors.push(`不支持的 schemaVersion：${String(raw.schemaVersion)}。`);
  }

  const autoLock = validateAutoLock(raw.autoLock, errors);
  const vaultRecords = validateVaultRecords(raw.vaultRecords, errors);

  if ('password' in raw || 'passphrase' in raw || 'secret' in raw) {
    errors.push('密码不得属于插件设置。');
  }

  if (errors.length > 0 || !autoLock || !vaultRecords) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      cliPath: (raw.cliPath as string).trim(),
      syncRootPath: (raw.syncRootPath as string).trim(),
      mounterId: (raw.mounterId as string).trim(),
      vaultRecords,
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
 * 异步自动检测并填充 CLI 路径和挂载器 ID；已有配置不被覆盖。
 * Auto-detect and fill CLI path and mounter ID; never overwrites existing values.
 */
export async function applyAutoDetectedDefaults(settings: BridgeSettings): Promise<BridgeSettings> {
  let updated = { ...settings };

  // 自动检测 CLI 路径
  if (!updated.cliPath) {
    const detectedCli = await detectWindowsCliPath();
    if (detectedCli) {
      updated = { ...updated, cliPath: detectedCli };
    }
  }

  // 自动检测挂载器 ID
  if (!updated.mounterId || updated.mounterId === 'org.cryptomator.frontend.fuse.mount.WinFspNetworkMountProvider') {
    const mounters = await discoverMounters(updated.cliPath);
    const migratedMounterId = migrateLegacyMounterId(updated.mounterId, mounters);
    if (migratedMounterId !== updated.mounterId) {
      updated = { ...updated, mounterId: migratedMounterId };
    }
  }

  return updated;
}

/**
 * 解析所有记录的派生绝对路径。
 * Resolve derived absolute paths for all records.
 */
export function resolveVaultRecords(
  settings: BridgeSettings,
): import('./types').ResolvedVaultRecord[] {
  const syncRoot = path.resolve(settings.syncRootPath);
  return settings.vaultRecords.map((record) => ({
    ...record,
    encryptedVaultPath: path.resolve(syncRoot, deriveEncryptedRelativePath(record.folderName)),
    mountPath: path.resolve(syncRoot, deriveMountRelativePath(record.folderName)),
  }));
}
