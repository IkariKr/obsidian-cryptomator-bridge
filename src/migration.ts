import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { MigrationError } from './errors';

const MOUNT_READY_TIMEOUT_MS = 10_000;
const MOUNT_READY_POLL_MS = 200;
const execFileAsync = promisify(execFile);

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

async function waitForReadableMountDirectory(targetPath: string): Promise<string[]> {
  const deadline = Date.now() + MOUNT_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readdir(targetPath);
    } catch (error) {
      lastError = error;
      // WinFsp 的目录挂载在某些 Node/libuv 版本中会稳定返回 ENOENT；无需空等十秒。
      // Some Node/libuv versions consistently return ENOENT for WinFsp directory mounts; do not wait needlessly.
      if (shouldUseWindowsNativeMountFallback(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, MOUNT_READY_POLL_MS));
    }
  }
  throw new MigrationError('私密挂载目录尚未就绪或已断开，请确认 Vault 仍处于解锁状态后重试。', { cause: lastError });
}

/**
 * 判断是否命中 WinFsp 目录挂载与 Node/libuv 的已知枚举不兼容。
 * Detect the WinFsp directory-mount enumeration incompatibility in Node/libuv.
 */
export function shouldUseWindowsNativeMountFallback(error: unknown): boolean {
  if (process.platform !== 'win32' || !error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === 'ENOENT' || candidate.code === 'UNKNOWN') {
    return true;
  }
  return shouldUseWindowsNativeMountFallback(candidate.cause);
}

type WindowsNativeMigrationMode = 'copy' | 'verify';

interface WindowsNativeMigrationResult extends MigrationResult {
  mode: WindowsNativeMigrationMode;
}

function createWindowsNativeMigrationCommand(
  mode: WindowsNativeMigrationMode,
  sourcePath: string,
  destinationPath: string,
): string {
  const payload = Buffer.from(JSON.stringify({ mode, sourcePath, destinationPath }), 'utf8').toString('base64');
  // 所有用户路径作为 Base64 JSON 数据传入，不会参与 PowerShell 语法解析。
  // User paths enter as Base64 JSON data and never take part in PowerShell parsing.
  return `$ErrorActionPreference = 'Stop'
$payload = '${payload}'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
$source = [string]$request.sourcePath
$destination = [string]$request.destinationPath

function Assert-Directory([string]$target, [string]$label) {
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "$label 不存在或不可访问。" }
}

function Assert-NoReparseTree([string]$target, [string]$label) {
  $items = @(Get-ChildItem -LiteralPath $target -Force -Recurse)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$label 包含符号链接或 junction，迁移已停止。"
    }
    if (-not $item.PSIsContainer -and -not ($item -is [IO.FileInfo])) {
      throw "$label 包含不支持的特殊文件，迁移已停止。"
    }
  }
  return $items
}

function Relative-ChildPath([string]$root, [string]$child) {
  return $child.Substring($root.TrimEnd('\\').Length).TrimStart('\\')
}

Assert-Directory $source '源文件夹'
Assert-Directory $destination '私密挂载目录'
$sourceItems = @(Assert-NoReparseTree $source '源文件夹')
$destinationItems = @(Get-ChildItem -LiteralPath $destination -Force)
if ($request.mode -eq 'copy' -and $destinationItems.Count -ne 0) {
  throw '私密挂载目录不是空目录；为避免覆盖内容，迁移已停止。'
}

$directories = @($sourceItems | Where-Object { $_.PSIsContainer })
$files = @($sourceItems | Where-Object { -not $_.PSIsContainer })
if ($request.mode -eq 'copy') {
  foreach ($directory in $directories) {
    $target = Join-Path $destination (Relative-ChildPath $source $directory.FullName)
    [IO.Directory]::CreateDirectory($target) | Out-Null
  }
  foreach ($file in $files) {
    $target = Join-Path $destination (Relative-ChildPath $source $file.FullName)
    [IO.File]::Copy($file.FullName, $target, $false)
  }
}

$actualItems = @(Get-ChildItem -LiteralPath $destination -Force -Recurse)
foreach ($item in $actualItems) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw '私密挂载目录出现符号链接或 junction，未删除源文件。'
  }
}
if ($actualItems.Count -ne $sourceItems.Count) {
  throw '源文件夹与私密挂载目录内容不一致，未删除源文件。'
}
foreach ($directory in $directories) {
  $target = Join-Path $destination (Relative-ChildPath $source $directory.FullName)
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw '源文件夹与私密挂载目录结构不一致，未删除源文件。'
  }
}
foreach ($file in $files) {
  $target = Join-Path $destination (Relative-ChildPath $source $file.FullName)
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw '源文件夹与私密挂载目录结构不一致，未删除源文件。'
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash) {
    throw '文件校验失败；源文件可能在迁移期间发生变化。'
  }
}
$bytes = [Int64](($files | Measure-Object -Property Length -Sum).Sum)
[Console]::Out.WriteLine(([pscustomobject]@{ mode = [string]$request.mode; files = $files.Count; directories = $directories.Count; bytes = $bytes } | ConvertTo-Json -Compress))`;
}

async function runWindowsNativeMigration(
  mode: WindowsNativeMigrationMode,
  sourcePath: string,
  destinationPath: string,
): Promise<MigrationResult> {
  try {
    const command = createWindowsNativeMigrationCommand(mode, sourcePath, destinationPath);
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand,
    ], {
      windowsHide: true,
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024,
    });
    const result = JSON.parse(stdout.trim()) as WindowsNativeMigrationResult;
    if (result.mode !== mode || !Number.isSafeInteger(result.files) || !Number.isSafeInteger(result.directories) || !Number.isSafeInteger(result.bytes)) {
      throw new Error('Windows 原生迁移未返回有效结果。');
    }
    return { files: result.files, directories: result.directories, bytes: result.bytes };
  } catch (error) {
    throw new MigrationError('私密挂载目录无法通过 Node 读取，且 Windows 原生迁移也未完成；请锁定后重新解锁再试。', { cause: error });
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
  let destinationEntries: string[];
  try {
    destinationEntries = await waitForReadableMountDirectory(destinationPath);
  } catch (error) {
    if (shouldUseWindowsNativeMountFallback(error)) {
      return runWindowsNativeMigration('copy', sourcePath, destinationPath);
    }
    throw error;
  }
  if (destinationEntries.length > 0) {
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
    try {
      await verifyTree(sourcePath, expectedDestinationPath);
    } catch (error) {
      if (shouldUseWindowsNativeMountFallback(error)) {
        await runWindowsNativeMigration('verify', sourcePath, expectedDestinationPath);
      } else {
        throw error;
      }
    }
  }
  await access(controlVaultPath, fsConstants.R_OK);
  await rm(sourcePath, { recursive: true, force: false });
}
