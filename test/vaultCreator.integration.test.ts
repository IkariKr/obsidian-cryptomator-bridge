import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliSupervisor } from '../src/cliSupervisor';
import { loadDesktopRecoveryWords } from '../src/recoveryKey';
import { createVault } from '../src/vaultCreator';

const shouldRun = process.env.RUN_CRYPTOMATOR_INTEGRATION === '1' && Boolean(process.env.CRYPTOMATOR_CLI_PATH);
const integration = shouldRun ? describe : describe.skip;
const roots: string[] = [];
const recoveryWords = Array.from({ length: 4096 }, (_, index) => `testword${index.toString().padStart(4, '0')}`);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((target) => rm(target, { recursive: true, force: true, maxRetries: 3 })));
});

integration('Cryptomator CLI 0.6.2 创建集成', () => {
  it('从已安装的 Cryptomator Desktop 读取恢复词表', async () => {
    expect(await loadDesktopRecoveryWords()).toHaveLength(4096);
  });

  it('创建、解锁、写入并锁定一次性格式 8 Vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocb-cryptomator-integration-'));
    roots.push(root);
    const encryptedVaultPath = path.join(root, 'Integration.cryptomator');
    const mountPath = path.join(root, 'Integration.cryptomator-mount');
    const creation = await createVault({
      controlVaultPath: root,
      encryptedVaultPath,
      mountPath,
      password: 'integration-test-password',
      recoveryWords,
    });
    await creation.publish();

    const supervisor = new CliSupervisor();
    await supervisor.unlock({
      cliPath: process.env.CRYPTOMATOR_CLI_PATH!,
      encryptedVaultPath,
      mountPath,
      mounterId: process.env.CRYPTOMATOR_MOUNTER_ID ?? 'org.cryptomator.frontend.fuse.mount.WinFspMountProvider',
    }, 'integration-test-password');
    await writeFile(path.join(mountPath, 'probe.txt'), 'ok', 'utf8');
    expect(await readFile(path.join(mountPath, 'probe.txt'), 'utf8')).toBe('ok');
    await supervisor.stop(mountPath);
    await expect(access(mountPath)).rejects.toThrow();
  }, 60_000);
});
