/**
 * 可安全展示给用户的错误；message 不应包含密码或完整原始 CLI 输出。
 * User-facing safe error; message must not contain passwords or complete raw CLI output.
 */
export class BridgeError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BridgeError';
  }
}

/** 路径或设置不符合契约。 / Path or setting violates the configuration contract. */
export class ConfigurationError extends BridgeError {
  constructor(message: string) {
    super(message, 'configuration');
  }
}

/** 外部依赖检查失败。 / An external prerequisite check failed. */
export class PrerequisiteError extends BridgeError {
  constructor(message: string) {
    super(message, 'prerequisite');
  }
}

/** 挂载或卸载流程失败。 / Mount or unmount flow failed. */
export class MountError extends BridgeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'mount', options);
  }
}

/** 文件夹迁移或校验失败。 / Folder migration or verification failed. */
export class MigrationError extends BridgeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'migration', options);
  }
}

/** 检测到当前实例不拥有的挂载。 / A mount not owned by this instance was detected. */
export class UnownedMountError extends BridgeError {
  constructor() {
    super('检测到可访问的无主挂载，请由原持有者或用户手工恢复；插件不会重复挂载或擅自卸载。', 'unowned-mount');
  }
}

/** 前置条件检查失败，携带详细错误列表。 / Prerequisite checks failed, carrying detailed error list. */
export interface PrerequisiteCheckError {
  field: string;
  message: string;
}

export class PrerequisiteFailedError extends BridgeError {
  public readonly errors: PrerequisiteCheckError[];

  constructor(message: string, errors: PrerequisiteCheckError[]) {
    super(message, 'prerequisite-failed');
    this.errors = errors;
  }
}
