import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, validateSettings } from '../src/settings';

const validSettings = {
  schemaVersion: 1,
  cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
  encryptedVaultPath: 'C:\\Vault',
  mountPath: 'C:\\Mount',
  mounterId: 'WinFspMountProvider',
  privateVaultName: 'Private Vault',
};

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
    expect(validateSettings({ ...validSettings, schemaVersion: 2 }).valid).toBe(false);
  });

  it('migrates a versionless first-release configuration to schema v1', () => {
    const { schemaVersion: _schemaVersion, ...legacySettings } = validSettings;
    expect(loadSettings(legacySettings)).toEqual(validSettings);
  });

  it('trims configured values', () => {
    const result = loadSettings({
      ...validSettings,
      cliPath: '  C:\\Cryptomator\\cryptomator-cli.exe  ',
    });
    expect(result.cliPath).toBe('C:\\Cryptomator\\cryptomator-cli.exe');
  });
});
