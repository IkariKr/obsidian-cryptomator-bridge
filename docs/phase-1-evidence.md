# 阶段 1：插件基础与配置契约证据

> 状态：PASS（静态实现与自动测试）
>
> 本文不保存密码、个人路径、Vault 数据或未脱敏诊断。开发凭据只存在于本机未纳入版本控制的 `docs/凭据.txt`。

## 交付物

- `manifest.json`：插件 ID 为 `obsidian-cryptomator-bridge`，标记为 desktop-only。
- `package.json`、`tsconfig.json`、`esbuild.config.mjs`：TypeScript 构建与检查流程。
- `src/settings.ts`：v1 设置契约、首版无版本号数据迁移、敏感字段拒绝和安全默认值。
- `src/stateMachine.ts`：受控状态转换；`error` 只允许回到 `reconciling`。
- `src/main.ts`：Obsidian 插件入口、设置页和受控解锁/锁定命令。
- `test/settings.test.ts`、`test/stateMachine.test.ts`：设置与状态机单元测试。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm install` | PASS；依赖安装完成，npm audit 未发现漏洞 |
| `npm run check` | PASS；TypeScript 无错误 |
| `npm test` | PASS；2 个测试文件、9 个测试通过 |
| `npm run build` | PASS；生成 `main.js`，构建产物已被 `.gitignore` 排除 |
| 密码进入设置模型 | PASS（拒绝）；设置类型、默认值、运行时状态和测试夹具均不包含真实密码 |

## 已知限制

- 阶段 0 的 Node/Electron 优雅停止机制仍未验证，因此阶段 2 和阶段 3 尚未开始。
- 阶段 1 的设置页当前只保存非敏感配置；依赖检查、挂载、Vault 启动和安全锁定由后续阶段实现。
