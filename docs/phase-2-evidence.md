# 阶段 2：前置检查与安全解锁证据

> 状态：PASS（代码与自动测试）；真实插件 UI 流程待阶段 4 手工验收。

## 交付物

- `src/pathValidation.ts`：按 VaultRecord 校验路径布局（密文目录存在且为目录、挂载节点不存在、reparse/junction 检查、父目录可写）。
- `src/prerequisites.ts`：CLI 可执行性、挂载器列表发现（`discoverMounters`）、指定 mounter 在可用列表中、Vault 结构标记检查（`masterkey.cryptomator`/`vault.cryptomator`/`d`）。
- `src/cliSupervisor.ts`：`UnlockParams` 接口（cliPath + encryptedVaultPath + mountPath + mounterId）、结构化参数、`shell:false`、隐藏窗口、stdin 一次写入、有限挂载轮询、进程所有权和优雅 `SIGINT` 停止。
- `src/diagnostics.ts`：跨 chunk 脱敏、有界诊断和截断标记（无变动）。
- `src/errors.ts`：`BridgeError`、`MountError`、`UnownedMountError`、`PrerequisiteFailedError`。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 密文目录存在/不存在、挂载节点存在/不存在 | PASS；`validateVaultRecordPaths` 自动测试覆盖 |
| reparse/junction、根目录和父目录可写边界 | PASS；实现已隔离在路径校验模块 |
| 挂载器发现与不匹配拒绝 | PASS；`discoverMounters` + `checkPrerequisites` 自动测试 |
| 参数数组与密码隔离 | PASS；`createUnlockArgs` 测试确认密码不在参数中 |
| `shell:false`、`windowsHide:true`、stdin 一次写入 | PASS；注入 spawn 测试覆盖 |
| stdout/stderr 脱敏、跨 chunk 和 8 KiB 上限 | PASS；`RedactedDiagnostics` 自动测试覆盖 |
| 真实 CLI 隐藏窗口解锁与停止 | PASS；阶段 0 harness 已验证 |

真实密码仅在 Password Modal/开发 harness 运行时存在，不进入设置、日志、参数、环境变量或测试夹具。
