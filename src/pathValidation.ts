import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedVaultRecord } from './types';

export interface PathValidationError {
  field: string;
  message: string;
}

function sameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function comparable(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function addReparsePointError(
  targetPath: string,
  label: string,
  field: string,
  errors: PathValidationError[],
): void {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const realPath = fs.realpathSync.native(targetPath);
    if (comparable(realPath) !== comparable(targetPath)) {
      errors.push({ field, message: `${label}不能是 junction 或 reparse 点。` });
    }
  } catch {
    errors.push({ field, message: `${label}无法验证是否为 junction 或 reparse 点。` });
  }
}

function validateExistingDirectory(
  targetPath: string,
  label: string,
  field: string,
  errors: PathValidationError[],
): boolean {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(targetPath);
  } catch {
    errors.push({ field, message: `${label}不存在或不可访问：${targetPath}。` });
    return false;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    errors.push({ field, message: `${label}必须是非链接目录：${targetPath}。` });
    return false;
  }
  addReparsePointError(targetPath, label, field, errors);
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
  } catch {
    errors.push({ field, message: `${label}不可写：${targetPath}。` });
  }
  return true;
}

/**
 * 验证单条已解析 Vault 记录的路径布局。
 * - 密文目录必须存在且为目录。
 * - 挂载节点必须不存在，且其父目录必须已经存在并可写。
 * - 提供当前控制 Vault 路径时，密文和挂载路径必须位于该根目录内。
 * - Windows 下拒绝 junction/reparse point，避免路径边界被绕过。
 * Validate one resolved VaultRecord path layout.
 * - The ciphertext directory must exist and be a directory.
 * - The mount node must not exist; its parent must already exist and be writable.
 * - When supplied, both paths must stay inside the current control Vault root.
 * - On Windows, junctions/reparse points are rejected to prevent boundary bypasses.
 */
export function validateVaultRecordPaths(
  record: ResolvedVaultRecord,
  currentControlVaultPath?: string,
): PathValidationError[] {
  const errors: PathValidationError[] = [];
  const encrypted = path.resolve(record.encryptedVaultPath);
  const mount = path.resolve(record.mountPath);
  const controlRoot = currentControlVaultPath ? path.resolve(currentControlVaultPath) : undefined;
  const encryptedField = `vaultRecords[${record.id}].encryptedVaultPath`;
  const mountField = `vaultRecords[${record.id}].mountPath`;

  if (sameOrInside(encrypted, mount) || sameOrInside(mount, encrypted)) {
    errors.push({
      field: encryptedField,
      message: '密文目录与挂载目录不能相同或互相包含。',
    });
  }

  if (controlRoot) {
    if (!sameOrInside(controlRoot, encrypted)) {
      errors.push({
        field: encryptedField,
        message: '密文目录必须位于当前控制 Vault 内。',
      });
    }
    if (!sameOrInside(controlRoot, mount)) {
      errors.push({
        field: mountField,
        message: '挂载目录必须位于当前控制 Vault 内。',
      });
    }
    if (comparable(path.dirname(encrypted)) !== comparable(controlRoot)) {
      errors.push({
        field: encryptedField,
        message: '同步根路径必须与当前控制 Vault 根目录一致。',
      });
    }
    validateExistingDirectory(controlRoot, '当前控制 Vault', 'controlVaultPath', errors);
  }

  // 密文目录必须存在且不能是链接目录。
  try {
    const metadata = fs.lstatSync(encrypted);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      errors.push({ field: encryptedField, message: `密文目录必须是非链接目录：${encrypted}。` });
    } else {
      addReparsePointError(encrypted, '密文目录', encryptedField, errors);
    }
  } catch {
    errors.push({
      field: encryptedField,
      message: `密文目录不存在或不可访问：${encrypted}。请先用 Cryptomator Desktop 创建 ${record.folderName}.cryptomator 目录。`,
    });
  }

  const encryptedRoot = path.parse(encrypted).root;
  if (comparable(encrypted) === comparable(encryptedRoot)) {
    errors.push({ field: encryptedField, message: '密文目录不能是驱动器根目录。' });
  }

  const encryptedParent = path.dirname(encrypted);
  if (validateExistingDirectory(encryptedParent, '密文目录的父目录', encryptedField, errors)) {
    // 父目录可写检查已在 validateExistingDirectory 中完成。
  }

  // WinFsp 挂载点必须是已存在父目录下尚不存在的节点。
  try {
    const mountMetadata = fs.lstatSync(mount);
    if (mountMetadata.isSymbolicLink()) {
      errors.push({ field: mountField, message: `挂载路径不能是符号链接或 junction：${mount}。` });
    } else {
      errors.push({
        field: mountField,
        message: `挂载路径已存在：${mount}。请先删除该路径（或先锁定已挂载的 Vault）。`,
      });
    }
  } catch {
    // 挂载节点不存在是预期状态。
  }

  const mountParent = path.dirname(mount);
  validateExistingDirectory(mountParent, '挂载目录的父目录', mountField, errors);

  return errors;
}

/**
 * 验证所有记录的路径布局。
 * Validate path layout for all records.
 */
export function validateAllPaths(
  records: ResolvedVaultRecord[],
  currentControlVaultPath?: string,
): PathValidationError[] {
  const allErrors: PathValidationError[] = [];
  for (const record of records) {
    allErrors.push(...validateVaultRecordPaths(record, currentControlVaultPath));
  }
  return allErrors;
}
