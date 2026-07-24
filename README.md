# Obsidian Cryptomator Bridge

[English](#english) | [中文](#中文)

## 中文

`Obsidian Cryptomator Bridge` 是一个仅面向 Windows Desktop 的 Obsidian 插件。它不实现加密，也不替代 Nutstore Obsidian 插件的 WebDAV 同步；它把 Cryptomator 私密笔记库的创建引导、解锁、打开、锁定和自动锁定收敛为 Obsidian 内的少量操作。

核心分工如下：

```text
Nutstore Obsidian 插件：通过 WebDAV 同步控制 Vault 中的 Cryptomator 密文目录
Cryptomator：持续加密写入并按密码挂载明文视图
本插件：在 Obsidian 中编排创建引导、解锁、打开和安全锁定
```

### 首版目标

- 支持一个私密 Obsidian Vault 和一个非私密的控制 Vault；插件安装在控制 Vault 中，私密 Vault 解锁后以独立窗口打开。
- 在控制 Vault 的文件夹右键菜单提供“配置私密笔记库 / 迁移 / 解锁 / 锁定”入口。
- 首次使用时引导用户通过已安装的 Cryptomator Desktop 在当前控制 Vault 的 Nutstore 同步范围内创建密文 Vault，随后登记 CLI、挂载和 Vault 信息。
- 将选中的普通文件夹迁移到私密 Vault：先复制并校验，只有用户明确确认后才可删除原明文文件夹。
- 通过用户已安装的 Cryptomator CLI 和 WinFsp 解锁、挂载及锁定 Vault；密码仅通过 CLI 标准输入使用一次。
- 提供手动锁定、空闲超时锁定和 Windows 锁屏锁定；自动锁定与手动锁定使用相同的安全卸载流程。

### 推荐目录布局

```text
控制 Obsidian Vault（Nutstore 插件同步）/
└── PrivateNotes.cryptomator/       ← 只保存密文；由 Nutstore 插件通过 WebDAV 同步

本机非同步目录/
└── CryptomatorMount/PrivateNotes/  ← 解锁后临时出现的明文挂载点

控制 Obsidian Vault/
└── .obsidian/plugins/...           ← Bridge、Nutstore 插件与无密码配置
```

同步根目录由插件自动填充为当前控制 Obsidian Vault 的本地根目录；密文 Vault 的相对路径由用户指定。挂载目录必须位于控制 Vault 之外。私密 Vault 的独立窗口中不得启用 Nutstore 插件，否则会把明文同步到坚果云。

### 日常流程

```text
在控制 Vault 中确认 Nutstore WebDAV 同步可用
  → 右键“解锁私密笔记库”
  → 输入密码，CLI 挂载并打开独立私密 Vault 窗口
  → 编辑笔记时 Cryptomator 会持续更新控制 Vault 中的密文，Nutstore 插件同步密文变更
  → 手动锁定、空闲或锁屏时卸载明文挂载点
```

锁定不是“重新加密”步骤：Cryptomator 在写入发生时已更新密文；锁定只让本地明文挂载点不可访问。切换到另一台电脑前，应确认 Nutstore 插件完成同步，并避免同时在多台设备解锁并编辑同一 Vault。

### 前置条件与安全边界

- 用户必须自行安装 Cryptomator Desktop、Cryptomator CLI、WinFsp，并配置 Nutstore Obsidian 插件的 WebDAV 同步；本插件不会分发、安装或修改这些依赖。
- Cryptomator Desktop 负责创建新 Vault；插件不得自行实现 Vault 格式或声称对普通文件夹进行原地加密。
- 密码不写入设置、日志、命令行参数、环境变量、剪贴板、崩溃报告或测试夹具，也不缓存或自动解锁。
- 自动锁定只能尝试安全卸载；若文件句柄阻止卸载，插件必须提示用户恢复处理，不能伪造“已锁定”。
- 解锁期间，明文可能被 Obsidian、操作系统缓存或其他已授权程序访问。插件只能控制 Cryptomator 挂载点，不能保证清除所有操作系统级副本。

### 非目标

- 移动端支持、多私密 Vault、自动解锁、密码记忆或密钥链存储。
- 打包、下载、安装或修改 Cryptomator、WinFsp、Nutstore Obsidian 插件或 WebDAV 服务。
- 使用 Obsidian Sync 同步 Cryptomator 密文目录，或替代 Cryptomator 的格式、同步冲突处理和恢复流程。

详细产品方向见 [产品方向](docs/product-direction.md)，分阶段实施规则见 [实现 SOP](docs/implementation-sop.md)。

## English

`Obsidian Cryptomator Bridge` is a Windows Desktop-only Obsidian plugin. It neither implements encryption nor replaces the Nutstore Obsidian plugin's WebDAV synchronization. It reduces the Cryptomator private-notes workflow to a small set of Obsidian actions: setup guidance, unlock, open, lock, and automatic locking.

Responsibilities are deliberately separated:

```text
Nutstore Obsidian plugin: synchronize ciphertext inside the control Vault through WebDAV
Cryptomator: continuously encrypt writes and mount a password-protected plaintext view
This plugin: orchestrate setup guidance, unlock, opening, and safe locking in Obsidian
```

### Version One Goals

- One private Obsidian Vault and one non-private control Vault. The plugin runs in the control Vault and opens the mounted private Vault in a separate window.
- Folder-menu actions in the control Vault for configuring, migrating, unlocking, and locking a private notes Vault.
- First-use guidance through the user-installed Cryptomator Desktop to create the encrypted Vault inside the current control Vault's Nutstore-synced scope, then register CLI, mount, and Vault details.
- Safe folder migration: copy and verify selected ordinary-folder contents before offering an explicitly confirmed source deletion.
- Unlock, mount, and lock through the user-installed Cryptomator CLI and WinFsp, with a one-time password supplied only through CLI standard input.
- Manual locking plus automatic locking after system idle time or Windows lock screen, using the same safe unmount path.

### Security Boundary

- Users install Cryptomator Desktop, Cryptomator CLI, WinFsp, and configure the Nutstore Obsidian WebDAV plugin themselves; this plugin never distributes, installs, or modifies them.
- Cryptomator Desktop creates new Vaults. The plugin must not implement the Vault format or claim to encrypt an ordinary folder in place.
- Cryptomator encrypts changes as they are written. Locking only unmounts the local plaintext view; it does not start a second encryption pass.
- Passwords are never persisted, logged, passed by command line or environment variables, cached, or used for automatic unlock.
- An automatic lock may only attempt a safe unmount. If open handles prevent it, the plugin must show a recoverable error rather than claim the Vault is locked.

### Non-Goals

- Mobile support, multiple private Vaults, automatic unlock, password persistence, or keychain storage.
- Bundling or managing Cryptomator, WinFsp, the Nutstore Obsidian plugin, or its WebDAV service.
- Synchronizing a Cryptomator ciphertext directory with Obsidian Sync, or replacing Cryptomator's format, sync-conflict handling, or recovery workflow.

See the Chinese [product direction](docs/product-direction.md) and [implementation SOP](docs/implementation-sop.md).

## License

MIT. See [LICENSE](LICENSE).
