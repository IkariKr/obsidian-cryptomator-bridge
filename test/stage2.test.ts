import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePaths } from '../src/pathValidation';
import { checkPrerequisites, type ProbeResult } from '../src/prerequisites';
import { CliSupervisor, createUnlockArgs, type SpawnProcess } from '../src/cliSupervisor';
import { RedactedDiagnostics } from '../src/diagnostics';
import { VaultLauncher } from '../src/vaultLauncher';
import type { BridgeSettings } from '../src/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; settings: BridgeSettings }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-stage2-'));
  roots.push(root);
  const vault = path.join(root, 'encrypted');
  const mountParent = path.join(root, 'mount-parent');
  await mkdir(vault);
  await mkdir(mountParent);
  await Promise.all([
    writeFile(path.join(root, 'cryptomator-cli.exe'), ''),
    writeFile(path.join(vault, 'masterkey.cryptomator'), ''),
    writeFile(path.join(vault, 'vault.cryptomator'), ''),
    mkdir(path.join(vault, 'd')),
  ]);
  return {
    root,
    settings: {
      schemaVersion: 1,
      cliPath: path.join(root, 'cryptomator-cli.exe'),
      encryptedVaultPath: vault,
      mountPath: path.join(mountParent, 'new-mount'),
      mounterId: 'org.cryptomator.frontend.fuse.mount.WinFspMountProvider',
      privateVaultName: 'Private Test Vault',
    },
  };
}

describe('stage 2 path and CLI boundaries', () => {
  it('accepts an existing vault and a not-yet-created mount node', async () => {
    const { settings } = await fixture();
    const result = await validatePaths({ settings });
    expect(result.mountPath).toBe(settings.mountPath);
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects overlapping paths and an existing mount node', async () => {
    const { settings } = await fixture();
    await expect(validatePaths({ ...{ settings: { ...settings, mountPath: path.join(settings.encryptedVaultPath, 'mount') } } })).rejects.toThrow(
      '不能相同或互相包含',
    );
    await mkdir(settings.mountPath);
    await expect(validatePaths({ settings })).rejects.toThrow('预先不存在');
  });

  it('rejects a mount path inside the current Obsidian vault', async () => {
    const { settings } = await fixture();
    await expect(validatePaths({ settings, currentObsidianVaultPath: path.dirname(settings.mountPath) })).rejects.toThrow(
      '当前 Obsidian Vault 内',
    );
  });

  it('constructs structured args without a password', () => {
    const settings = {
      schemaVersion: 1,
      cliPath: 'C:\\Cryptomator\\cryptomator-cli.exe',
      encryptedVaultPath: 'C:\\Vault',
      mountPath: 'C:\\Mount',
      mounterId: 'WinFspMountProvider',
      privateVaultName: 'Private',
    } satisfies BridgeSettings;
    const args = createUnlockArgs(settings);
    expect(args).toEqual([
      'unlock',
      '--password:stdin',
      '--mounter=WinFspMountProvider',
      '--mountPoint=C:\\Mount',
      'C:\\Vault',
    ]);
    expect(args.join(' ')).not.toContain('secret');
  });

  it('writes one newline to stdin and launches with hidden, non-shell options', async () => {
    const { settings } = await fixture();
    const mountPath = settings.mountPath;
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
    await supervisor.unlock(settings, testInput);
    expect(child.stdin.payload?.subarray(-1).toString('hex')).toBe('0a');
    expect(child.stdin.payload?.toString('utf8')).toBe(`${testInput}\n`);
    expect(spawnCalls[0]).toEqual({
      command: settings.cliPath,
      args: createUnlockArgs(settings),
      options: { shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] },
    });
    await supervisor.stop(settings.mountPath);
    expect(child.signalCode).toBe('SIGINT');
    await expect(access(mountPath)).rejects.toBeDefined();
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

  it('checks the supported version and configured mounter through an injected probe', async () => {
    const { settings } = await fixture();
    const probe = async (_cliPath: string, args: string[]): Promise<ProbeResult> =>
      args[0] === '--version'
        ? { code: 0, signal: null, stdout: '0.6.2', stderr: '' }
        : { code: 0, signal: null, stdout: `${settings.mounterId}\n`, stderr: '' };
    const result = await checkPrerequisites(settings, undefined, probe);
    expect(result.cliVersion).toBe('0.6.2');
    expect(result.mounters).toContain(settings.mounterId);
  });

  it('rejects an unsupported CLI version or mounter', async () => {
    const { settings } = await fixture();
    const badVersion = async (): Promise<ProbeResult> => ({ code: 0, signal: null, stdout: '0.7.0', stderr: '' });
    await expect(checkPrerequisites(settings, undefined, badVersion)).rejects.toThrow('仅支持 Cryptomator CLI 0.6.2');
    const badMounter = async (_cliPath: string, args: string[]): Promise<ProbeResult> =>
      args[0] === '--version'
        ? { code: 0, signal: null, stdout: '0.6.2', stderr: '' }
        : { code: 0, signal: null, stdout: 'other-mounter\n', stderr: '' };
    await expect(checkPrerequisites(settings, undefined, badMounter)).rejects.toThrow('不在当前 CLI 实际提供');
  });

  it('URI-encodes the registered vault name and requests a separate window', () => {
    let opened = '';
    const launcher = new VaultLauncher({ openExternal: (uri) => { opened = uri; } });
    expect(launcher.open('Private Vault One')).toBe('obsidian://open?vault=Private%20Vault%20One&paneType=window');
    expect(opened).toContain('paneType=window');
  });
});
