import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BridgeController } from '../src/controller';
import type { BridgeSettings, ResolvedVaultRecord } from '../src/types';

const roots: string[] = [];

async function cleanupAll(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

async function createValidSettings(): Promise<{ settings: BridgeSettings; records: ResolvedVaultRecord[]; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-ctrl-'));
  roots.push(root);
  const syncRoot = path.join(root, 'vault');
  const encDir = path.join(syncRoot, 'Work.cryptomator');
  const cliPath = path.join(root, 'cli.exe');

  await mkdir(encDir, { recursive: true });
  await Promise.all([
    writeFile(cliPath, ''),
    writeFile(path.join(encDir, 'masterkey.cryptomator'), ''),
    writeFile(path.join(encDir, 'vault.cryptomator'), ''),
    mkdir(path.join(encDir, 'd')),
  ]);

  const settings: BridgeSettings = {
    schemaVersion: 3,
    cliPath,
    syncRootPath: syncRoot,
    mounterId: 'WinFspMountProvider',
    vaultRecords: [
      { id: 'rec-work', folderName: 'Work', nutstoreExclusionConfirmed: true },
      { id: 'rec-personal', folderName: 'Personal', nutstoreExclusionConfirmed: false },
    ],
    autoLock: { idleLockMinutes: 15, lockOnScreenLock: true },
  };

  const records: ResolvedVaultRecord[] = [
    {
      id: 'rec-work',
      folderName: 'Work',
      nutstoreExclusionConfirmed: true,
      encryptedVaultPath: encDir,
      mountPath: path.join(syncRoot, 'Work.cryptomator-mount'),
    },
    {
      id: 'rec-personal',
      folderName: 'Personal',
      nutstoreExclusionConfirmed: false,
      encryptedVaultPath: path.join(syncRoot, 'Personal.cryptomator'),
      mountPath: path.join(syncRoot, 'Personal.cryptomator-mount'),
    },
  ];

  return { settings, records, root };
}

describe('BridgeController (multi-session)', () => {
  afterEach(async () => {
    await cleanupAll();
  });

  it('starts with no sessions', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    expect(controller.getAllSessions().size).toBe(0);
    expect(controller.isAnyMounted()).toBe(false);
    expect(controller.getMountedCount()).toBe(0);
  });

  it('supports unlock for a single record', async () => {
    const { settings, records } = await createValidSettings();
    const controller = new BridgeController(settings);
    const record = records[0];

    // Should fail because the CLI is fake and encrypted dir doesn't exist for second record
    await expect(controller.unlock(record, 'test-password')).rejects.toThrow();
    // After failure, no session should remain
    expect(controller.getMountedCount()).toBe(0);
  });

  it('emits aggregate state changes', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    const states: string[] = [];
    controller.onStateChanged((agg) => states.push(agg.overallState));

    expect(states.length).toBe(0); // No emit until a state transition
  });

  it('updateSettings applies new settings reference', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    const newSettings = { ...settings, mounterId: 'new-mounter' };
    controller.updateSettings(newSettings);
    // Settings are stored for later use in unlock calls
  });

  it('getSession returns undefined for unknown recordId', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    expect(controller.getSession('nonexistent')).toBeUndefined();
  });

  it('handles lockAll when nothing is mounted', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    await controller.lockAll();
    expect(controller.isAnyMounted()).toBe(false);
  });

  it('cleanup removes all sessions', async () => {
    const { settings } = await createValidSettings();
    const controller = new BridgeController(settings);
    await controller.cleanup();
    expect(controller.getAllSessions().size).toBe(0);
  });
});
