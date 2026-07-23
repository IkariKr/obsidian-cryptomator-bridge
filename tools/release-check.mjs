import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (manifest.id !== 'obsidian-cryptomator-bridge' || manifest.isDesktopOnly !== true) {
  throw new Error('manifest.json 的插件 ID 或 desktop-only 标记不符合发布边界。');
}
if (!existsSync('main.js')) {
  throw new Error('缺少构建产物 main.js。');
}

const forbiddenNames = ['docs/凭据.txt', 'data.json', '.env', 'password', 'secret'];
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const files = packageJson.files ?? [];
if (!files.includes('main.js') || !files.includes('manifest.json')) {
  throw new Error('package.json 的 files 白名单必须包含 main.js 和 manifest.json。');
}
if (forbiddenNames.some((name) => files.some((file) => file.toLowerCase().includes(name.toLowerCase())))) {
  throw new Error('发布 files 白名单包含禁止的凭据或敏感文件。');
}

console.log(`发布静态检查通过：${manifest.id}@${manifest.version}，仅允许构建产物和 manifest。`);
