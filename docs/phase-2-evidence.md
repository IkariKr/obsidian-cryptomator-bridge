# 阶段 2：前置检查与安全解锁证据

> 状态：PASS（代码与自动测试）；真实插件 UI 流程待阶段 4 手工验收。

## 交付物

- `src/pathValidation.ts`：绝对路径、路径重叠、根目录、reparse/junction、父目录可写、空挂载节点和已知同步根检查。
- `src/prerequisites.ts`：CLI `0.6.2`、实际 mounter、Vault 结构和路径前置检查。
- `src/cliSupervisor.ts`：结构化参数、`shell:false`、隐藏窗口、stdin 一次写入、有限挂载轮询、进程所有权和优雅 `SIGINT` 停止。
- `src/diagnostics.ts`：跨 chunk 脱敏、有界诊断和截断标记。
- `src/errors.ts`：用户可行动的脱敏错误类型。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 路径重叠、当前 Vault 内、已有挂载节点 | PASS；自动测试覆盖 |
| reparse/junction、根目录和父目录可写边界 | PASS；实现已隔离在路径校验模块 |
| CLI 版本和 mounter seam | PASS；自动测试覆盖版本/mounter 不匹配 |
| 参数数组与密码隔离 | PASS；自动测试确认密码不在参数中 |
| `shell:false`、`windowsHide:true`、stdin 一次写入 | PASS；注入 spawn 测试覆盖 |
| stdout/stderr 脱敏、跨 chunk 和 8 KiB 上限 | PASS；自动测试覆盖 |
| 真实 CLI 隐藏窗口解锁与停止 | PASS；阶段 0 harness 已验证 |

真实密码仅在 Password Modal/开发 harness 运行时存在，不进入设置、日志、参数、环境变量或测试夹具。
