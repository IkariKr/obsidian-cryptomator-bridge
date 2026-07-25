# 阶段 0：环境与可行性证据

> 状态：PASS（Node 隐藏窗口监督器的优雅停止已验证；插件生命周期集成在实现后重验）
>
> 本文只保存脱敏结果。真实密码、个人路径、Vault 数据和未脱敏 CLI 输出不得写入本证据文档或提交到仓库。开发期间如需使用本机测试凭据，只能读取未纳入版本控制的 `docs/凭据.txt`，发布前必须移除发布包。

> 架构说明：其中 Obsidian URI/独立窗口验证属于同 Vault 决策前的历史基线；当前实现不再打开第二个 Obsidian Vault。CLI、WinFsp 和进程所有权证据仍可作为依赖边界参考。

## 记录信息

- 日期：2026-07-23
- 操作系统：Windows 11 Pro，Build 26200
- 测试 Vault：已完成一次受控解锁、临时读写和卸载
- 证据路径：仓库内脱敏文档

## 前置依赖

| 项目 | 结果 | 证据/结论 |
| --- | --- | --- |
| Cryptomator CLI | PASS | 已使用用户提供的完整路径执行 CLI |
| Cryptomator CLI 版本 | PASS | `0.6.2` |
| WinFsp mounter | PASS（已验证） | CLI 返回 `WinFspNetworkMountProvider` 和 `WinFspMountProvider`；`WinFspMountProvider` 已完成实际挂载验证 |
| WinFsp | PASS（安装状态） | 已检测到 WinFsp 1.12.22339；`WinFsp.Launcher` 正在运行 |
| Obsidian Desktop | PASS（安装状态） | 已检测到 Obsidian 1.12.7；启动入口不在 PATH，但已由桌面安装注册 |
| 测试 Vault | PASS（结构检查） | 已发现 `masterkey.cryptomator`、`vault.cryptomator`、`c` 和 `d`；此前可见的非元数据文件已由用户处理 |
| WinFsp 挂载点约束 | PASS（已发现） | `WinFspMountProvider` 只接受盘符，或已存在父目录下尚不存在的路径节点；预先创建的空目录会失败 |
| 受控解锁与 stdin | PASS | 测试程序使用参数数组、`shell: false`，将密码连同换行以一次 stdin 写入后关闭输入流；未记录密码 |
| 挂载与临时读写 | PASS | 检测到挂载点状态变化；经用户确认后写入、读回并删除临时探针文件 |
| 卸载 | PASS（共享控制台 Ctrl+C） | CLI 在 Ctrl+C 后退出，退出码 `0xC000013A`；未使用强制终止。完成 URI 验证后的最终卸载再次确认挂载路径不可访问且无残留 CLI 进程 |
| Node/Electron 程序化停止 | PASS（Node harness） | 隐藏窗口 `spawn` 后由 Node 发送 `SIGINT`；CLI 退出后挂载点在限定时间内不可访问，未使用强制终止 |
| Obsidian URI 启动方式 | PASS | 通过 Windows 标准 URI 处理器与已注册 Vault ID 创建一次性测试笔记，并以 `paneType=window` 在独立窗口打开；未依赖 Electron 内部 API，测试笔记已在最终卸载前删除 |
| 无主挂载重载处理 | PASS（测试程序） | 新实例在可访问挂载且无自身句柄时返回 `error` 与人工恢复指引；未重复挂载、猜测 PID 或执行卸载 |

## 尚未执行的验证

以下项目属于插件实现后的集成重验：

1. 在实际插件生命周期中模拟 reload、Obsidian 重启和 CLI 意外退出，确认无进程句柄时只进入 `error` 并提示人工恢复。

## 后续自动验证记录

- 使用 Node harness 从本机开发凭据文件读取密码、以结构化参数启动 CLI，并以隐藏窗口模式发送 `SIGINT`：解锁成功，CLI 退出后挂载点在限定时间内不可访问；未使用强制终止。
- 使用独立进程组发送 `CTRL_BREAK_EVENT` 的尝试无法附着到 CLI 控制台（Win32 error 6），且未能在超时内完成收敛；该方式不能作为生产实现依据。
- 本次结果解除“密码无法解锁”和“隐藏窗口停止机制未验证”的阻断；实际插件生命周期仍需在插件实现后执行集成重验。

## 最终清理

- 已删除 URI 弹窗测试笔记；未保留测试明文文件。
- 最终卸载后挂载路径不存在，`cryptomator-cli` 进程数为零。

## 阻断处理

项目不会下载、安装、修改或捆绑 Cryptomator CLI、WinFsp 或 Obsidian。首次受控解锁尝试证明 `WinFspMountProvider` 不接受预先创建的目录；临时空目录已删除，随后使用同名但不存在的路径节点完成验证。Node 隐藏窗口 `SIGINT` 已完成受控验证；不得使用 `taskkill`、强制卸载、猜测 mounter 标识或以降低安全边界的方式绕过失败。
