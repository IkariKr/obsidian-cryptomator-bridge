import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, statfs, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function usage() {
  console.log(`Usage: node tools/phase0-cli-harness.mjs \\
  --cli <cryptomator-cli.exe> \\
  --vault <encrypted-vault-root> \\
  --mount <non-existing-local-mount-path> \\
  --mounter <mounter-id> [--timeout-ms <milliseconds>] [--stop-mode manual|ctrl-break]
  [--password-file <local-dev-credentials>] [--skip-probe]

  node tools/phase0-cli-harness.mjs --reconcile --mount <mount-path>`);
}

function parseNamedOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];

    if (key === '--skip-probe') {
      options['skip-probe'] = 'true';
      continue;
    }

    const value = argv[index + 1];

    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('参数必须成对提供。');
    }

    options[key.slice(2)] = value;
    index += 1;
  }

  return options;
}

function parseOptions(argv) {
  if (argv[0] === '--reconcile') {
    const options = parseNamedOptions(argv.slice(1));
    if (!options.mount || Object.keys(options).length !== 1) {
      throw new Error('--reconcile 仅接受 --mount 参数。');
    }

    return { mode: 'reconcile', mount: options.mount };
  }

  const options = parseNamedOptions(argv);
  for (const key of ['cli', 'vault', 'mount', 'mounter']) {
    if (!options[key]) {
      throw new Error(`缺少 --${key} 参数。`);
    }
  }

  const timeoutMs = options['timeout-ms'] ? Number(options['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms 必须是 1 到 120000 之间的整数。');
  }

  const stopMode = options['stop-mode'] ?? 'manual';
  if (!['manual', 'ctrl-break', 'sigint'].includes(stopMode)) {
    throw new Error('--stop-mode 必须是 manual、ctrl-break 或 sigint。');
  }

  if (options['password-file'] && path.basename(options['password-file']) !== '凭据.txt') {
    throw new Error('--password-file 仅接受本机开发凭据文件 凭据.txt。');
  }

  return { mode: 'unlock', ...options, timeoutMs, stopMode, skipProbe: options['skip-probe'] === 'true' || 'skip-probe' in options };
}

async function requireFile(filePath, description) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()) {
    throw new Error(`${description} 必须是文件。`);
  }
}

async function requireDirectory(directoryPath, description) {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${description} 必须是非链接目录。`);
  }
}

async function validateInputs(options) {
  await requireFile(options.cli, 'CLI 路径');
  await requireDirectory(options.vault, '密文 Vault 路径');
  await requireDirectory(path.dirname(options.mount), '挂载目录的父路径');

  const vaultMarkers = await Promise.all(
    ['masterkey.cryptomator', 'vault.cryptomator', 'd'].map(async (name) => {
      try {
        await access(path.join(options.vault, name), fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );

  if (vaultMarkers.some((exists) => !exists)) {
    throw new Error('密文 Vault 缺少 Cryptomator 所需结构。');
  }

  try {
    await lstat(options.mount);
    throw new Error('WinFspMountProvider 的挂载路径必须不存在；请只创建其父目录。');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const normalizedVault = path.resolve(options.vault).toLowerCase();
  const normalizedMount = path.resolve(options.mount).toLowerCase();
  const separator = path.sep;
  if (
    normalizedVault === normalizedMount ||
    normalizedVault.startsWith(`${normalizedMount}${separator}`) ||
    normalizedMount.startsWith(`${normalizedVault}${separator}`)
  ) {
    throw new Error('密文 Vault 与挂载目录不能相同或互相包含。');
  }
}

function readPasswordFromTty() {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('必须在交互式终端中输入密码。'));
  }

  return new Promise((resolve, reject) => {
    const typedBytes = [];
    const previousRawMode = process.stdin.isRaw;

    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(previousRawMode ?? false);
      process.stdin.pause();
    };

    const cancel = (message) => {
      typedBytes.fill(0);
      cleanup();
      reject(new Error(message));
    };

    const finish = () => {
      const passwordBytes = Buffer.from(typedBytes);
      typedBytes.fill(0);
      cleanup();
      process.stdout.write('\n');
      resolve(passwordBytes);
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cancel('已取消密码输入。');
          return;
        }

        if (byte === 13 || byte === 10) {
          finish();
          return;
        }

        if (byte === 8 || byte === 127) {
          typedBytes.pop();
          continue;
        }

        typedBytes.push(byte);
      }
    };

    process.stdout.write('请输入 Vault 密码（不会回显，也不会保存）：');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// 仅供本机阶段 0 自动验证使用；发布插件不会从文件读取密码。
async function readPasswordFromLocalDevFile(filePath) {
  await requireFile(filePath, '本机开发凭据路径');
  const content = await readFile(filePath, 'utf8');
  const match = content.match(/^\s*密码\s*[:：]\s*(.*?)\s*$/mu);
  if (!match || !match[1]) {
    throw new Error('本机开发凭据文件缺少密码字段。');
  }

  return Buffer.from(match[1], 'utf8');
}

function redactSecretBytes(chunk, secretBytes) {
  if (secretBytes.length === 0) {
    return Buffer.from(chunk);
  }

  const redacted = [];
  const replacement = Buffer.from('<redacted-password>', 'utf8');

  for (let index = 0; index < chunk.length; ) {
    let matches = index + secretBytes.length <= chunk.length;
    for (let secretIndex = 0; matches && secretIndex < secretBytes.length; secretIndex += 1) {
      matches = chunk[index + secretIndex] === secretBytes[secretIndex];
    }

    if (matches) {
      redacted.push(...replacement);
      index += secretBytes.length;
    } else {
      redacted.push(chunk[index]);
      index += 1;
    }
  }

  return Buffer.from(redacted);
}

function createBoundedRedactedSink(replacements, secretBytes) {
  let acceptedBytes = 0;
  let truncated = false;
  let text = '';

  return {
    consume(chunk) {
      if (acceptedBytes >= MAX_DIAGNOSTIC_BYTES) {
        truncated = true;
        return;
      }

      const safeText = replacements.reduce(
        (text, replacement) => text.replaceAll(replacement, '<redacted-path>'),
        redactSecretBytes(Buffer.from(chunk), secretBytes).toString('utf8'),
      );
      const safeBytes = Buffer.byteLength(safeText, 'utf8');
      const remainingBytes = MAX_DIAGNOSTIC_BYTES - acceptedBytes;
      const acceptedText = Buffer.from(safeText, 'utf8').subarray(0, remainingBytes).toString('utf8');
      acceptedBytes += Buffer.byteLength(acceptedText, 'utf8');
      text += acceptedText;
      truncated ||= safeBytes > remainingBytes;
    },
    summary() {
      return { acceptedBytes, truncated, text };
    },
  };
}

async function mountSignature(mountPath) {
  const metadata = await lstat(mountPath);
  const filesystem = await statfs(mountPath);
  return [metadata.dev, metadata.ino, metadata.mode, filesystem.type, filesystem.bsize].join(':');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMountAvailability(child, mountPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`CLI 在检测到挂载前退出，退出码：${child.exitCode ?? 'unknown'}。`);
    }

    try {
      await access(mountPath, fsConstants.R_OK | fsConstants.W_OK);
      await mountSignature(mountPath);
      return true;
    } catch {
      // Mount service may transiently replace the directory while attaching.
    }

    await delay(500);
  }

  return false;
}

async function askForProbeConfirmation() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('请在资源管理器确认挂载点已打开后，输入 PROBE 进行一次临时读写验证：');
    return answer.trim() === 'PROBE';
  } finally {
    prompt.close();
  }
}

async function runReadWriteProbe(mountPath) {
  const probePath = path.join(mountPath, `.phase0-probe-${randomUUID()}.txt`);

  try {
    await writeFile(probePath, 'phase0-read-write-probe', { encoding: 'utf8', flag: 'wx' });
    const content = await readFile(probePath, 'utf8');
    if (content !== 'phase0-read-write-probe') {
      throw new Error('读回内容与写入内容不一致。');
    }
  } finally {
    await unlink(probePath).catch(() => {});
  }
}

async function canAccess(directoryPath) {
  try {
    await access(directoryPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForMountInaccessibility(mountPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canAccess(mountPath))) {
      return true;
    }
    await delay(250);
  }
  return false;
}

function currentToolPath(fileName) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), fileName);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function requestCtrlBreak(processGroupId) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error('无法定位 Windows SystemRoot。');
  }

  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helperScript = currentToolPath('send-console-break.ps1');
  await requireFile(powershell, 'PowerShell 路径');
  await requireFile(helperScript, 'CTRL_BREAK 控制脚本');

  const helper = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-File', helperScript, '-ProcessGroupId', String(processGroupId)],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stdout = createBoundedRedactedSink([powershell, helperScript], Buffer.alloc(0));
  const stderr = createBoundedRedactedSink([powershell, helperScript], Buffer.alloc(0));
  helper.stdout.on('data', (chunk) => stdout.consume(chunk));
  helper.stderr.on('data', (chunk) => stderr.consume(chunk));

  const { code, signal } = await waitForExit(helper);
  if (code !== 0 || signal !== null || !stdout.summary().text.includes('CTRL_BREAK_SENT')) {
    throw new Error(`CTRL_BREAK 控制脚本失败：code=${code ?? 'null'} signal=${signal ?? 'none'}。`);
  }
}

async function reconcileUnownedMount(mountPath) {
  if (await canAccess(mountPath)) {
    console.error('error: 检测到可访问挂载，但当前实例没有持有 CLI 进程句柄。');
    console.error('请保留当前状态并由持有者或用户手工恢复；不会重复挂载、猜测 PID 或执行卸载。');
    process.exitCode = 2;
    return;
  }

  console.log('idle: 未检测到可访问挂载。');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === 'reconcile') {
    await reconcileUnownedMount(options.mount);
    return;
  }

  await validateInputs(options);
  const passwordBytes = options['password-file']
    ? await readPasswordFromLocalDevFile(options['password-file'])
    : await readPasswordFromTty();

  const replacements = [options.cli, options.vault, options.mount, options['password-file']].filter(Boolean);
  const stdout = createBoundedRedactedSink(replacements, passwordBytes);
  const stderr = createBoundedRedactedSink(replacements, passwordBytes);
  const child = spawn(
    options.cli,
    [
      'unlock',
      '--password:stdin',
      `--mounter=${options.mounter}`,
      `--mountPoint=${options.mount}`,
      options.vault,
    ],
    {
      detached: options.stopMode === 'ctrl-break',
      shell: false,
      // CTRL_BREAK_EVENT needs a console to attach to. This is a Phase 0 feasibility setting,
      // not the production hidden-window launch policy.
      windowsHide: options.stopMode === 'sigint',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  child.stdout.on('data', (chunk) => stdout.consume(chunk));
  child.stderr.on('data', (chunk) => stderr.consume(chunk));

  const stdinPayload = Buffer.alloc(passwordBytes.length + 1);
  passwordBytes.copy(stdinPayload);
  stdinPayload[stdinPayload.length - 1] = 0x0a;
  child.stdin.end(stdinPayload, () => stdinPayload.fill(0));

  let stopRequested = false;
  if (options.stopMode === 'manual') {
    process.on('SIGINT', () => {
      if (!stopRequested) {
        stopRequested = true;
        console.log('已收到 Ctrl+C；等待 CLI 自行优雅退出，不会发送强制终止请求。');
      }
    });
  }

  let mountDetected;
  try {
    mountDetected = await waitForMountAvailability(child, options.mount, options.timeoutMs);
  } catch (error) {
    const output = { stdout: stdout.summary(), stderr: stderr.summary() };
    console.log(`已限制并脱敏的诊断字节：stdout=${output.stdout.acceptedBytes} stderr=${output.stderr.acceptedBytes}`);
    if (output.stdout.text) {
      console.log(`stdout（已脱敏）：${output.stdout.text}`);
    }
    if (output.stderr.text) {
      console.log(`stderr（已脱敏）：${output.stderr.text}`);
    }
    throw error;
  } finally {
    passwordBytes.fill(0);
  }
  console.log(
    mountDetected
      ? '检测到挂载点状态变化。'
      : '未自动检测到挂载点状态变化；不会在未确认的目录执行写入。',
  );

  if (!options.skipProbe && (await askForProbeConfirmation())) {
    await runReadWriteProbe(options.mount);
    console.log('临时读写验证通过，测试文件已删除。');
  } else {
    console.log('跳过读写验证。');
  }

  let exit;
  if (options.stopMode === 'ctrl-break') {
    console.log('由 Node 监督器向独立 CLI 进程组发送 CTRL_BREAK_EVENT。');
    const childExit = waitForExit(child);
    await requestCtrlBreak(child.pid);
    stopRequested = true;
    exit = await childExit;
  } else if (options.stopMode === 'sigint') {
    console.log('由 Node 监督器向隐藏 CLI 进程发送 SIGINT。');
    stopRequested = child.kill('SIGINT');
    exit = await waitForExit(child);
  } else {
    console.log('保持此窗口打开；按一次 Ctrl+C 请求 CLI 优雅停止。');
    exit = await waitForExit(child);
  }
  const mountInaccessibleAfterExit = await waitForMountInaccessibility(options.mount, options.timeoutMs);
  const output = { stdout: stdout.summary(), stderr: stderr.summary() };

  console.log(`CLI 已退出：code=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'} stopRequested=${stopRequested}`);
  console.log(`CLI 退出后挂载路径在限定时间内不可访问：${mountInaccessibleAfterExit}`);
  console.log(`已限制并脱敏的诊断字节：stdout=${output.stdout.acceptedBytes} stderr=${output.stderr.acceptedBytes}`);
  if (output.stdout.truncated || output.stderr.truncated) {
    console.log('诊断输出已截断。');
  }
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
