# 产品方向：Cryptomator 私密笔记库操作编排

> 重要架构决策：实现采用“当前控制 Vault 内的明文挂载目录 + Nutstore 通用排除规则”。固定命名和安全约束见 [架构决策](architecture-decision-same-vault-mount.md)。

## 目标

本插件解决的是 Cryptomator 私密 Obsidian 笔记库的日常操作成本，而不是重新实现加密或云盘同步：

- 在控制 Obsidian Vault 中以右键菜单进入配置、迁移、解锁和锁定流程。
- 让密码输入、CLI 挂载、私密 Vault 窗口打开和安全卸载成为受控流程。
- 在空闲超时或 Windows 锁屏后自动锁定。
- 配合 Nutstore Obsidian 插件通过 WebDAV 同步，使跨设备传输的始终是 Cryptomator 密文。

## 架构

```text
控制 Obsidian Vault（安装 Bridge 与 Nutstore 插件）
  ├── Work.cryptomator：Cryptomator 密文 Vault，允许 Nutstore 同步
  ├── Work.cryptomator-mount：解锁后的明文挂载点，Nutstore 排除
  └── Bridge：菜单、状态、自动锁定、无密码配置
          │
          ├── Cryptomator Desktop：仅用于创建新的密文 Vault
          └── Cryptomator CLI + WinFsp：解锁、挂载、停止挂载
```

控制 Vault 是唯一的 Obsidian Vault。明文挂载目录使用固定 `.cryptomator-mount` 后缀，并由 Nutstore 规则 `**/*.cryptomator-mount` 排除；Bridge 不依赖 Nutstore 未公开 API 修改该规则。

## 首次建立私密笔记库

1. 用户在控制 Vault 中选中需要迁移的文件夹，选择“配置私密笔记库”。配置向导收集非敏感本机信息，并提示用户先用 Cryptomator Desktop 创建 Vault。
2. 插件检查 Cryptomator Desktop、CLI、WinFsp 和当前控制 Vault 内的密文路径是否可用；不控制或探测 Nutstore WebDAV 服务本身。
3. 插件引导用户用 Cryptomator Desktop 在当前控制 Vault 的 Nutstore 同步范围内创建密文 Vault，并设置密码。密码不回传或保存给插件。
4. 插件以 CLI 解锁新 Vault，将源文件夹内容复制到挂载目录，并校验复制结果。
5. 插件要求用户明确确认后，才可删除原明文文件夹；默认保留原文件夹。
6. 插件将密文 Vault 挂载为同级的 `<原文件夹名>.cryptomator-mount`，让当前控制 Vault 发现并显示明文文件。

“创建私密笔记库”表示迁移到一个独立 Cryptomator Vault，不表示把原文件夹原地转换成密文目录。

## 日常使用

- 解锁：确认 Nutstore 已排除 `**/*.cryptomator-mount` 后，输入一次密码；CLI 将对应密文 Vault 挂载为同级明文目录。
- 编辑：对挂载目录的修改会由 Cryptomator 持续写回控制 Vault 中的密文，Nutstore 插件通过 WebDAV 同步密文改动；无需再次“加密”。
- 锁定：停止 CLI 并确认挂载目录不可访问。锁定不会清除所有操作系统或 Obsidian 缓存，只会撤销该明文挂载入口。
- 跨设备：等待 Nutstore 插件同步完成后，再在另一台设备上解锁。首版建议同一时间只在一台设备解锁并编辑同一 Vault。

## 自动锁定

首版应支持两个可独立配置的策略：

- 系统空闲达到指定分钟数；
- Windows 锁屏时立即尝试锁定。

自动锁定不得缓存密码或触发自动解锁。它必须复用手动锁定的监督器和状态机；如果文件句柄、CLI 退出异常或同步根不可访问导致卸载失败，状态必须为可恢复错误并在用户回到控制 Vault 后显示原因。

## 配置与跨设备

需要区分“跨设备可共享的逻辑信息”和“每台电脑不同的信息”：

| 类别 | 示例 | 规则 |
| --- | --- | --- |
| 逻辑信息 | 私密 Vault 标识、密文 Vault 相对同步根路径 | 可在控制 Vault 内同步；不包含密码 |
| 本机配置 | CLI 路径、控制 Vault 根目录、当前设备的挂载能力 | 控制 Vault 根目录由当前 Vault 自动填充；挂载目录使用 Vault 内的固定相对命名 |
| 敏感信息 | 密码、恢复密钥、完整原始诊断 | 不保存、不同步、不记录 |

挂载目录位于控制 Vault 内，但必须匹配 `**/*.cryptomator-mount` 排除规则，防止 WebDAV 插件上传明文。若排除规则无法确认，插件不能继续解锁。若密文路径不可访问，插件应提示检查控制 Vault 的同步状态，不能继续解锁。

## 范围外

- 不控制 Nutstore 插件或 WebDAV 服务，也不依赖其未公开 API 修改排除规则；插件只提示并校验固定命名约定，实际排除规则由用户在 Nutstore 中配置。
- 不把 Cryptomator 密文目录交给 Obsidian Sync 管理；Nutstore 插件同步密文时必须保留 Cryptomator 文件和目录的原始字节与结构。
- 不承诺移动端支持；移动端由 Cryptomator 与 Obsidian 各自的能力处理。
