# 架构决策：控制 Vault 内的明文挂载目录

日期：2026-07-25  
状态：已接受，待实现

## 决策

插件采用“密文目录与明文挂载目录同级”的目录布局。明文挂载目录位于当前控制 Obsidian Vault 内，但必须由 Nutstore 排除规则永久排除；密文目录保留在同步范围内。

示例：

```text
Life OS/
├── Work.cryptomator/          ← Cryptomator 密文 Vault，允许 Nutstore 同步
├── Work.cryptomator-mount/    ← 解锁后的明文挂载点，禁止 Nutstore 同步
└── 其他普通笔记/
```

其中：

- 密文 Vault 固定使用原文件夹名加 `.cryptomator` 后缀，例如 `Work.cryptomator`。
- 明文挂载点固定使用原文件夹名加 `.cryptomator-mount` 后缀，例如 `Work.cryptomator-mount`。
- `.cryptomator-mount` 是插件保留后缀，不允许用户自行修改，以保证通用排除规则长期有效。
- `Work.cryptomator` 只有一个点号；不使用 `Work..cryptomator`。

## Nutstore 排除规则

用户在 Nutstore 插件的“排除规则”中只需增加一次：

```text
**/*.cryptomator-mount
```

规则默认不区分大小写。它应覆盖所有私密 Vault 的明文挂载目录：

```text
Work.cryptomator-mount/
Finance.cryptomator-mount/
Personal.cryptomator-mount/
```

该规则必须在第一次解锁前配置，并在每台使用该控制 Vault 的设备上确认存在。插件不得依赖 Nutstore 未公开的内部 API 修改规则；首次配置和解锁前应明确提示用户确认规则已配置。

Nutstore 当前公开实现会对当前路径及其父目录执行 glob 排除判断，因此排除目录本身后，其下的明文文件也应被排除。仍需使用无敏感内容的探针文件完成一次实际验收，确认当前安装版本在手动同步、自动同步和重启后同步中都不会上传明文。

## 生命周期

### 锁定状态

```text
Work.cryptomator       存在，可被 Nutstore 同步
Work.cryptomator-mount 不存在或不可访问
```

### 解锁状态

```text
Work.cryptomator       持续被 Cryptomator 读写并加密
Work.cryptomator-mount 作为明文目录出现在当前 Obsidian Vault 中
```

Cryptomator 会在文件写入时持续更新密文；锁定只负责安全卸载 `Work.cryptomator-mount`，不执行第二次“重新加密”。

## 安全约束

- 明文挂载点不能覆盖 `Work.cryptomator`，必须是同级的独立路径。
- 解锁前必须确认挂载目录名称符合 `.cryptomator-mount` 约定。
- 解锁前必须确认 Nutstore 排除规则已配置；无法确认时应阻止或明确要求用户完成配置。
- 锁定失败时不能删除目录或伪造锁定成功，必须保留可恢复错误状态。
- 已经同步到 Nutstore 的明文不会因为后来增加排除规则而自动安全消失；首次启用前必须检查并清理远端残留。
- 控制 Vault 中继续启用 Nutstore 插件；不再创建一个启用 Nutstore 的独立明文私密 Vault。

## 对配置模型的影响

配置需要从“一个全局私密 Vault”调整为“按加密文件夹记录”：

```text
源文件夹 Work
  → 密文相对路径 Work.cryptomator
  → 明文挂载相对路径 Work.cryptomator-mount
  → Nutstore 排除确认
```

`privateVaultName` 不再表示业务上的加密文件夹名称；同 Vault 模式下不再需要通过 Obsidian URI 打开第二个 Vault。后续实现应改为在当前控制 Vault 中刷新或等待文件树发现挂载目录。

## 当前状态

本决策只更新产品和架构方向。当前代码仍保留旧的“控制 Vault 外部挂载、独立私密 Vault 窗口”实现，后续代码变更必须先完成路径校验、Nutstore 排除验收、迁移记录模型和锁定流程的重新设计。

