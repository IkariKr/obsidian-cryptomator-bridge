import { describe, expect, it } from 'vitest';
import { applyCurrentVaultDefaults, applyStaticDefaults, DEFAULT_ENCRYPTED_VAULT_RELATIVE_PATH, DEFAULT_MOUNT_PATH, DEFAULT_SETTINGS, loadSettings, validateSettings } from '../src/settings';
import type { BridgeSettings } from '../src/types';

const validSettings = {
  schemaVersion: 2,
  cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
  syncRootPath: 'C:\\Nutstore',
  encryptedVaultRelativePath: 'PrivateNotes.cryptomator',
  mountPath: 'C:\\Mount',
  mounterId: 'WinFspMountProvider',
  privateVaultName: 'Private Vault',
  autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
} satisfies BridgeSettings;

describe('settings contract', () => {
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
    expect(validateSettings({ ...validSettings, schemaVersion: 3 }).valid).toBe(false);
  });

  it('migrates a v1 encrypted Vault path to a sync root and relative Vault path', () => {
    const { syncRootPath: _syncRootPath, encryptedVaultRelativePath: _encryptedVaultRelativePath, autoLock: _autoLock, ...legacySettings } = validSettings;
    expect(loadSettings({ ...legacySettings, schemaVersion: 1, encryptedVaultPath: 'C:\\Nutstore\\PrivateNotes.cryptomator' })).toEqual(validSettings);
  });

  it('rejects an invalid automatic-lock policy', () => {
    expect(validateSettings({ ...validSettings, autoLock: { idleLockMinutes: -1, lockOnScreenLock: true } }).valid).toBe(false);
  });

  it('trims configured values', () => {
    const result = loadSettings({
      ...validSettings,
      cliPath: '  C:\\Cryptomator\\cryptomator-cli.exe  ',
    });
    expect(result.cliPath).toBe('C:\\Cryptomator\\cryptomator-cli.exe');
  });

  it('defaults an empty sync root to the current control Vault path', () => {
    expect(applyCurrentVaultDefaults(DEFAULT_SETTINGS, 'H:\\Vaults\\Life OS').syncRootPath).toBe('H:\\Vaults\\Life OS');
  });

  it('does not overwrite an explicitly configured sync root', () => {
    expect(applyCurrentVaultDefaults(validSettings, 'H:\\Vaults\\Other').syncRootPath).toBe('C:\\Nutstore');
  });

  it('fills static first-use defaults without overwriting explicit values', () => {
    const result = applyStaticDefaults(DEFAULT_SETTINGS, 'H:\\Vaults\\Life OS');
    expect(result.syncRootPath).toBe('H:\\Vaults\\Life OS');
    expect(result.encryptedVaultRelativePath).toBe(DEFAULT_ENCRYPTED_VAULT_RELATIVE_PATH);
    expect(result.mountPath).toBe(DEFAULT_MOUNT_PATH);
    expect(applyStaticDefaults(validSettings, 'H:\\Vaults\\Other')).toEqual(validSettings);
  });
});
