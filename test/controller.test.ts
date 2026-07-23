import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeController } from '../src/controller';
import type { BridgeSettings } from '../src/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function settings(mountPath: string): BridgeSettings {
  return {
    schemaVersion: 1,
    cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
    encryptedVaultPath: 'C:\\Vault',
    mountPath,
    mounterId: 'WinFspMountProvider',
    privateVaultName: 'Private Test Vault',
  };
}

function prerequisiteResult(current: BridgeSettings) {
  return {
    cliVersion: '0.6.2',
    mounters: [current.mounterId],
    warnings: [],
    normalizedSettings: {
      cliPath: current.cliPath,
      encryptedVaultPath: current.encryptedVaultPath,
      mountPath: current.mountPath,
    },
  };
}

describe('bridge controller', () => {
  it('reconciles, unlocks, opens, and locks through owned supervisor calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-controller-'));
    roots.push(root);
    const current = settings(path.join(root, 'mount'));
    const supervisor = {
      ownsProcess: false,
      unlock: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    let opened = '';
    const controller = new BridgeController({
      getSettings: () => current,
      getCurrentVaultPath: () => undefined,
      supervisor,
      launcher: { open: (name: string) => { opened = name; return name; } } as never,
      prerequisiteChecker: async () => prerequisiteResult(current),
    });

    await controller.reconcile();
    expect(controller.state.state).toBe('idle');
    const testInput = 'x'.repeat(8);
    await controller.unlock(testInput, async () => true);
    expect(controller.state.state).toBe('mounted');
    expect(opened).toBe(current.privateVaultName);
    expect(supervisor.unlock).toHaveBeenCalledWith(expect.objectContaining({ mountPath: current.mountPath }), testInput);
    await controller.lock();
    expect(controller.state.state).toBe('idle');
    expect(supervisor.stop).toHaveBeenCalledWith(current.mountPath);
  });

  it('requires confirmation for prerequisite warnings and enters error on cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-controller-'));
    roots.push(root);
    const current = settings(path.join(root, 'mount'));
    const supervisor = {
      ownsProcess: false,
      unlock: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      cleanup: vi.fn(async () => undefined),
    };
    const controller = new BridgeController({
      getSettings: () => current,
      getCurrentVaultPath: () => undefined,
      supervisor,
      prerequisiteChecker: async () => ({ ...prerequisiteResult(current), warnings: ['sync-root-warning'] }),
    });
    await controller.reconcile();
    await expect(controller.unlock('x'.repeat(8), async () => false)).rejects.toThrow('同步目录风险确认');
    expect(controller.state.state).toBe('error');
    expect(supervisor.unlock).not.toHaveBeenCalled();
  });

  it('does not claim an accessible mount without an owned process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-controller-'));
    roots.push(root);
    const mountPath = path.join(root, 'mount');
    await mkdir(mountPath);
    const current = settings(mountPath);
    const controller = new BridgeController({
      getSettings: () => current,
      getCurrentVaultPath: () => undefined,
    });
    await expect(controller.reconcile()).rejects.toThrow('无主挂载');
    expect(controller.state.state).toBe('error');
  });
});
