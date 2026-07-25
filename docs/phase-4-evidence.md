# 阶段 4：完整集成与发布管理证据

> 状态：IN_PROGRESS
>
> 新架构迁移已完成（代码、自动测试、构建通过）；真实 Obsidian UI 手工验收待完成。

## 迁移完成项

| 项 | 状态 |
| --- | --- |
| `src/types.ts`：VaultRecord、ResolvedVaultRecord、BridgeSettings（v3，vaultRecords 列表） | ✅ |
| `src/settings.ts`：v3 契约、v2→v3 迁移、派生命名、多记录校验 | ✅ |
| `src/pathValidation.ts`：按记录校验（密文存在、挂载不存在、当前控制 Vault 边界、父目录和 Windows reparse point） | ✅ |
| `src/cliSupervisor.ts`：UnlockParams 接口、onExit 回调 | ✅ |
| `src/prerequisites.ts`：discoverMounters、CLI 版本门禁、checkPrerequisites（cli+mounter+vault） | ✅ |
| `src/controller.ts`：多会话 Map<recordId, VaultSession>、聚合状态、lockAll | ✅ |
| `src/main.ts`：多文件夹右键菜单、Nutstore 门禁、设置页记录列表、状态栏聚合 | ✅ |
| `src/modals.ts`：VaultSetupModal、PasswordModal、ConfirmModal、NutstoreExclusionModal | ✅ |
| `src/vaultLauncher.ts`：已删除（同 Vault 布局无需独立窗口） | ✅ |
| `src/migration.ts`：目标路径改为 record 的 mountPath | ✅ |
| `src/errors.ts`：新增 PrerequisiteFailedError | ✅ |
| 测试：6 个文件、66 个测试全部通过 | ✅ |
| `npm run build`：成功生成 main.js | ✅ |
| `manifest.json`：版本 1.0.0，描述已更新 | ✅ |
| `docs/` 阶段证据文档：已更新 | ✅ |

## 发布检查

| 检查 | 结果 |
| --- | --- |
| `npm run build` | PASS |
| `npm test` | PASS（66/66） |
| `npm run check` (tsc --noEmit) | PASS |
| 密码不在源码/测试夹具/日志/参数/环境变量 | PASS；`validateSettings` 拒绝 password/passphrase/secret 字段 |
| `npm pack --dry-run` | PASS；发布内容仅包含 LICENSE、README.md、main.js、manifest.json、package.json，不包含 `docs/凭据.txt` |

## 手工验收清单（待完成）

### 基础功能
- [ ] 1. 在 Obsidian 中启用插件，设置页正常显示（CLI 路径、同步根、挂载器 ID、自动锁定、记录列表）
- [ ] 2. 点击"发现挂载器"按钮，成功发现 WinFsp 挂载器
- [ ] 3. 右键文件夹 → "配置为私密笔记库"，Nutstore 排除确认勾选必填
- [ ] 4. 未确认排除规则时尝试解锁 → 门禁弹窗阻断
- [ ] 5. 确认排除规则后解锁 → 输入密码 → 明文目录出现在文件树中
- [ ] 6. 在明文目录中创建/编辑文件 → 密文目录可见变化
- [ ] 7. 右键 → "锁定私密笔记库" → 明文目录消失，CLI 进程退出

### 多文件夹
- [ ] 8. 配置第二个私密笔记库
- [ ] 9. 同时解锁两个私密记录，文件树中两个明文目录可见
- [ ] 10. 分别锁定两个 Vault，互不干扰

### 错误处理
- [ ] 11. 错误密码 → 错误提示，可重新输入
- [ ] 12. 密文目录不存在时解锁 → 提示"请先用 Cryptomator Desktop 创建"
- [ ] 13. CLI 路径错误时解锁 → 前置条件检查错误提示

### 自动锁定
- [ ] 14. 系统空闲 N 分钟后自动锁定所有已解锁 Vault
- [ ] 15. Windows 锁屏后自动锁定所有已解锁 Vault

### 迁移
- [ ] 16. 右键 → "迁移到私密笔记库" → 配置/解锁引导 → 文件复制 + 校验 → 确认删除明文源

### 配置管理
- [ ] 17. 设置页移除记录，确认后记录消失
- [ ] 18. 设置页"重置排除确认"，门禁重新生效

### 发布
- [ ] 19. `npm pack --dry-run` 确认 `docs/凭据.txt` 不在发布包中
- [ ] 20. 构建产物 `main.js` + `manifest.json` + `styles.css`（如有）即为完整发布包
