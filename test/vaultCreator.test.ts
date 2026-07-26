import { createDecipheriv, createHmac, scryptSync } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeRecoveryKey } from '../src/recoveryKey';
import { createVault, validateNewVaultPassword, VaultCreationError } from '../src/vaultCreator';

const temporaryRoots: string[] = [];
const recoveryWords = Array.from({ length: 4096 }, (_, index) => `word${index.toString().padStart(4, '0')}`);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ocb-vault-'));
  temporaryRoots.push(root);
  return root;
}

function deterministicRandom(): (size: number) => Buffer {
  let value = 0;
  return (size) => Buffer.from(Array.from({ length: size }, () => value++ & 0xff));
}

function params(root: string) {
  return {
    controlVaultPath: root,
    encryptedVaultPath: path.join(root, 'Private.cryptomator'),
    mountPath: path.join(root, 'Private.cryptomator-mount'),
    password: 'test-password',
    recoveryWords,
  };
}

describe('Vault 创建器', () => {
  it('规范化密码并拒绝短密码或不一致确认', () => {
    expect(validateNewVaultPassword('e\u0301password', 'épassword')).toBe('épassword');
    expect(() => validateNewVaultPassword('short', 'short')).toThrow(VaultCreationError);
    expect(() => validateNewVaultPassword('test-password', 'different-password')).toThrow(VaultCreationError);
  });

  it('生成可验签且主密钥可解包的格式 8 暂存 Vault', async () => {
    const root = await createRoot();
    const result = await createVault(params(root), {
      randomBytes: deterministicRandom(),
      randomUUID: () => '11111111-2222-3333-4444-555555555555',
    });

    const masterkey = JSON.parse(await readFile(path.join(result.stagingPath, 'masterkey.cryptomator'), 'utf8')) as Record<string, string | number>;
    const salt = Buffer.from(masterkey.scryptSalt as string, 'base64');
    const kek = scryptSync('test-password', salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const unwrap = (wrapped: string) => {
      const decipher = createDecipheriv('id-aes256-wrap', kek, Buffer.alloc(8, 0xa6));
      return Buffer.concat([decipher.update(Buffer.from(wrapped, 'base64')), decipher.final()]);
    };
    const primary = unwrap(masterkey.primaryMasterKey as string);
    const hmac = unwrap(masterkey.hmacMasterKey as string);
    expect(Buffer.concat([primary, hmac])).toEqual(Buffer.from(Array.from({ length: 64 }, (_, index) => index)));
    expect(createHmac('sha256', hmac).update(Buffer.from([0, 0, 3, 231])).digest('base64')).toBe(masterkey.versionMac);

    const config = await readFile(path.join(result.stagingPath, 'vault.cryptomator'), 'utf8');
    const [header, payload, signature] = config.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toMatchObject({
      format: 8,
      cipherCombo: 'SIV_GCM',
      shorteningThreshold: 220,
    });
    expect(createHmac('sha256', Buffer.concat([primary, hmac])).update(`${header}.${payload}`).digest('base64url')).toBe(signature);
    const rootPrefix = (await readdir(path.join(result.stagingPath, 'd')))[0];
    expect(rootPrefix).toMatch(/^[A-Z2-7]{2}$/u);
    const rootRest = (await readdir(path.join(result.stagingPath, 'd', rootPrefix)))[0];
    expect(rootRest).toMatch(/^[A-Z2-7]{30}$/u);
    expect(result.recoveryKey.split(' ')).toHaveLength(44);
    expect(result.recoveryKey).not.toContain(primary.toString('hex'));
    await result.rollback();
    expect(result.recoveryKey).toBe('');
  });

  it('拒绝已存在的目标密文或挂载目录', async () => {
    const root = await createRoot();
    await mkdir(path.join(root, 'Private.cryptomator'));
    await expect(createVault(params(root))).rejects.toMatchObject({ creationCode: 'target-exists' });
    await rm(path.join(root, 'Private.cryptomator'), { recursive: true });
    await mkdir(path.join(root, 'Private.cryptomator-mount'));
    await expect(createVault(params(root))).rejects.toMatchObject({ creationCode: 'mount-exists' });
  });

  it('初始化失败时只清理本次随机暂存目录', async () => {
    const root = await createRoot();
    const input = { ...params(root), recoveryWords: ['not-enough'] };
    await expect(createVault(input, { randomUUID: () => 'fixed' })).rejects.toMatchObject({ creationCode: 'staging-failed' });
    expect((await readdir(root)).filter((name) => name.includes('.creating-fixed'))).toEqual([]);
  });

  it('可注入文件系统边界，并在写入失败后清理暂存目录', async () => {
    const root = await createRoot();
    await expect(createVault(params(root), {
      randomUUID: () => 'fs-failure',
      fileSystem: {
        access,
        lstat,
        mkdir,
        readFile,
        realpath,
        rename,
        rm,
        writeFile: async (targetPath, data, options) => {
          if (targetPath.endsWith('vault.cryptomator')) throw new Error('injected write failure');
          await writeFile(targetPath, data, options);
        },
      },
    })).rejects.toMatchObject({ creationCode: 'staging-failed' });
    expect((await readdir(root)).filter((name) => name.includes('.creating-fs-failure'))).toEqual([]);
  });

  it('设置登记失败时保留已经发布的密文 Vault', async () => {
    const root = await createRoot();
    const result = await createVault(params(root), { randomUUID: () => 'published' });
    await result.publish();
    await expect(Promise.reject(new Error('save failed'))).rejects.toThrow('save failed');
    expect(await readFile(path.join(result.encryptedVaultPath, 'vault.cryptomator'), 'utf8')).toContain('.');
  });

  it('恢复短语使用 44 个 12 位词索引并校验输入长度', () => {
    const key = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
    expect(encodeRecoveryKey(key, recoveryWords).split(' ')).toHaveLength(44);
    expect(() => encodeRecoveryKey(key, recoveryWords.slice(1))).toThrow();
  });
});
