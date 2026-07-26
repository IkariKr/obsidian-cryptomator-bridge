import { readFile, readdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { ConfigurationError } from './errors';

const WORD_COUNT = 4096;
const KEY_BYTES = 64;
const PADDED_KEY_BYTES = 66;

/**
 * 将原始主密钥编码为 Cryptomator Desktop 可识别的恢复短语。
 * Encode a raw master key as a recovery phrase accepted by Cryptomator Desktop.
 */
export function encodeRecoveryKey(rawMasterKey: Uint8Array, words: readonly string[]): string {
  if (rawMasterKey.length !== KEY_BYTES) {
    throw new ConfigurationError('恢复密钥编码需要 64 字节原始主密钥。');
  }
  if (words.length !== WORD_COUNT || words.some((word) => !word.trim())) {
    throw new ConfigurationError('Cryptomator Desktop 恢复词表无效。');
  }

  const padded = Buffer.alloc(PADDED_KEY_BYTES);
  Buffer.from(rawMasterKey).copy(padded);
  padded.writeUInt16BE(crc32(rawMasterKey) >>> 16, KEY_BYTES);

  const result: string[] = [];
  for (let offset = 0; offset < padded.length; offset += 3) {
    const firstIndex = (padded[offset] << 4) | (padded[offset + 1] >>> 4);
    const secondIndex = ((padded[offset + 1] & 0x0f) << 8) | padded[offset + 2];
    result.push(words[firstIndex], words[secondIndex]);
  }
  padded.fill(0);
  return result.join(' ');
}

/**
 * 从用户已安装的 Cryptomator Desktop 读取恢复词表；插件绝不打包该 GPL 资源。
 * Read the recovery word list from the user's Cryptomator Desktop; the plugin never bundles this GPL resource.
 */
export async function loadDesktopRecoveryWords(): Promise<string[]> {
  const candidates = desktopWordlistCandidates();
  for (const candidate of candidates) {
    try {
      const text = await readFile(candidate, 'utf8');
      const words = text.split(/\r?\n/u).map((word) => word.trim()).filter(Boolean);
      if (words.length === WORD_COUNT) {
        return words;
      }
    } catch {
      // 继续检查下一个标准安装位置。
    }
  }
  for (const jarPath of await desktopJarCandidates()) {
    try {
      const words = parseWords(await readJarResource(jarPath, 'i18n/4096words_en.txt'));
      if (words.length === WORD_COUNT) return words;
    } catch {
      // 安装包可能不含目标资源，继续检查下一个 JAR。
    }
  }
  throw new ConfigurationError('未找到 Cryptomator Desktop 的恢复词表；请安装 Cryptomator Desktop 后重试。');
}

function desktopWordlistCandidates(): string[] {
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const result = new Set<string>();
  for (const base of programFiles) {
    for (const appRoot of [path.join(base, 'Cryptomator'), path.join(base, 'Programs', 'Cryptomator')]) {
      result.add(path.join(appRoot, 'resources', 'app.asar', 'i18n', '4096words_en.txt'));
      result.add(path.join(appRoot, 'resources', 'app', 'i18n', '4096words_en.txt'));
    }
  }
  return [...result];
}

async function desktopJarCandidates(): Promise<string[]> {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value))
    .flatMap((base) => [
      path.join(base, 'Cryptomator', 'app'),
      path.join(base, 'Cryptomator', 'app', 'mods'),
      path.join(base, 'Programs', 'Cryptomator', 'app'),
      path.join(base, 'Programs', 'Cryptomator', 'app', 'mods'),
    ]);
  const jars: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.jar')) jars.push(path.join(root, entry.name));
      }
    } catch {
      // 标准安装目录不存在，继续检查下一个。
    }
  }
  return jars;
}

function parseWords(text: Buffer): string[] {
  return text.toString('utf8').split(/\r?\n/u).map((word) => word.trim()).filter(Boolean);
}

async function readJarResource(jarPath: string, resourceName: string): Promise<Buffer> {
  const archive = await readFile(jarPath);
  const directoryOffset = findCentralDirectoryOffset(archive);
  let cursor = directoryOffset;
  while (cursor < archive.length && archive.readUInt32LE(cursor) === 0x02014b50) {
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const fileName = archive.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    if (fileName === resourceName) {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new ConfigurationError('Cryptomator Desktop 安装包损坏。');
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(compressed);
      if (method === 8) return inflateRawSync(compressed);
      throw new ConfigurationError('Cryptomator Desktop 恢复词表使用了不支持的压缩格式。');
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new ConfigurationError('Cryptomator Desktop 安装包中没有恢复词表。');
}

function findCentralDirectoryOffset(archive: Buffer): number {
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
    if (archive.readUInt32LE(index) === 0x06054b50) return archive.readUInt32LE(index + 16);
  }
  throw new ConfigurationError('Cryptomator Desktop 安装包不是有效的 JAR 文件。');
}

function crc32(input: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
