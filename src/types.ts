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

/**
 * 唯一私密 Vault 的非敏感配置；不包含密码。
 * Non-sensitive configuration for the one private vault; does not contain a password.
 */
export interface BridgeSettings {
  schemaVersion: 1;
  cliPath: string;
  encryptedVaultPath: string;
  mountPath: string;
  mounterId: string;
  privateVaultName: string;
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
