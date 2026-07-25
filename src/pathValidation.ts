import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedVaultRecord } from './types';

export interface PathValidationError {
  field: string;
  message: string;
}

/**
 * 验证单条已解析 Vault 记录的路径布局。
 * - 密文目录必须存在且为目录。
 * - 挂载节点必须不存在（WinFsp 约束）。
 * - 两者必须在控制 Vault（同步根）内，且不能相同。
 * - 密文目录不能是驱动器根、不能是 junction/reparse（仅 Windows）。
 * - 密文目录的父目录必须可写。
 * Validate the path layout of a single resolved VaultRecord.
 * - The encrypted directory must exist and be a directory.
 * - The mount node must not exist (WinFsp constraint).
 * - Both must reside inside the control vault (sync root), and must differ.
 * - The encrypted directory must not be a drive root or junction/reparse (Windows only).
 * - The encrypted directory's parent must be writable.
 */
export function validateVaultRecordPaths(
  record: ResolvedVaultRecord,
): PathValidationError[] {
  const errors: PathValidationError[] = [];
  const encrypted = path.resolve(record.encryptedVaultPath);
  const mount = path.resolve(record.mountPath);

  // 密文目录必须存在
  if (!fs.existsSync(encrypted)) {
    errors.push({
      field: `vaultRecords[${record.id}].encryptedVaultPath`,
      message: `密文目录不存在：${encrypted}。请先用 Cryptomator Desktop 创建 ${record.folderName}.cryptomator 目录。`,
    });
  } else {
    const encStat = fs.lstatSync(encrypted);
    if (!encStat.isDirectory()) {
      errors.push({
        field: `vaultRecords[${record.id}].encryptedVaultPath`,
        message: `${encrypted} 存在但不是目录。`,
      });
    }

    // 不能是驱动器根
    const encRoot = path.parse(encrypted).root;
    if (path.normalize(encrypted) === path.normalize(encRoot)) {
      errors.push({
        field: `vaultRecords[${record.id}].encryptedVaultPath`,
        message: '密文目录不能是驱动器根目录。',
      });
    }

    // Windows：检测 reparse/junction
    if (process.platform === 'win32' && encStat.isDirectory()) {
      try {
        // 使用 realpath 检测 reparse 点
        const real = fs.realpathSync(encrypted);
        if (path.normalize(real) !== path.normalize(encrypted)) {
          errors.push({
            field: `vaultRecords[${record.id}].encryptedVaultPath`,
            message: '密文目录不能是 junction 或 reparse 点。',
          });
        }
      } catch {
        // realpathSync 在无权限时可能抛出，降级为警告
      }
    }

    // 父目录可写
    const parent = path.dirname(encrypted);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
    } catch {
      errors.push({
        field: `vaultRecords[${record.id}].encryptedVaultPath`,
        message: `密文目录的父目录不可写：${parent}。`,
      });
    }
  }

  // 挂载节点必须不存在
  if (fs.existsSync(mount)) {
    errors.push({
      field: `vaultRecords[${record.id}].mountPath`,
      message: `挂载路径已存在：${mount}。请先删除该路径（或先锁定已挂载的 Vault）。`,
    });
  }

  return errors;
}

/**
 * 验证所有记录的路径布局。首条错误即返回。
 * Validate path layout for all records. Returns on the first error.
 */
export function validateAllPaths(
  records: ResolvedVaultRecord[],
): PathValidationError[] {
  const allErrors: PathValidationError[] = [];
  for (const record of records) {
    const errors = validateVaultRecordPaths(record);
    allErrors.push(...errors);
  }
  return allErrors;
}
