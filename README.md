# Obsidian Cryptomator Bridge

[English](#english) | [中文](#中文)

## 中文

`Obsidian Cryptomator Bridge` 是一个面向 Windows 桌面端的 Obsidian 插件项目。它的目标是在不自行实现加密的前提下，为一个由 Cryptomator 保护的独立 Obsidian Vault 提供一致的入口和状态管理体验。

本仓库包含可构建的 Windows Desktop Obsidian 插件实现；发布前仍必须完成阶段 4 的实机验收。

### 首版目标

- 支持一个预先配置的私密 Vault。
- 检测用户独立安装的 Cryptomator CLI 与 WinFsp。
- 通过 Cryptomator CLI 挂载 Vault，验证挂载目录可用后打开独立的 Obsidian Vault。
- 在锁定前提醒用户关闭私密 Vault 中仍打开的文件，并安全停止挂载进程。

预期流程：

```text
检测依赖 -> 输入密码 -> CLI 挂载 -> 验证挂载目录 -> 打开私密 Vault -> 关闭并卸载
```

### 安全边界

- Cryptomator CLI 和 WinFsp 必须由用户独立安装；本项目不会分发、安装或修改它们。
- 发布的插件包不内置密码；插件运行时由用户输入密码，仅在解锁操作期间存在于内存中，并只通过 CLI 的标准输入传递。
- 开发阶段允许使用本机未提交的 `docs/凭据.txt` 作为测试输入；该文件不得上传 GitHub、不得进入构建产物或发布包。
- 密码绝不能写入设置、日志、命令行参数、环境变量、剪贴板或崩溃报告。
- 本项目不实现加密算法、密钥管理、密码记忆或自动解锁。

### 非目标

- 不支持移动端。
- 不支持多个私密 Vault。
- 不捆绑 Cryptomator、Cryptomator CLI、WinFsp 或其他驱动。
- 不替代 Cryptomator 的 Vault 格式、同步机制或恢复流程。

### 配置

插件配置一个密文 Vault 路径、一个挂载目录、用户已安装的 Cryptomator CLI 路径、mounter 和已注册 Vault 名称。云盘客户端只能同步 Cryptomator 的密文目录，不能同步解锁后的挂载目录。

完整的分阶段实施手册见 [实现 SOP](docs/implementation-sop.md)。

## English

`Obsidian Cryptomator Bridge` is a Windows desktop Obsidian plugin project. It aims to provide a consistent entry point and lifecycle management for one Cryptomator-protected, standalone Obsidian vault without implementing encryption itself.

This repository contains a buildable Windows Desktop Obsidian plugin implementation; real-device acceptance is still required before release.

### Version One Goals

- Support one preconfigured private vault.
- Detect a user-installed Cryptomator CLI and WinFsp.
- Mount the vault with the Cryptomator CLI, verify the mount directory, and open the standalone Obsidian vault.
- Prompt the user to close open private files before safely stopping the mount process.

Expected flow:

```text
Check prerequisites -> enter password -> mount with CLI -> verify mount -> open private vault -> close and unmount
```

### Security Boundary

- Cryptomator CLI and WinFsp must be installed independently by the user. This project will not distribute, install, or modify them.
- The published plugin package must not contain a password. At runtime, the user may enter a password for one unlock operation; it exists only in memory and is passed solely through the CLI standard input.
- During development, the local uncommitted `docs/凭据.txt` may be used as test input. It must never be uploaded to GitHub or included in a build or release package.
- Passwords must never be written to settings, logs, command-line arguments, environment variables, the clipboard, or crash reports.
- This project does not implement cryptography, key management, password persistence, or automatic unlock.

### Non-Goals

- Mobile support.
- Multiple private vaults.
- Bundling Cryptomator, Cryptomator CLI, WinFsp, or any driver.
- Replacing Cryptomator's vault format, synchronization behavior, or recovery process.

### Configuration

The plugin configures one encrypted vault path, one mount directory, a user-installed Cryptomator CLI path, a mounter, and a registered vault name. A cloud client must synchronize only Cryptomator's encrypted storage directory, never the unlocked mount directory.

See the Chinese [implementation SOP](docs/implementation-sop.md) for the phased execution guide.

## License

MIT. See [LICENSE](LICENSE).
