/**
 * 插件支持的运行状态；密码不属于持久化状态。
 * Runtime states supported by the plugin; passwords are not part of persisted state.
 */
export type BridgeState =
  | 'reconciling'
  | 'idle'
  | 'checking'
  | 'mounting'
  | 'mounted'
  | 'unmounting'
  | 'error';

/** 自动锁定策略；0 分钟表示关闭空闲锁定。 / Automatic-lock policy; zero minutes disables idle locking. */
export interface AutoLockSettings {
  idleLockMinutes: number;
  lockOnScreenLock: boolean;
}

/**
 * 单个加密文件夹记录；folderName 不包含 .cryptomator / .cryptomator-mount 后缀。
 * A single encrypted folder record; folderName does not include the .cryptomator / .cryptomator-mount suffix.
 */
export interface VaultRecord {
  id: string;
  folderName: string;
  nutstoreExclusionConfirmed: boolean;
}

/**
 * 插件持久化设置；多文件夹级 Vault 记录列表。
 * Plugin persisted settings; multi-folder vault record list.
 */
export interface BridgeSettings {
  schemaVersion: 3;
  cliPath: string;
  syncRootPath: string;
  mounterId: string;
  vaultRecords: VaultRecord[];
  autoLock: AutoLockSettings;
}

/**
 * 已解析的单条 Vault 记录；密文路径和挂载路径由 folderName + syncRoot 派生，不持久化。
 * Resolved single vault record; encrypted and mount paths are derived from folderName + syncRoot and not persisted.
 */
export interface ResolvedVaultRecord extends VaultRecord {
  encryptedVaultPath: string;
  mountPath: string;
}

/**
 * 已解析的完整运行时配置；每条记录包含派生绝对路径。
 * Resolved full runtime configuration; every record includes derived absolute paths.
 */
export interface ResolvedBridgeSettings extends BridgeSettings {
  resolvedRecords: ResolvedVaultRecord[];
}

/**
 * 状态机事件；UI 只能发出受控事件，不能直接修改状态。
 * State-machine events; the UI may emit controlled events but cannot mutate state directly.
 */
export type BridgeEvent =
  | { type: 'RECONCILE' }
  | { type: 'PREREQUISITES_OK' }
  | { type: 'MOUNT_REQUESTED' }
  | { type: 'MOUNT_READY' }
  | { type: 'UNMOUNT_REQUESTED' }
  | { type: 'UNMOUNTED' }
  | { type: 'FAILED'; message: string };

/**
 * 运行时只保留状态和错误信息，不保留密码或持久化进程标识。
 * Runtime state contains only state and an error message, never a password or persisted process identifier.
 */
export interface BridgeRuntimeState {
  state: BridgeState;
  errorMessage?: string;
}
