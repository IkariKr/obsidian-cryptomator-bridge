import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from './errors';
import type { BridgeSettings, ResolvedBridgeSettings } from './types';

/** 路径校验输入。 / Input for path validation. */
export interface PathValidationInput {
  settings: BridgeSettings;
  currentObsidianVaultPath?: string;
}

/** 路径校验的脱敏结果。 / Redacted result of path validation. */
export interface PathValidationResult extends Pick<ResolvedBridgeSettings, 'cliPath' | 'syncRootPath' | 'encryptedVaultRelativePath' | 'encryptedVaultPath' | 'mountPath'> {
  warnings: string[];
}

function normalizeWindowsPath(value: string): string {
  return path.resolve(value);
}

function sameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function requireRegularFile(filePath: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new ConfigurationError(`${label} 不存在或不可访问。`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(`${label} 必须是非链接文件。`);
  }
}

async function requireDirectory(directoryPath: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(directoryPath);
  } catch {
    throw new ConfigurationError(`${label} 不存在或不可访问。`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(`${label} 必须是非链接目录。`);
  }
}

async function requireNoReparsePath(targetPath: string, label: string): Promise<void> {
  const parsed = path.parse(targetPath);
  const segments = targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new ConfigurationError(`${label} 或其父路径不能经过 junction/reparse point。`);
      }

      const resolved = await realpath(current);
      if (normalizeWindowsPath(resolved).toLowerCase() !== normalizeWindowsPath(current).toLowerCase()) {
        throw new ConfigurationError(`${label} 或其父路径不能经过 junction/reparse point。`);
      }
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      // The final mount node may not exist; its existing ancestors were checked.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw new ConfigurationError(`${label} 或其父路径不可访问。`);
    }
  }
}

function knownSyncRoots(): string[] {
  const candidates = [
    process.env.OneDrive,
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.Dropbox,
    process.env.GoogleDrive,
    process.env.GoogleDriveFS,
    path.join(os.homedir(), 'OneDrive'),
    path.join(os.homedir(), 'Dropbox'),
  ];
  return candidates.filter(Boolean).map((candidate) => normalizeWindowsPath(candidate as string).toLowerCase());
}

function isKnownSyncPath(candidate: string): boolean {
  return knownSyncRoots().some((root) => sameOrInside(root, candidate.toLowerCase()));
}

function requireNonRoot(candidate: string, label: string): void {
  if (candidate.toLowerCase() === path.parse(candidate).root.toLowerCase()) {
    throw new ConfigurationError(`${label} 不能是盘符或文件系统根目录。`);
  }
}

function resolveEncryptedVaultPath(syncRootPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath === '.' || relativePath === '..') {
    throw new ConfigurationError('密文 Vault 相对路径必须是同步根目录内的相对路径。');
  }
  const encryptedVaultPath = normalizeWindowsPath(path.resolve(syncRootPath, relativePath));
  if (!sameOrInside(syncRootPath, encryptedVaultPath)) {
    throw new ConfigurationError('密文 Vault 相对路径不能离开同步根目录。');
  }
  return encryptedVaultPath;
}

/**
 * 校验 CLI、密文 Vault 和 WinFsp 挂载目标；不会创建或清理用户目录。
 * Validate the CLI, encrypted vault, and WinFsp mount target; never creates or removes user directories.
 */
export async function validatePaths(input: PathValidationInput): Promise<PathValidationResult> {
  const { settings, currentObsidianVaultPath } = input;
  if (!settings.privateVaultName || /[\\/\0]/u.test(settings.privateVaultName)) {
    throw new ConfigurationError('privateVaultName 必须是已注册的单一 Vault 名称。');
  }

  const cliPath = normalizeWindowsPath(settings.cliPath);
  const syncRootPath = normalizeWindowsPath(settings.syncRootPath);
  const encryptedVaultRelativePath = settings.encryptedVaultRelativePath.trim();
  const encryptedVaultPath = resolveEncryptedVaultPath(syncRootPath, encryptedVaultRelativePath);
  const mountPath = normalizeWindowsPath(settings.mountPath);
  requireNonRoot(syncRootPath, '同步根目录');
  requireNonRoot(encryptedVaultPath, '密文 Vault 路径');
  requireNonRoot(mountPath, '挂载路径');
  if (sameOrInside(encryptedVaultPath, mountPath) || sameOrInside(mountPath, encryptedVaultPath)) {
    throw new ConfigurationError('密文 Vault 与挂载路径不能相同或互相包含。');
  }

  await requireRegularFile(cliPath, 'Cryptomator CLI 路径');
  await requireDirectory(syncRootPath, '同步根目录');
  await requireDirectory(encryptedVaultPath, '密文 Vault 路径');
  await requireNoReparsePath(cliPath, 'Cryptomator CLI 路径');
  await requireNoReparsePath(syncRootPath, '同步根目录');
  await requireNoReparsePath(encryptedVaultPath, '密文 Vault 路径');

  if (currentObsidianVaultPath) {
    const currentVault = normalizeWindowsPath(currentObsidianVaultPath);
    if (!sameOrInside(currentVault, syncRootPath)) {
      throw new ConfigurationError('使用 Nutstore Obsidian 插件时，同步根目录必须位于当前控制 Vault 内。');
    }
    if (sameOrInside(currentVault, mountPath)) {
      throw new ConfigurationError('挂载路径不能位于当前 Obsidian Vault 内。');
    }
  }

  try {
    await lstat(mountPath);
    throw new ConfigurationError('WinFspMountProvider 要求挂载路径节点预先不存在。');
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigurationError('挂载路径不可访问。');
    }
  }

  const mountParent = path.dirname(mountPath);
  await requireDirectory(mountParent, '挂载路径父目录');
  await requireNoReparsePath(mountParent, '挂载路径');
  try {
    await access(mountParent, fsConstants.W_OK);
  } catch {
    throw new ConfigurationError('挂载路径父目录不可写。');
  }

  const warnings: string[] = [];
  if (sameOrInside(syncRootPath, mountPath) || isKnownSyncPath(mountPath)) {
    throw new ConfigurationError('挂载路径位于已知同步根目录内；只能把密文 Vault 放入同步目录。');
  }
  warnings.push('无法由通用算法识别所有同步服务；请确认挂载路径不在任何同步根目录内。');

  return { cliPath, syncRootPath, encryptedVaultRelativePath, encryptedVaultPath, mountPath, warnings };
}
