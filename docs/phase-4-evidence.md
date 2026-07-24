# 阶段 4：测试、验收与发布准备证据

> 状态：IN_PROGRESS（自动与发布静态检查通过；真实 Obsidian UI 手工验收待完成）。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm run check` | PASS |
| `npm test` | PASS；6 个测试文件、31 个测试通过 |
| `npm run build` | PASS |
| `npm run release:check` | PASS；manifest 为 desktop-only，发布白名单只含构建产物和 manifest |
| `npm pack --dry-run` | PASS；未包含 `docs/凭据.txt`、运行时设置或源码测试夹具 |
| `git diff --check` | PASS |

## 已完成的实机证据

- Windows 11、Obsidian Desktop 1.12.7、Cryptomator CLI 0.6.2、WinFsp 1.12.22339 已确认。
- 真实 CLI 隐藏窗口解锁、读写探针和 Node `SIGINT` 停止已通过阶段 0 harness 验证。
- 插件构建产物已安装到本机控制测试 Vault，非敏感 `data.json` 和启用列表已写入；密码未写入。

## 尚待人工完成

- 在 Obsidian UI 中确认插件设置页加载。
- 真实插件命令的成功解锁、独立窗口打开和锁定流程。
- 错误密码、缺少 WinFsp、无效路径、占用文件、CLI 意外退出、reload/重启场景。
- 确认密文 Vault 位于当前控制 Vault 的 Nutstore 插件同步范围内，挂载路径位于控制 Vault 外。
- 配置向导、选中文件夹迁移、逐文件校验和删除前二次校验。
- 空闲超时、Windows 锁屏自动锁定，以及自动锁定失败后的恢复提示。

## 当前联调门状态

- 已将 `main.js` 与 `manifest.json` 安装到用户指定的 `Life OS` 控制 Vault；Obsidian CLI 重载后确认插件 `enabled=true`、`loaded=true`，并注册了解锁/锁定命令。
- 已确认安装目录中的 `main.js` 与当前构建产物 SHA-256 一致，Obsidian 错误缓冲区为空。
- Cryptomator Desktop 可被本机检测到；历史证据中的 Cryptomator CLI 路径不属于当前用户环境，尚未找到可用于本轮联调的 CLI。
- 本轮只写入了目标 Vault 的插件安装目录和 Obsidian 的插件启用状态，未向笔记、Cryptomator 数据或 Nutstore WebDAV 内容写入；待准备好测试 CLI 和可删除测试 Vault 后，再执行真实解锁/迁移联调。

完成以上项目并重新构建后，才能把 manifest 版本提升为 `1.0.0` 并创建发布候选。
