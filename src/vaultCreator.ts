import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt } from 'node:crypto';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { BridgeError } from './errors';
import { encodeRecoveryKey } from './recoveryKey';

const MASTERKEY_VERSION = 999;
const SCRYPT_COST = 1 << 15;
const SCRYPT_BLOCK_SIZE = 8;
const RAW_MASTERKEY_BYTES = 64;
const KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;

/** 可分类的 Vault 初始化错误。 / Classifiable Vault initialization error. */
export type VaultCreationErrorCode =
  | 'invalid-password'
  | 'invalid-target'
  | 'target-exists'
  | 'mount-exists'
  | 'staging-failed'
  | 'publish-failed';

/** Vault 初始化失败；错误消息不得包含密码、恢复密钥或原始主密钥。 / Vault initialization failure; messages never contain password, recovery key, or raw master key. */
export class VaultCreationError extends BridgeError {
  constructor(readonly creationCode: VaultCreationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, `vault-creation:${creationCode}`, options);
    this.name = 'VaultCreationError';
  }
}

/** 创建格式 8 密码型 Vault 所需的运行时参数；敏感字段绝不持久化。 / Runtime parameters for creating a Format 8 password vault; sensitive fields are never persisted. */
export interface CreateVaultParams {
  controlVaultPath: string;
  encryptedVaultPath: string;
  mountPath: string;
  password: string;
  recoveryWords: readonly string[];
}

/** 创建完成但尚未发布的 Vault；确认恢复密钥后调用 publish，否则调用 rollback。 / Vault created but not yet published; call publish after recovery-key acknowledgement, otherwise rollback. */
export interface CreateVaultResult {
  encryptedVaultPath: string;
  stagingPath: string;
  recoveryKey: string;
  publish(): Promise<void>;
  rollback(): Promise<void>;
}

/** 用于测试的随机源和文件系统边界；生产环境使用 Node 标准实现。 / Injectable random source and filesystem boundary for tests; production uses Node standard implementations. */
export interface VaultCreatorDependencies {
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
  fileSystem?: VaultCreatorFileSystem;
}

/** Vault 创建器所需的最小文件系统接口。 / Minimal filesystem interface required by the vault creator. */
export interface VaultCreatorFileSystem {
  access(targetPath: string, mode?: number): Promise<void>;
  lstat(targetPath: string): Promise<Stats>;
  mkdir(targetPath: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readFile(targetPath: string, encoding: BufferEncoding): Promise<string>;
  realpath(targetPath: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(targetPath: string, options: { recursive: true; force: true }): Promise<void>;
  writeFile(targetPath: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void>;
}

const defaultFileSystem: VaultCreatorFileSystem = {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
};

/** 密码必须按 NFC 规范化且至少 8 个 Unicode 码位。 / Passwords must be NFC-normalized and contain at least eight Unicode code points. */
export function validateNewVaultPassword(password: string, confirmation: string): string {
  const normalized = password.normalize('NFC');
  if (normalized !== confirmation.normalize('NFC')) {
    throw new VaultCreationError('invalid-password', '两次输入的密码不一致。');
  }
  if (Array.from(normalized).length < 8) {
    throw new VaultCreationError('invalid-password', '新 Vault 密码至少需要 8 个字符。');
  }
  return normalized;
}

/**
 * 在同级随机暂存目录生成最小 Cryptomator 格式 8 Vault。
 * Generate a minimal Cryptomator Format 8 vault in a random sibling staging directory.
 */
export async function createVault(
  params: CreateVaultParams,
  dependencies: VaultCreatorDependencies = {},
): Promise<CreateVaultResult> {
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const random = dependencies.randomBytes ?? randomBytes;
  const uuid = dependencies.randomUUID ?? randomUUID;
  const password = validateNewVaultPassword(params.password, params.password);
  const layout = await validateCreateVaultLayout(params, fileSystem);
  const stagingPath = path.join(layout.controlRoot, `.${path.basename(layout.encryptedVaultPath)}.creating-${uuid()}`);
  let rawMasterKey: Buffer | undefined;
  let recoveryKey = '';

  try {
    await ensureAbsent(stagingPath, fileSystem, 'staging-failed', '暂存目录已存在，请重试。');
    await fileSystem.mkdir(stagingPath);
    await fileSystem.mkdir(path.join(stagingPath, 'd'));

    rawMasterKey = random(RAW_MASTERKEY_BYTES);
    if (rawMasterKey.length !== RAW_MASTERKEY_BYTES) {
      throw new VaultCreationError('staging-failed', '随机源返回了无效的主密钥长度。');
    }
    const salt = random(8);
    if (salt.length !== 8) {
      throw new VaultCreationError('staging-failed', '随机源返回了无效的盐长度。');
    }

    const masterkeyJson = await createMasterkeyFile(password, rawMasterKey, salt);
    const vaultConfig = createVaultConfig(rawMasterKey, uuid());
    const rootHash = rootDirectoryHash(rawMasterKey);
    const rootCipherDirectory = path.join(stagingPath, 'd', rootHash.slice(0, 2), rootHash.slice(2));
    await fileSystem.mkdir(rootCipherDirectory, { recursive: true });
    await fileSystem.writeFile(path.join(stagingPath, 'masterkey.cryptomator'), masterkeyJson, { encoding: 'utf8' });
    await fileSystem.writeFile(path.join(stagingPath, 'vault.cryptomator'), vaultConfig, { encoding: 'utf8' });
    recoveryKey = encodeRecoveryKey(rawMasterKey, params.recoveryWords);
  } catch (error) {
    await cleanupStaging(stagingPath, fileSystem);
    if (error instanceof VaultCreationError) throw error;
    throw new VaultCreationError('staging-failed', '初始化密文 Vault 失败；暂存目录已清理。', { cause: error });
  } finally {
    rawMasterKey?.fill(0);
    rawMasterKey = undefined;
  }

  let finished = false;
  let result: CreateVaultResult;
  result = {
    encryptedVaultPath: layout.encryptedVaultPath,
    stagingPath,
    recoveryKey,
    publish: async (): Promise<void> => {
      if (finished) return;
      try {
        await ensureAbsent(layout.encryptedVaultPath, fileSystem, 'target-exists', '目标密文目录已存在，未覆盖任何内容。');
        await fileSystem.rename(stagingPath, layout.encryptedVaultPath);
        finished = true;
        recoveryKey = '';
        result.recoveryKey = '';
      } catch (error) {
        if (error instanceof VaultCreationError) throw error;
        throw new VaultCreationError('publish-failed', 'Vault 已创建在暂存目录，但无法发布到最终目录。请检查磁盘和权限后重试。', { cause: error });
      }
    },
    rollback: async (): Promise<void> => {
      if (finished) return;
      await cleanupStaging(stagingPath, fileSystem);
      finished = true;
      recoveryKey = '';
      result.recoveryKey = '';
    },
  };
  return result;
}

async function validateCreateVaultLayout(params: CreateVaultParams, fileSystem: VaultCreatorFileSystem): Promise<{
  controlRoot: string;
  encryptedVaultPath: string;
  mountPath: string;
}> {
  const controlRoot = path.resolve(params.controlVaultPath);
  const encryptedVaultPath = path.resolve(params.encryptedVaultPath);
  const mountPath = path.resolve(params.mountPath);
  if (samePath(encryptedVaultPath, mountPath) || path.dirname(encryptedVaultPath) !== controlRoot || path.dirname(mountPath) !== controlRoot) {
    throw new VaultCreationError('invalid-target', '密文目录和挂载目录必须是当前控制 Vault 根目录的直接子目录。');
  }
  await validateDirectory(controlRoot, fileSystem);
  await ensureAbsent(encryptedVaultPath, fileSystem, 'target-exists', '目标密文目录已存在，不能覆盖。');
  await ensureAbsent(mountPath, fileSystem, 'mount-exists', '明文挂载目录已存在，不能创建。');
  return { controlRoot, encryptedVaultPath, mountPath };
}

async function validateDirectory(targetPath: string, fileSystem: VaultCreatorFileSystem): Promise<void> {
  try {
    const metadata = await fileSystem.lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new VaultCreationError('invalid-target', '当前控制 Vault 必须是可写的非链接目录。');
    }
    await fileSystem.access(targetPath, fsConstants.W_OK);
    if (process.platform === 'win32') {
      const canonical = await fileSystem.realpath(targetPath);
      if (!samePath(canonical, targetPath)) {
        throw new VaultCreationError('invalid-target', '当前控制 Vault 不能是 junction 或 reparse 点。');
      }
    }
  } catch (error) {
    if (error instanceof VaultCreationError) throw error;
    throw new VaultCreationError('invalid-target', '当前控制 Vault 不存在、不可写或无法安全验证。', { cause: error });
  }
}

async function ensureAbsent(
  targetPath: string,
  fileSystem: VaultCreatorFileSystem,
  code: VaultCreationErrorCode,
  message: string,
): Promise<void> {
  try {
    await fileSystem.lstat(targetPath);
    throw new VaultCreationError(code, message);
  } catch (error) {
    if (error instanceof VaultCreationError) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') return;
    throw new VaultCreationError('invalid-target', '无法检查目标目录是否存在。', { cause: error });
  }
}

async function cleanupStaging(stagingPath: string, fileSystem: VaultCreatorFileSystem): Promise<void> {
  try {
    await fileSystem.rm(stagingPath, { recursive: true, force: true });
  } catch {
    // 保留原始失败原因；暂存目录名随机且仅位于已验证的控制 Vault 中。
  }
}

async function createMasterkeyFile(password: string, rawMasterKey: Buffer, salt: Buffer): Promise<string> {
  const kek = await deriveKek(password, salt);
  try {
    const encryptionKey = rawMasterKey.subarray(0, KEY_BYTES);
    const macKey = rawMasterKey.subarray(KEY_BYTES);
    const version = Buffer.alloc(4);
    version.writeInt32BE(MASTERKEY_VERSION);
    const versionMac = createHmac('sha256', macKey).update(version).digest();
    return JSON.stringify({
      version: MASTERKEY_VERSION,
      scryptSalt: salt.toString('base64'),
      scryptCostParam: SCRYPT_COST,
      scryptBlockSize: SCRYPT_BLOCK_SIZE,
      primaryMasterKey: aesKeyWrap(kek, encryptionKey).toString('base64'),
      hmacMasterKey: aesKeyWrap(kek, macKey).toString('base64'),
      versionMac: versionMac.toString('base64'),
    }, null, 2);
  } finally {
    kek.fill(0);
  }
}

function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

function aesKeyWrap(kek: Buffer, plaintext: Buffer): Buffer {
  if (plaintext.length < 16 || plaintext.length % 8 !== 0) {
    throw new VaultCreationError('staging-failed', '主密钥封装输入长度无效。');
  }
  // RFC 3394 AES Key Wrap。避免依赖 Electron/OpenSSL 未必暴露的 id-aes256-wrap 别名。
  // RFC 3394 AES Key Wrap. Avoids the id-aes256-wrap alias, which Electron/OpenSSL may not expose.
  let a = Buffer.alloc(8, 0xa6);
  const blocks = Array.from({ length: plaintext.length / 8 }, (_, index) => Buffer.from(plaintext.subarray(index * 8, index * 8 + 8)));
  try {
    for (let round = 0; round < 6; round++) {
      for (let index = 0; index < blocks.length; index++) {
        const encrypted = aesEcb(kek, Buffer.concat([a, blocks[index]]));
        const counter = Buffer.alloc(8);
        counter.writeUInt32BE(Math.floor(((blocks.length * round) + index + 1) / 0x1_0000_0000), 0);
        counter.writeUInt32BE(((blocks.length * round) + index + 1) >>> 0, 4);
        const nextA = Buffer.from(encrypted.subarray(0, 8));
        const nextBlock = Buffer.from(encrypted.subarray(8));
        xorInto(nextA, counter);
        a.fill(0);
        encrypted.fill(0);
        counter.fill(0);
        a = nextA;
        blocks[index].fill(0);
        blocks[index] = nextBlock;
      }
    }
    return Buffer.concat([a, ...blocks]);
  } finally {
    a.fill(0);
    for (const block of blocks) block.fill(0);
  }
}

function createVaultConfig(rawMasterKey: Buffer, id: string): string {
  const header = base64Url(JSON.stringify({ kid: 'masterkeyfile:masterkey.cryptomator', typ: 'JWT', alg: 'HS256' }));
  const payload = base64Url(JSON.stringify({ jti: id, format: 8, cipherCombo: 'SIV_GCM', shorteningThreshold: 220 }));
  const signed = `${header}.${payload}`;
  const signature = createHmac('sha256', rawMasterKey).update(signed).digest();
  return `${signed}.${base64Url(signature)}`;
}

function rootDirectoryHash(rawMasterKey: Buffer): string {
  const macKey = rawMasterKey.subarray(KEY_BYTES);
  const siv = s2v(macKey, Buffer.alloc(0));
  try {
    return base32(createHash('sha1').update(siv).digest());
  } finally {
    siv.fill(0);
  }
}

function s2v(macKey: Buffer, plaintext: Buffer): Buffer {
  const zero = Buffer.alloc(AES_BLOCK_BYTES);
  const d = aesCmac(macKey, zero);
  try {
    if (plaintext.length >= AES_BLOCK_BYTES) {
      const combined = Buffer.from(plaintext);
      xorInto(combined, d, combined.length - AES_BLOCK_BYTES);
      return aesCmac(macKey, combined);
    }
    const padded = Buffer.alloc(AES_BLOCK_BYTES);
    plaintext.copy(padded);
    padded[plaintext.length] = 0x80;
    xorInto(padded, dbl(d));
    return aesCmac(macKey, padded);
  } finally {
    zero.fill(0);
    d.fill(0);
  }
}

function aesCmac(key: Buffer, message: Buffer): Buffer {
  const l = aesEcb(key, Buffer.alloc(AES_BLOCK_BYTES));
  const k1 = dbl(l);
  const k2 = dbl(k1);
  const blockCount = Math.max(1, Math.ceil(message.length / AES_BLOCK_BYTES));
  const completeLastBlock = message.length > 0 && message.length % AES_BLOCK_BYTES === 0;
  let state: Buffer<ArrayBufferLike> = Buffer.alloc(AES_BLOCK_BYTES);
  for (let block = 0; block < blockCount - 1; block++) {
    const source = message.subarray(block * AES_BLOCK_BYTES, (block + 1) * AES_BLOCK_BYTES);
    xorInto(state, source);
    const next = aesEcb(key, state);
    state.fill(0);
    state = next;
  }
  const last = Buffer.alloc(AES_BLOCK_BYTES);
  const offset = (blockCount - 1) * AES_BLOCK_BYTES;
  message.copy(last, 0, offset, Math.min(offset + AES_BLOCK_BYTES, message.length));
  if (completeLastBlock) {
    xorInto(last, k1);
  } else {
    last[message.length - offset] = 0x80;
    xorInto(last, k2);
  }
  xorInto(state, last);
  const result = aesEcb(key, state);
  l.fill(0); k1.fill(0); k2.fill(0); state.fill(0); last.fill(0);
  return result;
}

function aesEcb(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function dbl(block: Buffer): Buffer {
  const result = Buffer.alloc(block.length);
  let carry = 0;
  for (let index = block.length - 1; index >= 0; index--) {
    const value = block[index];
    result[index] = ((value << 1) & 0xff) | carry;
    carry = (value & 0x80) === 0x80 ? 1 : 0;
  }
  if (carry) result[result.length - 1] ^= 0x87;
  return result;
}

function xorInto(target: Buffer, source: Buffer, offset = 0): void {
  for (let index = 0; index < source.length; index++) target[offset + index] ^= source[index];
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function base32(value: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let bitCount = 0;
  let result = '';
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      result += alphabet[(bits >>> (bitCount - 5)) & 0x1f];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) result += alphabet[(bits << (5 - bitCount)) & 0x1f];
  return result;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}
