# 阶段 3：Vault 解锁与安全锁定证据

> 状态：IMPLEMENTED（代码与自动测试）；Obsidian 实机 UI 验收待完成。

## 交付物

- `src/controller.ts`：多会话管理器（`Map<recordId, VaultSession>`），每个 VaultSession 拥有独立的 `CliSupervisor` + `BridgeStateMachine`。`unlock(record, password)` / `lock(recordId)` / `lockAll()` / `cleanup()` / `reconcile()`。聚合状态计算（`computeOverallState`）供 UI 展示。
- `src/cliSupervisor.ts`：按 `UnlockParams` 结构化参数（cliPath + encryptedVaultPath + mountPath + mounterId），`onExit` 回调供进程存活监控。
- `src/migration.ts`：空挂载目录中的文件夹复制、逐文件 SHA-256 校验、源变更保护和明确确认后的源文件删除（逻辑无变动，目标路径改为 record 的 mountPath）。
- `src/autoLock.ts`、`src/desktopActivityMonitor.ts`：系统空闲与 Windows 锁屏自动锁定（`lockAll` 所有已挂载会话）。
- `src/main.ts`：多文件夹级右键菜单（按 folderName 匹配 VaultRecord → 配置/解锁/锁定/移除配置/迁移）；Nutstore 排除门禁（未确认前阻止解锁）；状态栏聚合显示（"已解锁 X/Y" / "🔒 N 个私密笔记库已锁定" / 错误）。

说明：明文挂载目录 `<folder>.cryptomator-mount` 直接出现在控制 Vault 文件树中，由 Obsidian 自动发现，不再通过独立窗口打开。解锁前必须确认 Nutstore 排除规则 `**/*.cryptomator-mount` 已配置。

## 自动验证

- 多会话 unlock/lock/cleanup：PASS；控制器测试覆盖。
- 无主挂载不认领：`reconcile` 仅检测，不认领。
- 聚合状态计算（all idle / all mounted / has error / has transition）：PASS；控制器内含 `computeOverallState`。
- 自动锁定遍历所有已挂载会话：PASS；`lockAll` 遍历 `sessions.keys()`。
- 文件夹迁移逐文件校验、非空目标拒绝、源变更不删除：PASS；`test/migration.test.ts` 覆盖（无变动）。
- 自动锁定只在已挂载时触发并复用锁定入口：PASS；`test/autoLock.test.ts` 覆盖（无变动）。
- CLI 进程意外退出时触发错误并清理会话：PASS；`setupProcessMonitor` 处理。

## 待手工验收

1. 在 Obsidian 控制 Vault 中启用插件并确认设置页加载，vaultRecords 列表显示。
2. 右键点击文件夹 → "配置为私密笔记库"，确认 Nutstore 排除确认勾选必填。
3. 未配置 Nutstore 排除时尝试解锁，确认门禁弹窗阻断。
4. 输入密码，确认明文挂载目录 `<folder>.cryptomator-mount` 出现在控制 Vault 文件树中。
5. 在明文目录中编辑文件，确认加密目录 `<folder>.cryptomator` 中密文变化。
6. 锁定后确认明文挂载目录消失，CLI 进程已退出。
7. 错误密码 → 错误提示，状态恢复可重试。
8. 系统空闲/锁屏自动锁定所有已挂载会话。
9. 多文件夹解锁/锁定互不干扰。
