import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { MigrationError } from './errors';

/** 迁移结果；不包含密码或完整路径。 / Migration result; contains neither passwords nor full paths. */
export interface MigrationResult {
  files: number;
  directories: number;
  bytes: number;
}

function normalize(targetPath: string): string {
  return path.resolve(targetPath);
}

function sameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function requireDirectory(targetPath: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MigrationError(`${label} 必须是非链接目录。`);
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new MigrationError(`${label} 不存在或不可访问。`, { cause: error });
  }
}

async function requireNoReparseTree(targetPath: string, label: string): Promise<void> {
  const metadata = await lstat(targetPath).catch((error: unknown) => {
    throw new MigrationError(`${label} 不存在或不可访问。`, { cause: error });
  });
  if (metadata.isSymbolicLink()) {
    throw new MigrationError(`${label} 不能是符号链接或 junction。`);
  }
  if (!metadata.isDirectory()) {
    throw new MigrationError(`${label} 必须是目录。`);
  }
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    const childPath = path.join(targetPath, entry.name);
    const childMetadata = await lstat(childPath);
    if (childMetadata.isSymbolicLink()) {
      throw new MigrationError('源文件夹包含符号链接或 junction，迁移已停止。');
    }
    if (childMetadata.isDirectory()) {
      await requireNoReparseTree(childPath, label);
    } else if (!childMetadata.isFile()) {
      throw new MigrationError('源文件夹包含不支持的特殊文件，迁移已停止。');
    }
  }
}

async function hashFile(filePath: string): Promise<{ digest: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      hash.update(buffer);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve({ digest: hash.digest('hex'), bytes }));
  });
}

async function copyTree(sourcePath: string, destinationPath: string, result: MigrationResult): Promise<void> {
  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    const metadata = await lstat(sourceEntry);
    if (metadata.isSymbolicLink()) {
      throw new MigrationError('源文件夹在复制过程中出现符号链接，迁移已停止。');
    }
    if (metadata.isDirectory()) {
      await mkdir(destinationEntry);
      result.directories += 1;
      await copyTree(sourceEntry, destinationEntry, result);
      continue;
    }
    if (!metadata.isFile()) {
      throw new MigrationError('源文件夹包含不支持的特殊文件，迁移已停止。');
    }
    await copyFile(sourceEntry, destinationEntry, fsConstants.COPYFILE_EXCL);
    const [sourceHash, destinationHash] = await Promise.all([hashFile(sourceEntry), hashFile(destinationEntry)]);
    if (sourceHash.digest !== destinationHash.digest || sourceHash.bytes !== destinationHash.bytes) {
      throw new MigrationError('文件校验失败；源文件可能在迁移期间发生变化。');
    }
    result.files += 1;
    result.bytes += sourceHash.bytes;
  }
}

async function verifyTree(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceEntries = await readdir(sourcePath, { withFileTypes: true });
  const destinationEntries = await readdir(destinationPath, { withFileTypes: true });
  const destinationNames = new Set(destinationEntries.map((entry) => entry.name));
  if (sourceEntries.length !== destinationEntries.length || sourceEntries.some((entry) => !destinationNames.has(entry.name))) {
    throw new MigrationError('源文件夹与私密挂载目录内容不一致，未删除源文件。');
  }

  for (const entry of sourceEntries) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    const [sourceMetadata, destinationMetadata] = await Promise.all([lstat(sourceEntry), lstat(destinationEntry)]);
    if (sourceMetadata.isSymbolicLink() || destinationMetadata.isSymbolicLink()) {
      throw new MigrationError('源文件夹或私密挂载目录出现符号链接，未删除源文件。');
    }
    if (sourceMetadata.isDirectory() && destinationMetadata.isDirectory()) {
      await verifyTree(sourceEntry, destinationEntry);
      continue;
    }
    if (sourceMetadata.isFile() && destinationMetadata.isFile()) {
      const [sourceHash, destinationHash] = await Promise.all([hashFile(sourceEntry), hashFile(destinationEntry)]);
      if (sourceHash.digest !== destinationHash.digest || sourceHash.bytes !== destinationHash.bytes) {
        throw new MigrationError('源文件在删除前发生变化，未删除源文件。');
      }
      continue;
    }
    throw new MigrationError('源文件夹与私密挂载目录结构不一致，未删除源文件。');
  }
}

/**
 * 将源文件夹内容复制到空的明文挂载根并逐文件校验；不会删除源文件。
 * Copies a source folder into an empty plaintext mount root and verifies every file; never deletes the source.
 */
export async function migrateFolderContents(sourcePathInput: string, destinationPathInput: string): Promise<MigrationResult> {
  const sourcePath = normalize(sourcePathInput);
  const destinationPath = normalize(destinationPathInput);
  if (sourcePath === destinationPath || sameOrInside(sourcePath, destinationPath) || sameOrInside(destinationPath, sourcePath)) {
    throw new MigrationError('源文件夹与私密挂载目录不能相同或互相包含。');
  }
  await requireNoReparseTree(sourcePath, '源文件夹');
  await requireDirectory(destinationPath, '私密挂载目录');
  if ((await readdir(destinationPath)).length > 0) {
    throw new MigrationError('私密挂载目录不是空目录；为避免覆盖内容，迁移已停止。');
  }
  const result: MigrationResult = { files: 0, directories: 0, bytes: 0 };
  await copyTree(sourcePath, destinationPath, result);
  await verifyTree(sourcePath, destinationPath);
  return result;
}

/**
 * 仅允许删除控制 Vault 下的非根源文件夹；调用方必须先取得用户明确确认。
 * Deletes only a non-root source folder inside the control Vault; the caller must obtain explicit confirmation first.
 */
export async function removeMigratedSource(
  sourcePathInput: string,
  controlVaultPathInput: string,
  expectedDestinationPathInput?: string,
): Promise<void> {
  const sourcePath = normalize(sourcePathInput);
  const controlVaultPath = normalize(controlVaultPathInput);
  if (sourcePath === controlVaultPath || !sameOrInside(controlVaultPath, sourcePath)) {
    throw new MigrationError('只能删除控制 Vault 内的非根文件夹。');
  }
  await requireNoReparseTree(sourcePath, '待删除源文件夹');
  if (expectedDestinationPathInput) {
    const expectedDestinationPath = normalize(expectedDestinationPathInput);
    await requireDirectory(expectedDestinationPath, '私密挂载目录');
    await verifyTree(sourcePath, expectedDestinationPath);
  }
  await access(controlVaultPath, fsConstants.R_OK);
  await rm(sourcePath, { recursive: true, force: false });
}
