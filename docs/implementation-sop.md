# Obsidian Cryptomator Bridge 实现 SOP

> 状态：实施前执行手册。本文定义首个功能版本的执行顺序、交付物和阻断条件；它不是用户部署指南，也不代表已有功能。

## 1. 固定边界

本 SOP 只适用于一个 Windows Desktop 私密 Vault。Cryptomator CLI 与 WinFsp 必须由用户独立安装；项目不分发、不安装、也不修改它们。

以下规则在所有阶段都不可突破：

- 不实现加密、密钥管理、密码记忆或自动解锁。
- 密码只能在一次解锁操作中短暂存在，并只经 Cryptomator CLI 的 `stdin` 传递。
- 密码不得进入设置、日志、命令行参数、环境变量、剪贴板、快照、崩溃报告或测试夹具。
- 不使用 `shell: true`、字符串拼接的 shell 命令、`taskkill`，也不创建明文临时文件。
- 云盘客户端只能同步 Cryptomator 的密文目录；不得同步解锁后的挂载目录。

## 2. 阶段总览

| 阶段 | 目标 | 允许进入下一阶段的条件 |
| --- | --- | --- |
| 0 | 验证本机 CLI、挂载、卸载和跨 Vault 打开能力 | 每项可行性检查均有可复现证据 |
| 1 | 建立插件骨架、配置契约和状态机 | 无密码的配置可保存、加载和验证 |
| 2 | 实现前置检查与安全挂载 | 密码不落盘，成功挂载和错误路径均可控 |
| 3 | 打开私密 Vault 并安全锁定 | 已验证 URI 打开与优雅卸载的完整流程 |
| 4 | 完成测试、手工验收和发布准备 | 所有自动与手工验收项通过 |

阶段 0 未通过前，禁止开始阶段 2 或阶段 3 的功能开发。若某个阶段被阻断，应记录命令版本、脱敏后的输出、复现步骤和结论；不要以降低安全边界的方式绕过它。

## 3. 阶段 0：环境与可行性关卡

### 目标

在真实 Windows Desktop 环境确认首版依赖可满足，并找出任何平台或 CLI 行为限制。

### 前置条件

- Windows 10 或 Windows 11、Obsidian Desktop、Cryptomator CLI `0.6.2`、WinFsp。
- 一个与个人资料隔离、可删除的 Cryptomator 测试 Vault。
- 一个空的本地挂载目录；它不能位于 OneDrive、Dropbox、Google Drive 或其他同步根目录中。
- 一个已经在 Obsidian 中注册的测试 Vault 名称。

### 步骤

1. 记录 `cryptomator-cli --version`、`cryptomator-cli list-mounters` 和 WinFsp 版本。选择 CLI 实际列出的 WinFsp mounter 标识，不在代码或文档中猜测类名。
2. 以测试程序或受控手工操作调用 `unlock --password:stdin --mounter=<mounterId> --mountPoint=<mountPath> <encryptedVaultPath>`。密码必须直接写入标准输入，不能通过 PowerShell 历史、`echo`、环境变量或参数传递。
3. 在限定超时内确认挂载目录可读写，并确认密文目录之外没有生成明文副本。
4. 验证 Node/Electron 子进程可向该 CLI 进程发送优雅停止请求，并确认 CLI 退出后挂载目录不可访问。记录实际使用的停止机制和 CLI 返回行为。
5. 以 URL-encoded 的已注册 Vault 名称测试 `obsidian://open?vault=<privateVaultName>`，确认 Obsidian 打开的是独立私密 Vault。当前 Obsidian CLI 不承担跨 Vault 打开职责。

### 交付物与验收

- 在 Issue 或后续 `docs/phase-0-evidence.md` 中保存脱敏后的版本、mounter 标识、命令结构、停止方式和结论。
- CLI 可以挂载、访问并优雅卸载测试 Vault。
- Obsidian URI 能打开已注册 Vault。
- 测试中未记录、提交或复制任何密码、真实个人路径或测试 Vault 密文。

### 失败处理

- 如果没有可用 mounter、挂载目录不可用或卸载无法优雅完成，停止在本阶段并记录阻断原因。
- 禁止用 `taskkill`、强制删除挂载目录、隐式 WebDAV 替代或后台 shell 脚本掩盖失败。任何替代方案必须另行进行安全设计评审。

## 4. 阶段 1：插件基础与配置契约

### 目标

建立标准 TypeScript Obsidian 插件骨架，并让非敏感配置与运行时状态有明确边界。

### 步骤

1. 创建标准 Obsidian 插件工程，插件 ID 固定为 `obsidian-cryptomator-bridge`，并标记为 desktop-only。
2. 定义唯一 Vault 的设置模型：`cliPath`、`encryptedVaultPath`、`mountPath`、`mounterId`、`privateVaultName`。这些路径仍应在 UI 和诊断中按需脱敏。
3. 明确密码不属于设置模型、序列化状态、命令参数对象或日志事件。
4. 建立状态机：`idle → checking → mounting → mounted → unmounting → error`。每个状态只能由受控事件转换；UI 不得直接修改状态。
5. 将设置、依赖检查、CLI 进程、Vault URI 打开和 UI 状态拆为独立模块。

### 交付物与验收

- `manifest.json`、TypeScript 构建流程、设置页和无敏感数据的默认设置。
- 设置能被验证、保存和重新加载；空值、无效路径和无效状态转换均返回明确错误。
- 公开 API、导出类型与兼容处理按仓库约束提供中英双语注释。

### 失败处理

- 若必须依赖未公开的 Obsidian 内部 API 才能继续，先记录降级方案并暂停，不直接引入内部 API。

## 5. 阶段 2：前置检查与安全解锁

### 目标

在不泄露密码的条件下，对环境进行完整检查并启动 Cryptomator CLI。

### 步骤

1. 在 `checking` 状态验证 CLI 可执行文件、密文 Vault 目录、空挂载目录、mounter 标识和 `privateVaultName`。
2. 对挂载目录做同步风险提示：若用户选择云盘同步目录，拒绝继续并要求改用本地非同步目录。
3. 用 Password Modal 收集密码；只把密码交给 CLI 进程的 `stdin`，写入后立即关闭输入流并清除可清除的引用。JavaScript 字符串无法保证物理清零，因此不得声称已安全擦除内存。
4. 使用 `child_process.spawn` 或等价 Electron/Node API 启动 CLI：参数必须是数组、`shell` 必须为 `false`、窗口必须隐藏，且不得把密码放入 `args` 或 `env`。
5. 使用有限超时轮询挂载目录的可访问性。仅在可访问时转换到 `mounted`；标准输出和错误输出只保留经过路径与敏感值脱敏的诊断。

### 交付物与验收

- 解锁命令、进程句柄和状态机集成。
- 缺少 CLI/WinFsp、目录无效、密码错误、超时和 CLI 意外退出均有可行动的脱敏提示。
- 代码审查确认密码不会被 `console`、Notice、设置、环境变量、命令行或测试快照读取。

### 失败处理

- 挂载失败时关闭 `stdin`、释放进程引用、返回 `error`，并要求用户修正环境后重新操作。
- 不自动重复写入密码，不创建明文回退目录，不使用未经阶段 0 验证的停止或挂载机制。

## 6. 阶段 3：Vault 打开与安全锁定

### 目标

将已挂载内容作为独立 Obsidian Vault 打开，并在用户确认后安全卸载。

### 步骤

1. 仅在 `mounted` 状态调用 `shell.openExternal` 或等价安全 API 打开 `obsidian://open?vault=<encodeURIComponent(privateVaultName)>`。
2. 不尝试将挂载目录插入当前 Vault 的文件树、符号链接或索引。
3. 用户点击“锁定”后，提示其先关闭私密 Vault 中的文件；插件随后执行阶段 0 已验证的优雅停止流程。
4. 只有 CLI 退出且挂载目录不可访问时，才返回 `idle`。若文件句柄阻止卸载、CLI 异常退出或超时，保留 `error` 并展示恢复指引。

### 交付物与验收

- 挂载成功后能打开正确的独立 Vault。
- 正常锁定不遗留运行中的 CLI 进程或可访问挂载目录。
- 句柄占用、异常退出和超时不触发强制终止、自动重试写入或不安全清理。

### 失败处理

- 卸载失败时保持密文 Vault 不变，显示用户应关闭的应用/文件和重新尝试路径。
- 不使用 `taskkill`、强制卸载或删除目录来伪造“已锁定”状态。

## 7. 阶段 4：测试、验收与发布准备

### 自动测试

- 路径验证、挂载目录空目录判断、mounter 选择和设置迁移。
- CLI 参数数组构造、`shell: false`、密码脱敏和 stdin 生命周期。
- 状态机的合法与非法转换、超时、CLI 退出和错误映射。
- 任何 Bug 修复先添加回归测试；测试不得调用真实 Cryptomator CLI。

### 手工验收

使用阶段 0 的可丢弃 Vault 完成下列流程：

1. 首次配置并检查依赖。
2. 成功解锁、确认挂载目录、打开私密 Vault。
3. 正常关闭私密 Vault 后锁定，并确认挂载目录消失。
4. 分别验证错误密码、缺少 WinFsp、无效路径、占用文件和 CLI 意外退出。
5. 复核云盘客户端只监视密文目录，挂载目录不在同步根目录内。

### 发布门槛

- README、设置文案和发布说明不宣称移动端、多 Vault、自动解锁、密码记忆或内置 Cryptomator。
- `.gitignore` 排除运行时设置、日志、构建文件和环境变量；仓库中没有真实密码、个人路径、Vault 数据或脱敏前诊断。
- 构建、受影响测试和手工验收全部通过后，才创建发布候选。

## 8. SOP 维护规则

- 每个阶段完成后更新其证据与已知限制；不要提前标记后续阶段完成。
- Cryptomator CLI、WinFsp、Obsidian 或 Windows 的版本变化导致行为变化时，先重新执行阶段 0。
- 若范围扩展到多 Vault、移动端、CLI 打包或密码持久化，必须新建安全设计并更新 README、AGENTS.md 与本 SOP 后才能实现。
