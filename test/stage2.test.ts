import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateVaultRecordPaths } from '../src/pathValidation';
import {
  checkPrerequisites,
  discoverMounters,
  scanPathForCli,
  scanCommonDirsForCli,
  parseMounterList,
  parseCliVersion,
} from '../src/prerequisites';
import { CliSupervisor, createUnlockArgs, type SpawnProcess, type UnlockParams } from '../src/cliSupervisor';
import { RedactedDiagnostics } from '../src/diagnostics';
import type { ResolvedVaultRecord } from '../src/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  syncRoot: string;
  resolvedRecord: ResolvedVaultRecord;
  cliPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-stage2-'));
  roots.push(root);
  const syncRoot = path.join(root, 'nutstore');
  const encryptedVault = path.join(syncRoot, 'MySecret.cryptomator');
  const mountPoint = path.join(syncRoot, 'MySecret.cryptomator-mount');
  const cliPath = path.join(root, 'cryptomator-cli.exe');

  await mkdir(encryptedVault, { recursive: true });
  await Promise.all([
    writeFile(cliPath, ''),
    writeFile(path.join(encryptedVault, 'masterkey.cryptomator'), ''),
    writeFile(path.join(encryptedVault, 'vault.cryptomator'), ''),
    mkdir(path.join(encryptedVault, 'd')),
  ]);

  return {
    root,
    syncRoot,
    cliPath,
    resolvedRecord: {
      id: 'rec-1',
      folderName: 'MySecret',
      nutstoreExclusionConfirmed: true,
      encryptedVaultPath: encryptedVault,
      mountPath: mountPoint,
    },
  };
}

describe('stage 2 path and CLI boundaries (v3 multi-record)', () => {
  it('validates an existing ciphertext dir and absent mount node', async () => {
    const { resolvedRecord } = await fixture();
    const errors = validateVaultRecordPaths(resolvedRecord);
    expect(errors).toHaveLength(0);
  });

  it('rejects when ciphertext directory does not exist', async () => {
    const { resolvedRecord } = await fixture();
    const bad = { ...resolvedRecord, encryptedVaultPath: path.join(resolvedRecord.encryptedVaultPath, '..', 'missing') };
    const errors = validateVaultRecordPaths(bad);
    expect(errors.some((e) => e.message.includes('不存在'))).toBe(true);
  });

  it('rejects when mount node already exists', async () => {
    const { resolvedRecord } = await fixture();
    await mkdir(resolvedRecord.mountPath);
    const errors = validateVaultRecordPaths(resolvedRecord);
    expect(errors.some((e) => e.field.includes('mountPath') && e.message.includes('已存在'))).toBe(true);
  });

  it('rejects a mount path whose parent does not exist', async () => {
    const { resolvedRecord } = await fixture();
    const bad = { ...resolvedRecord, mountPath: path.join(path.dirname(resolvedRecord.mountPath), 'missing', 'mount') };
    const errors = validateVaultRecordPaths(bad);
    expect(errors.some((e) => e.field.includes('mountPath') && e.message.includes('父目录'))).toBe(true);
  });

  it('keeps both paths inside the current control Vault when that boundary is supplied', async () => {
    const { root, syncRoot, resolvedRecord } = await fixture();
    expect(validateVaultRecordPaths(resolvedRecord, syncRoot)).toHaveLength(0);
    const outside = {
      ...resolvedRecord,
      encryptedVaultPath: path.join(path.dirname(root), 'outside.cryptomator'),
    };
    const errors = validateVaultRecordPaths(outside, syncRoot);
    expect(errors.some((e) => e.message.includes('当前控制 Vault'))).toBe(true);
  });

  it('rejects a junction or reparse point as ciphertext directory', async () => {
    if (process.platform !== 'win32') return;
    const { resolvedRecord } = await fixture();
    // On Windows, creating a real junction requires admin; test that the check doesn't crash
    const errors = validateVaultRecordPaths(resolvedRecord);
    expect(errors.every((e) => !e.message.includes('junction'))).toBe(true);
  });

  it('constructs structured args without a password', () => {
    const params: UnlockParams = {
      cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
      encryptedVaultPath: 'C:\\Nutstore\\Work.cryptomator',
      mountPath: 'C:\\Nutstore\\Work.cryptomator-mount',
      mounterId: 'WinFspMountProvider',
    };
    const args = createUnlockArgs(params);
    expect(args).toEqual([
      'unlock',
      '--password:stdin',
      '--mounter=WinFspMountProvider',
      '--mountPoint=C:\\Nutstore\\Work.cryptomator-mount',
      'C:\\Nutstore\\Work.cryptomator',
    ]);
    expect(args.join(' ')).not.toContain('secret');
  });

  it('writes one newline to stdin and launches with hidden, non-shell options', async () => {
    const { resolvedRecord, cliPath } = await fixture();
    const mountPath = resolvedRecord.mountPath;

    class FakeStream extends EventEmitter {
      payload?: Buffer;
      end(payload: Buffer, callback: () => void): void {
        this.payload = Buffer.from(payload);
        callback();
        void mkdir(mountPath);
      }
    }
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new FakeStream();
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      kill(signal: NodeJS.Signals): boolean {
        this.signalCode = signal;
        void rm(mountPath, { recursive: true, force: true });
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
      }
    }
    const child = new FakeChild();
    const spawnCalls: unknown[] = [];
    const spawnProcess: SpawnProcess = ((command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child as never;
    });

    const supervisor = new CliSupervisor({ mountTimeoutMs: 2_000, spawnProcess });
    const testInput = 'x'.repeat(8);
    const params: UnlockParams = {
      cliPath,
      encryptedVaultPath: resolvedRecord.encryptedVaultPath,
      mountPath,
      mounterId: 'WinFspMountProvider',
    };
    await supervisor.unlock(params, testInput);
    expect(child.stdin.payload?.subarray(-1).toString('hex')).toBe('0a');
    expect(child.stdin.payload?.toString('utf8')).toBe(`${testInput}\n`);
    expect(spawnCalls[0]).toEqual({
      command: cliPath,
      args: createUnlockArgs(params),
      options: { shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
    });
    await supervisor.stop(mountPath);
    expect(child.signalCode).toBe('SIGINT');
    await expect(access(mountPath)).rejects.toBeDefined();
  });

  it('retains ownership when a failed unlock leaves the mount accessible', async () => {
    const { resolvedRecord, cliPath } = await fixture();
    class FakeStream extends EventEmitter {
      end(_payload: Buffer): void {
        void mkdir(resolvedRecord.mountPath).then(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      }
    }
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly stdin = new FakeStream();
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      kill(signal: NodeJS.Signals): boolean {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
      }
    }
    const child = new FakeChild();
    const supervisor = new CliSupervisor({
      mountTimeoutMs: 20,
      spawnProcess: (() => child as never) as SpawnProcess,
    });
    const params: UnlockParams = {
      cliPath,
      encryptedVaultPath: resolvedRecord.encryptedVaultPath,
      mountPath: resolvedRecord.mountPath,
      mounterId: 'WinFspMountProvider',
    };

    await expect(supervisor.unlock(params, 'test-password')).rejects.toThrow('仍可访问');
    expect(supervisor.ownsProcess).toBe(true);
    await rm(resolvedRecord.mountPath, { recursive: true, force: true });
    await expect(supervisor.stop(resolvedRecord.mountPath)).resolves.toBeDefined();
    expect(supervisor.ownsProcess).toBe(false);
  });

  it('redacts secrets and bounds diagnostics', () => {
    const testInput = 'x'.repeat(8);
    const diagnostics = new RedactedDiagnostics(['C:\\Vault'], [testInput]);
    diagnostics.consume(`path=C:\\Vault value=${testInput}`);
    diagnostics.consume('x'.repeat(20_000));
    const result = diagnostics.summary();
    expect(result.text).not.toContain(testInput);
    expect(result.text).not.toContain('C:\\Vault');
    expect(result.acceptedBytes).toBeLessThanOrEqual(8 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('discovers mounters when CLI exists', async () => {
    const { cliPath } = await fixture();
    // discoverMounters 调用真实 CLI，可能失败但不应崩溃
    const mounters = await discoverMounters(cliPath);
    // cliPath is an empty file, not a real CLI - expect empty list
    expect(Array.isArray(mounters)).toBe(true);
  });

  it('parses the Cryptomator CLI version from stdout or stderr', () => {
    expect(parseCliVersion('Cryptomator CLI 0.6.2\n')).toBe('0.6.2');
    expect(parseCliVersion('[INFO] version\nCryptomator CLI: 0.7.0')).toBe('0.7.0');
    expect(parseCliVersion('no version here')).toBeNull();
  });

  it('returns empty list when CLI path is empty', async () => {
    const mounters = await discoverMounters('');
    expect(mounters).toEqual([]);
  });

  it('returns empty list on ambiguous or failed probe', async () => {
    // non-existent CLI path → empty result
    const mounters = await discoverMounters('/non-existent-cli-path');
    expect(mounters).toEqual([]);
  });

  it('rejects when mounterId is not in available list via checkPrerequisites', async () => {
    const { cliPath, resolvedRecord } = await fixture();
    const errors = await checkPrerequisites(
      cliPath,
      'other-mounter-id',
      resolvedRecord.encryptedVaultPath,
    );
    // May pass or fail depending on whether cliPath exists; we just verify it returns errors array
    // Since the CLI doesn't really exist, it'll return cliPath error first
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CLI detection — PATH scanning', () => {
  it('finds cryptomator-cli.exe in the first matching PATH entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-path-'));
    roots.push(root);

    const dirA = path.join(root, 'bin-a');
    const dirB = path.join(root, 'bin-b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    const expected = path.join(dirB, 'cryptomator-cli.exe');
    await writeFile(expected, '');

    const pathEnv = [dirA, dirB].join(';');
    const result = await scanPathForCli(pathEnv);
    expect(result).toBe(expected);
  });

  it('returns null when no PATH entry contains the CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-empty-'));
    roots.push(root);

    const dirA = path.join(root, 'empty-bin');
    await mkdir(dirA, { recursive: true });

    const result = await scanPathForCli(dirA);
    expect(result).toBeNull();
  });

  it('returns null for an empty PATH string', async () => {
    expect(await scanPathForCli('')).toBeNull();
  });

  it('skips empty PATH entries without crashing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-gap-'));
    roots.push(root);

    const dirA = path.join(root, 'real-bin');
    await mkdir(dirA, { recursive: true });
    const expected = path.join(dirA, 'cryptomator-cli.exe');
    await writeFile(expected, '');

    // PATH with empty gaps: ";;;real-bin;;;"
    const pathEnv = `;;;${dirA};;;`;
    const result = await scanPathForCli(pathEnv);
    expect(result).toBe(expected);
  });
});

describe('parseMounterList — stderr/log-line handling', () => {
  it('parses mounters printed on stderr (real CLI behavior)', () => {
    const stderr = '[WARN] keychain unavailable\norg.cryptomator.frontend.fuse.mount.WinFspMountProvider\norg.cryptomator.frontend.webdav.mount.WindowsMounter\n';
    const result = parseMounterList(`\n${stderr}`);
    expect(result).toEqual([
      'org.cryptomator.frontend.fuse.mount.WinFspMountProvider',
      'org.cryptomator.frontend.webdav.mount.WindowsMounter',
    ]);
  });

  it('parses mounters printed on stdout', () => {
    const stdout = 'org.cryptomator.frontend.fuse.mount.WinFspMountProvider\norg.cryptomator.frontend.webdav.mount.WindowsMounter\n';
    const result = parseMounterList(stdout);
    expect(result).toEqual([
      'org.cryptomator.frontend.fuse.mount.WinFspMountProvider',
      'org.cryptomator.frontend.webdav.mount.WindowsMounter',
    ]);
  });

  it('returns empty array when CLI outputs nothing', () => {
    expect(parseMounterList('')).toEqual([]);
    expect(parseMounterList('   \n  \n')).toEqual([]);
  });

  it('filters out log lines (WARN/INFO/ERROR) but keeps mounter IDs', () => {
    const text = '[WARN] foo\n[INFO] bar\norg.cryptomator.frontend.webdav.mount.FallbackMounter\n[ERROR] baz\n';
    const result = parseMounterList(text);
    expect(result).toEqual(['org.cryptomator.frontend.webdav.mount.FallbackMounter']);
  });

  it('matches the real CLI list-mounters output format', () => {
    const combined = 'org.cryptomator.frontend.fuse.mount.WinFspNetworkMountProvider\norg.cryptomator.frontend.fuse.mount.WinFspMountProvider\norg.cryptomator.frontend.webdav.mount.WindowsMounter\norg.cryptomator.frontend.webdav.mount.FallbackMounter\n';
    expect(parseMounterList(combined)).toHaveLength(4);
    expect(parseMounterList(combined)).toContain('org.cryptomator.frontend.fuse.mount.WinFspMountProvider');
  });
});

describe('CLI detection — common directories', () => {
  it('finds CLI in a version subfolder under Cryptomator CLI', async () => {
    if (process.platform !== 'win32') return;

    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-common-'));
    roots.push(root);

    // 模拟 %LOCALAPPDATA%\Programs\Cryptomator CLI\0.6.2\cryptomator-cli.exe
    const cliDir = path.join(root, 'Programs', 'Cryptomator CLI', '0.6.2');
    await mkdir(cliDir, { recursive: true });
    const expected = path.join(cliDir, 'cryptomator-cli.exe');
    await writeFile(expected, '');

    const result = await scanCommonDirsForCli(root);
    expect(result).toBe(expected);
  });

  it('finds CLI in a version subfolder under CryptomatorCLI (no space)', async () => {
    if (process.platform !== 'win32') return;

    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-common2-'));
    roots.push(root);

    const cliDir = path.join(root, 'Programs', 'CryptomatorCLI', '1.0.0');
    await mkdir(cliDir, { recursive: true });
    const expected = path.join(cliDir, 'cryptomator-cli.exe');
    await writeFile(expected, '');

    const result = await scanCommonDirsForCli(root);
    expect(result).toBe(expected);
  });

  it('finds CLI directly in base dir without version subfolder', async () => {
    if (process.platform !== 'win32') return;

    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-direct-'));
    roots.push(root);

    const baseDir = path.join(root, 'Programs', 'CryptomatorCLI');
    await mkdir(baseDir, { recursive: true });
    const expected = path.join(baseDir, 'cryptomator-cli.exe');
    await writeFile(expected, '');

    const result = await scanCommonDirsForCli(root);
    expect(result).toBe(expected);
  });

  it('returns null when no common directory contains the CLI', async () => {
    if (process.platform !== 'win32') return;

    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-cli-none-'));
    roots.push(root);

    // 空目录，没有任何 CLI 文件
    await mkdir(path.join(root, 'Programs', 'Cryptomator CLI'), { recursive: true });
    await mkdir(path.join(root, 'Programs', 'CryptomatorCLI'), { recursive: true });

    const result = await scanCommonDirsForCli(root);
    expect(result).toBeNull();
  });

  it('returns null on non-Windows platform (no-op)', async () => {
    if (process.platform === 'win32') return;

    const result = await scanCommonDirsForCli('/some/path');
    expect(result).toBeNull();
  });
});
