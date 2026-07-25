import { describe, expect, it } from 'vitest';
import {
  applyCurrentVaultDefaults,
  DEFAULT_SETTINGS,
  loadSettings,
  migrateSettings,
  validateSettings,
  deriveEncryptedRelativePath,
  deriveMountRelativePath,
  resolveVaultRecords,
} from '../src/settings';
import type { BridgeSettings } from '../src/types';

const validSettings: BridgeSettings = {
  schemaVersion: 3,
  cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
  syncRootPath: 'C:\\Nutstore',
  mounterId: 'WinFspMountProvider',
  vaultRecords: [
    { id: 'rec-1', folderName: 'PrivateNotes', nutstoreExclusionConfirmed: true },
  ],
  autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
};

describe('settings contract (v3 multi-record)', () => {
  it('loads a valid non-sensitive configuration', () => {
    expect(loadSettings(validSettings)).toEqual(validSettings);
  });

  it('does not accept a password in persisted settings', () => {
    const result = validateSettings({ ...validSettings, password: 'never-test-with-a-real-secret' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('密码不得属于插件设置。');
    }
  });

  it('falls back to defaults for missing or invalid values', () => {
    expect(loadSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ ...validSettings, schemaVersion: 4 }).valid).toBe(false);
  });

  it('migrates v2 single-vault settings to v3 vaultRecords', () => {
    const v2Settings = {
      schemaVersion: 2,
      cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
      syncRootPath: 'C:\\Nutstore',
      encryptedVaultRelativePath: 'PrivateNotes.cryptomator',
      mountPath: 'C:\\Mount',
      mounterId: 'WinFspMountProvider',
      privateVaultName: 'Private Vault',
      autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
    };
    const raw = migrateSettings(v2Settings) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(3);
    const records = raw.vaultRecords as Array<{ folderName: string; nutstoreExclusionConfirmed: boolean }>;
    expect(records).toHaveLength(1);
    expect(records[0].folderName).toBe('PrivateNotes');
    expect(records[0].nutstoreExclusionConfirmed).toBe(false);
    // 旧字段已清除
    expect(raw.encryptedVaultRelativePath).toBeUndefined();
    expect(raw.mountPath).toBeUndefined();
    expect(raw.privateVaultName).toBeUndefined();
  });

  it('migrates v2 settings using privateVaultName when encryptedVaultRelativePath is missing', () => {
    const v2Settings = {
      schemaVersion: 2,
      cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
      syncRootPath: 'C:\\Nutstore',
      mountPath: 'C:\\Mount',
      mounterId: 'WinFspMountProvider',
      privateVaultName: 'MySecret',
      autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
    };
    const raw = migrateSettings(v2Settings) as Record<string, unknown>;
    const records = raw.vaultRecords as Array<{ folderName: string }>;
    expect(records).toHaveLength(1);
    expect(records[0].folderName).toBe('MySecret');
  });

  it('produces an empty vaultRecords array when v2 had no vault configured', () => {
    const v2Settings = {
      schemaVersion: 2,
      cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
      syncRootPath: 'C:\\Nutstore',
      mountPath: 'C:\\Mount',
      mounterId: 'WinFspMountProvider',
      autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
    };
    const raw = migrateSettings(v2Settings) as Record<string, unknown>;
    const records = raw.vaultRecords as Array<unknown>;
    expect(records).toHaveLength(0);
  });

  it('rejects an invalid automatic-lock policy', () => {
    expect(
      validateSettings({
        ...validSettings,
        autoLock: { idleLockMinutes: -1, lockOnScreenLock: true },
      }).valid,
    ).toBe(false);
  });

  it('trims configured values', () => {
    const result = loadSettings({
      ...validSettings,
      cliPath: '  C:\\Cryptomator\\cryptomator-cli.exe  ',
    });
    expect(result.cliPath).toBe('C:\\Cryptomator\\cryptomator-cli.exe');
  });

  it('validates vaultRecords for duplicates', () => {
    const result = validateSettings({
      ...validSettings,
      vaultRecords: [
        { id: 'same', folderName: 'A', nutstoreExclusionConfirmed: true },
        { id: 'same', folderName: 'B', nutstoreExclusionConfirmed: false },
      ],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('重复 id'))).toBe(true);
    }
  });

  it('validates vaultRecords for duplicate folderNames', () => {
    const result = validateSettings({
      ...validSettings,
      vaultRecords: [
        { id: 'a', folderName: 'Same', nutstoreExclusionConfirmed: true },
        { id: 'b', folderName: 'Same', nutstoreExclusionConfirmed: false },
      ],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('重复 folderName'))).toBe(true);
    }
  });

  it('rejects folderNames with path separators or reserved suffixes', () => {
    const badNames = ['bad/name', 'bad\\name', 'bad\0name', 'bad.cryptomator', 'bad.cryptomator-mount'];
    for (const name of badNames) {
      const result = validateSettings({
        ...validSettings,
        vaultRecords: [{ id: 'test', folderName: name, nutstoreExclusionConfirmed: false }],
      });
      expect(result.valid).toBe(false);
    }
  });

  it('accepts multiple vaultRecords', () => {
    const result = validateSettings({
      ...validSettings,
      vaultRecords: [
        { id: 'rec-1', folderName: 'Work', nutstoreExclusionConfirmed: true },
        { id: 'rec-2', folderName: 'Personal', nutstoreExclusionConfirmed: false },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('requires all required string fields', () => {
    expect(validateSettings({ ...validSettings, cliPath: '' }).valid).toBe(false);
    expect(validateSettings({ ...validSettings, syncRootPath: '' }).valid).toBe(false);
    expect(validateSettings({ ...validSettings, mounterId: '' }).valid).toBe(false);
  });

  it('defaults an empty sync root to the current control Vault path', () => {
    const result = applyCurrentVaultDefaults(
      { ...DEFAULT_SETTINGS, cliPath: 'test', mounterId: 'test' },
      'H:\\Vaults\\Life OS',
    );
    expect(result.syncRootPath).toBe('H:\\Vaults\\Life OS');
  });

  it('does not overwrite an explicitly configured sync root', () => {
    expect(
      applyCurrentVaultDefaults(validSettings, 'H:\\Vaults\\Other').syncRootPath,
    ).toBe('C:\\Nutstore');
  });

  it('derives encrypted and mount relative paths from folderName', () => {
    expect(deriveEncryptedRelativePath('Work')).toBe('Work.cryptomator');
    expect(deriveMountRelativePath('Work')).toBe('Work.cryptomator-mount');
  });

  it('resolves vault records to absolute paths', () => {
    const settings: BridgeSettings = {
      ...validSettings,
      syncRootPath: 'C:\\Nutstore',
      vaultRecords: [
        { id: 'rec-1', folderName: 'Work', nutstoreExclusionConfirmed: true },
      ],
    };
    const resolved = resolveVaultRecords(settings);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].encryptedVaultPath).toBe('C:\\Nutstore\\Work.cryptomator');
    expect(resolved[0].mountPath).toBe('C:\\Nutstore\\Work.cryptomator-mount');
  });

  it('defaults have empty vaultRecords and valid autoLock', () => {
    expect(DEFAULT_SETTINGS.vaultRecords).toEqual([]);
    expect(DEFAULT_SETTINGS.autoLock.idleLockMinutes).toBe(15);
    expect(DEFAULT_SETTINGS.autoLock.lockOnScreenLock).toBe(true);
  });
});
