# 阶段 3：Vault 打开与安全锁定证据

> 状态：IMPLEMENTED（代码与自动测试）；Obsidian 实机 UI 验收待完成。

## 交付物

- `src/vaultLauncher.ts`：通过 `obsidian://open?vault=<encoded>&paneType=window` 打开已注册私密 Vault。
- `src/modals.ts`：一次性密码输入、同步根风险确认和锁定前文件关闭确认。
- `src/controller.ts`：`checking → mounting → mounted → unmounting` 编排、错误回收和统一 cleanup。
- `src/main.ts`：功能区锁图标、文件夹右键菜单、底部状态栏、命令面板、设置页按钮、插件 reload/onunload 清理入口。

说明：锁定/解锁作用于整个私密 Vault；文件夹右键菜单项只是操作入口，实际操作对象仍是设置中唯一的私密 Vault。也可从 Obsidian 功能区锁图标、命令面板（“解锁私密 Vault”/“锁定私密 Vault”）或插件设置页执行。

## 自动验证

- URI 编码与独立窗口参数：PASS。
- `mounted` 状态才能锁定：PASS；控制器测试覆盖。
- 无主挂载不认领：PASS；控制器测试覆盖。
- 警告未确认时不启动 CLI：PASS；控制器测试覆盖。
- 正常锁定只在 CLI 退出且挂载点不可访问后回到 `idle`：PASS；监督器和控制器路径已实现。
- 句柄/异常退出/超时保持 `error`，不强制终止：PASS；错误路径由监督器集中处理。

## 待手工验收

1. 在 Obsidian 控制 Vault 中启用插件并确认设置页加载。
2. 输入密码，确认私密 Vault 在独立窗口打开且控制窗口仍可执行锁定。
3. 关闭私密 Vault 文件后锁定，确认挂载目录消失。
4. 验证错误密码、占用文件、CLI 意外退出和 Obsidian reload/退出场景。
