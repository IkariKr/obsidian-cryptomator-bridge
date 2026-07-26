import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { platform } from 'node:os';
import { RedactedDiagnostics } from './diagnostics';

const PROBE_TIMEOUT_MS = 10_000;

/** 首版只接受阶段 0 已验证的 CLI 版本。 / Version verified by phase 0 for the first release. */
export const SUPPORTED_CLI_VERSION = '0.6.2' as const;

/** 同级目录挂载唯一支持的 WinFsp 挂载器。 / The only WinFsp mounter supported for sibling-directory mounts. */
export const FOLDER_MOUNT_MOUNTER_ID = 'org.cryptomator.frontend.fuse.mount.WinFspMountProvider' as const;

/** 旧版本错误自动选择的盘符挂载器；不能用于同级目录布局。 / Legacy drive-letter mounter incorrectly auto-selected by earlier versions; incompatible with sibling-directory layout. */
export const LEGACY_NETWORK_MOUNTER_ID = 'org.cryptomator.frontend.fuse.mount.WinFspNetworkMountProvider' as const;

/**
 * 仅将旧的错误默认值迁移为已发现的目录挂载器；不覆盖用户的其他显式选择。
 * Migrate only the legacy incorrect default to a discovered folder mounter; never overwrite other explicit choices.
 */
export function migrateLegacyMounterId(currentMounterId: string, discoveredMounters: readonly string[]): string {
  if (
    (!currentMounterId || currentMounterId === LEGACY_NETWORK_MOUNTER_ID)
    && discoveredMounters.includes(FOLDER_MOUNT_MOUNTER_ID)
  ) {
    return FOLDER_MOUNT_MOUNTER_ID;
  }
  return currentMounterId;
}

/** CLI 可执行文件名（Win）。 / CLI executable name (Win). */
const CLI_EXE_NAME = 'cryptomator-cli.exe' as const;

/** Program Files 下的固定候选路径。 / Fixed candidate paths under Program Files. */
const PROGRAM_FILES_CANDIDATES = [
  'C:\\Program Files\\Cryptomator\\cryptomator-cli.exe',
  'C:\\Program Files\\Cryptomator\\CryptomatorCLI.exe',
  'C:\\Program Files (x86)\\Cryptomator\\cryptomator-cli.exe',
  'C:\\Program Files (x86)\\Cryptomator\\CryptomatorCLI.exe',
];

/** %LOCALAPPDATA% 下的候选基目录（不含版本号子目录）。 / Candidate base dirs under %LOCALAPPDATA% (without version subfolders). */
function localAppDataBaseDirs(localAppData: string): string[] {
  if (!localAppData) return [];
  return [
    path.join(localAppData, 'Programs', 'Cryptomator CLI'),
    path.join(localAppData, 'Programs', 'CryptomatorCLI'),
  ];
}

/**
 * 尝试 access 单个候选路径；成功返回该路径，失败返回 null。
 * Attempt to access a single candidate; returns the path on success, null on failure.
 */
async function tryCandidate(candidate: string): Promise<string | null> {
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * 按 PATH 环境变量的每个目录查找 CLI；可注入 PATH 字符串便于测试。
 * Search PATH entries for the CLI; PATH string can be injected for testing.
 */
export async function scanPathForCli(pathEnv: string): Promise<string | null> {
  if (!pathEnv) return null;
  const isWin = platform() === 'win32';
  const separator = isWin ? ';' : ':';
  const cliName = isWin ? CLI_EXE_NAME : 'cryptomator-cli';

  for (const dir of pathEnv.split(separator)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    // 跳过带引号的路径（极少见，安全处理）。 / Skip quoted paths (rare; safe handling).
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const result = await tryCandidate(path.join(trimmed.slice(1, -1), cliName));
      if (result) return result;
      continue;
    }
    const result = await tryCandidate(path.join(trimmed, cliName));
    if (result) return result;
  }

  return null;
}

/**
 * 扫描常见安装目录（Program Files + %LOCALAPPDATA% 通配）；可注入 LOCALAPPDATA 便于测试。
 * Scan common installation directories (Program Files + %LOCALAPPDATA% wildcard);
 * LOCALAPPDATA can be injected for testing.
 */
export async function scanCommonDirsForCli(localAppData: string): Promise<string | null> {
  if (platform() !== 'win32') return null;

  // 第 1 层：Program Files 固定路径
  for (const candidate of PROGRAM_FILES_CANDIDATES) {
    const result = await tryCandidate(candidate);
    if (result) return result;
  }

  if (!localAppData) return null;

  // 第 2 层：%LOCALAPPDATA%\Programs\Cryptomator* 版本化目录
  for (const baseDir of localAppDataBaseDirs(localAppData)) {
    // 先尝试 baseDir 下直接存在 CLI
    const direct = await tryCandidate(path.join(baseDir, CLI_EXE_NAME));
    if (direct) return direct;

    // 再扫描版本子目录（如 0.6.2）
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue; // 基目录不存在，跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(baseDir, entry.name, CLI_EXE_NAME);
      const result = await tryCandidate(candidate);
      if (result) return result;
    }
  }

  return null;
}

/**
 * 在 Windows 上自动检测 Cryptomator CLI 路径；分层：PATH → 常见目录。
 * Auto-detect Cryptomator CLI path on Windows; layered: PATH → common directories.
 */
export async function detectWindowsCliPath(): Promise<string | null> {
  return (await scanPathForCli(process.env.PATH ?? ''))
      ?? (await scanCommonDirsForCli(process.env.LOCALAPPDATA ?? ''));
}

/** 前置条件检查错误。 / Prerequisite check error. */
export interface PrerequisiteError {
  field: string;
  message: string;
}

/** CLI 探针结果；只保存有界且已脱敏的文本。 / CLI probe result with bounded, redacted text only. */
export interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 从 CLI 版本输出中提取 Cryptomator CLI 版本。
 * Extract the Cryptomator CLI version from version-command output.
 */
export function parseCliVersion(text: string): string | null {
  const lines = text.split(/\r?\n/u);
  const preferred = lines.find((line) => /cryptomator\s*cli|cryptomator-cli/iu.test(line));
  const match = (preferred ?? text).match(/\b(\d+\.\d+\.\d+)\b/u);
  return match?.[1] ?? null;
}

function runProbe(cliPath: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const stdout = new RedactedDiagnostics([cliPath]);
    const stderr = new RedactedDiagnostics([cliPath]);
    const child = spawn(cliPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error('依赖检查超时，请确认 Cryptomator CLI 可正常启动。'));
    }, PROBE_TIMEOUT_MS);

    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cryptomator CLI 无法启动。'));
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.consume(chunk));
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.summary().text, stderr: stderr.summary().text });
    });
  });
}

/**
 * 从 CLI 输出文本中解析挂载器 ID 列表。
 * Cryptomator CLI 可能把列表打印到 stdout 或 stderr，并夹杂 [WARN]/[INFO] 等日志行；
 * 因此调用方应传入合并后的文本，并过滤掉日志行。
 * Parse mounter IDs from CLI output text. The CLI may print the list on stdout or stderr,
 * possibly mixed with log lines like [WARN]/[INFO]; callers pass merged text and we drop log lines.
 */
export function parseMounterList(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[[a-z]+\]/iu.test(line));
}

/**
 * 发现所有可用的挂载器 ID 列表。
 * Discover all available mounter IDs.
 */
export async function discoverMounters(cliPath: string): Promise<string[]> {
  const normalized = cliPath.trim();
  if (!normalized) {
    return [];
  }
  try {
    const result = await runProbe(normalized, ['list-mounters']);
    if (result.code !== 0 || result.signal !== null) {
      return [];
    }
    // CLI 可能把挂载器列表打到 stderr，必须合并 stdout+stderr 后再解析。
    // The CLI may print the mounter list to stderr; merge before parsing.
    return parseMounterList(`${result.stdout}\n${result.stderr}`);
  } catch {
    return [];
  }
}

/**
 * 验证指定密文 Vault 的 CLI 和 mounter 前置条件。
 * Validate CLI and mounter prerequisites for a given encrypted vault.
 */
export async function checkPrerequisites(
  cliPath: string,
  mounterId: string,
  encryptedVaultPath: string,
): Promise<PrerequisiteError[]> {
  const errors: PrerequisiteError[] = [];
  const normalizedCli = cliPath.trim();

  // 检查 CLI 可执行
  try {
    await access(normalizedCli, fsConstants.X_OK);
  } catch {
    errors.push({ field: 'cliPath', message: `CLI 不可执行或不存在：${normalizedCli}` });
    return errors;
  }

  // 运行时重新确认版本，避免仅凭路径或目录名误认未验证的 CLI。
  // Recheck the version at runtime instead of trusting the executable path or folder name.
  try {
    const versionResult = await runProbe(normalizedCli, ['--version']);
    const detectedVersion = parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (versionResult.code !== 0 || versionResult.signal !== null || !detectedVersion) {
      errors.push({ field: 'cliVersion', message: '无法确认 Cryptomator CLI 版本。' });
    } else if (detectedVersion !== SUPPORTED_CLI_VERSION) {
      errors.push({
        field: 'cliVersion',
        message: `当前 Cryptomator CLI 版本为 ${detectedVersion}，首版仅支持 ${SUPPORTED_CLI_VERSION}。`,
      });
    }
  } catch {
    errors.push({ field: 'cliVersion', message: 'Cryptomator CLI 版本检查失败。' });
  }

  // 检查挂载器列表（复用 discoverMounters，确保合并 stdout+stderr 解析）
  try {
    const mounters = await discoverMounters(normalizedCli);
    if (mounters.length === 0) {
      errors.push({ field: 'mounterId', message: '无法获取挂载器列表。' });
    } else if (!mounters.includes(mounterId)) {
      errors.push({
        field: 'mounterId',
        message: `配置的挂载器 "${mounterId}" 不在可用列表中：${mounters.join(', ')}`,
      });
    } else if (mounterId !== FOLDER_MOUNT_MOUNTER_ID) {
      errors.push({
        field: 'mounterId',
        message: `同级明文目录仅支持 ${FOLDER_MOUNT_MOUNTER_ID}；当前挂载器不能挂载到目录路径。`,
      });
    }
  } catch {
    errors.push({ field: 'cliPath', message: '无法启动 CLI 以检查挂载器。' });
  }

  // 检查密文 Vault 结构
  if (normalizedCli && encryptedVaultPath) {
    const markers = ['masterkey.cryptomator', 'vault.cryptomator', 'd'];
    for (const marker of markers) {
      try {
        const markerPath = `${encryptedVaultPath}/${marker}`;
        await access(markerPath, fsConstants.F_OK);
      } catch {
        errors.push({
          field: 'encryptedVaultPath',
          message: `密文 Vault 缺少 Cryptomator 所需结构，请确认目录是用 Cryptomator Desktop 创建的。`,
        });
        break;
      }
    }
  }

  return errors;
}

/**
 * 验证创建前的 CLI 与挂载器条件；新 Vault 尚不存在，因此不检查密文目录结构。
 * Validate CLI and mounter prerequisites before creation; a new vault does not yet have on-disk markers.
 */
export async function checkCreationPrerequisites(
  cliPath: string,
  mounterId: string,
): Promise<PrerequisiteError[]> {
  return checkPrerequisites(cliPath, mounterId, '');
}
