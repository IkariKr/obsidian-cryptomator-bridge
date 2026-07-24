# 阶段 1：插件基础与配置契约证据

> 状态：PASS（静态实现与自动测试）
>
> 本文不保存密码、个人路径、Vault 数据或未脱敏诊断。开发凭据只存在于本机未纳入版本控制的 `docs/凭据.txt`。

## 交付物

- `manifest.json`：插件 ID 为 `obsidian-cryptomator-bridge`，标记为 desktop-only。
- `package.json`、`tsconfig.json`、`esbuild.config.mjs`：TypeScript 构建与检查流程。
- `src/settings.ts`：v2 设置契约、v1 绝对路径迁移、同步根目录/相对 Vault 路径、自动锁定策略、敏感字段拒绝和安全默认值。
- `src/stateMachine.ts`：受控状态转换；`error` 只允许回到 `reconciling`。
- `src/main.ts`：Obsidian 插件入口、配置向导、文件夹迁移入口、设置页和受控解锁/锁定命令。
- `src/modals.ts`：一次性密码输入和不含密码的首次配置向导。
- `src/autoLock.ts`、`src/desktopActivityMonitor.ts`：空闲/锁屏自动锁定边界。
- `test/settings.test.ts`、`test/stateMachine.test.ts`、`test/autoLock.test.ts`：设置、状态机和自动锁定单元测试。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm ci` | PASS；依赖安装完成，npm audit 未发现漏洞 |
| `npm run check` | PASS；TypeScript 无错误 |
| `npm test` | PASS；6 个测试文件、31 个测试通过 |
| `npm run build` | PASS；生成 `main.js`，构建产物已被 `.gitignore` 排除 |
| 密码进入设置模型 | PASS（拒绝）；设置类型、默认值、运行时状态和测试夹具均不包含真实密码 |

## 已知限制

- Cryptomator Desktop 的 Vault 创建仍由用户完成；插件只引导并登记配置，不调用未验证的 Desktop 自动化接口。
- 配置向导和迁移逻辑已有自动测试，但真实 Obsidian UI、真实 Cryptomator Vault 迁移和自动锁定仍需阶段 4 手工验收。
