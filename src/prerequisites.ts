import { spawn } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { PrerequisiteError } from './errors';
import { RedactedDiagnostics, safeDiagnosticMessage } from './diagnostics';
import { validatePaths } from './pathValidation';
import type { BridgeSettings, ResolvedBridgeSettings } from './types';

const SUPPORTED_CLI_VERSION = '0.6.2';
const PROBE_TIMEOUT_MS = 10_000;

/** 前置检查结果。 / Result of prerequisite checks. */
export interface PrerequisiteResult {
  cliVersion: string;
  mounters: string[];
  warnings: string[];
  normalizedSettings: Pick<ResolvedBridgeSettings, 'cliPath' | 'syncRootPath' | 'encryptedVaultRelativePath' | 'encryptedVaultPath' | 'mountPath'>;
}

/** CLI 探针结果；只保存有界且已脱敏的文本。 / CLI probe result with bounded, redacted text only. */
export interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function parseMounters(stdout: string): string[] {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
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
      reject(new PrerequisiteError('依赖检查超时，请确认 Cryptomator CLI 可正常启动。'));
    }, PROBE_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new PrerequisiteError('Cryptomator CLI 无法启动。'));
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
 * 从 CLI 实际返回的列表中选择唯一的 WinFsp mounter；无法唯一确定时返回 undefined。
 * Selects the unique WinFsp mounter from the CLI's actual list; returns undefined when ambiguous.
 */
export async function discoverWinFspMounterId(
  cliPath: string,
  probe: (cliPath: string, args: string[]) => Promise<ProbeResult> = runProbe,
): Promise<string | undefined> {
  const normalizedCliPath = cliPath.trim();
  if (!normalizedCliPath) {
    return undefined;
  }

  try {
    const result = await probe(normalizedCliPath, ['list-mounters']);
    if (result.code !== 0 || result.signal !== null) {
      return undefined;
    }
    const matches = parseMounters(result.stdout).filter((mounter) => /WinFspMountProvider$/iu.test(mounter));
    if (matches.length === 1) {
      return matches[0];
    }
    return matches.find((mounter) => mounter === 'WinFspMountProvider');
  } catch {
    return undefined;
  }
}

/**
 * 检查 CLI 版本和实际 mounter；不接受代码中猜测的 mounter 名称。
 * Check the CLI version and actual mounters; guessed mounter names are not accepted.
 */
export async function checkPrerequisites(
  settings: BridgeSettings,
  currentObsidianVaultPath?: string,
  probe: (cliPath: string, args: string[]) => Promise<ProbeResult> = runProbe,
): Promise<PrerequisiteResult> {
  const paths = await validatePaths({ settings, currentObsidianVaultPath });
  const versionProbe = await probe(paths.cliPath, ['--version']);
  if (versionProbe.code !== 0 || versionProbe.signal !== null) {
    throw new PrerequisiteError('Cryptomator CLI 版本检查失败。');
  }
  const cliVersion = versionProbe.stdout.trim();
  if (cliVersion !== SUPPORTED_CLI_VERSION) {
    throw new PrerequisiteError(`仅支持 Cryptomator CLI ${SUPPORTED_CLI_VERSION}。`);
  }

  const mounterProbe = await probe(paths.cliPath, ['list-mounters']);
  if (mounterProbe.code !== 0 || mounterProbe.signal !== null) {
    throw new PrerequisiteError('Cryptomator CLI mounter 检查失败。');
  }
  const mounters = parseMounters(mounterProbe.stdout);
  if (!mounters.includes(settings.mounterId)) {
    throw new PrerequisiteError('配置的 mounter 不在当前 CLI 实际提供的列表中。');
  }

  const markers = ['masterkey.cryptomator', 'vault.cryptomator', 'd'];
  for (const marker of markers) {
    try {
      await access(`${paths.encryptedVaultPath}\\${marker}`, fsConstants.F_OK);
    } catch {
      throw new PrerequisiteError('密文 Vault 缺少 Cryptomator 所需结构。');
    }
  }

  return {
    cliVersion,
    mounters,
    warnings: paths.warnings,
    normalizedSettings: {
      cliPath: paths.cliPath,
      syncRootPath: paths.syncRootPath,
      encryptedVaultRelativePath: paths.encryptedVaultRelativePath,
      encryptedVaultPath: paths.encryptedVaultPath,
      mountPath: paths.mountPath,
    },
  };
}
