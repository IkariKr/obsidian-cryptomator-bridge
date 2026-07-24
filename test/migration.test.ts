import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateFolderContents, removeMigratedSource } from '../src/migration';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('folder migration', () => {
  it('copies nested content, verifies it, and keeps the source by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-migration-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const destination = path.join(root, 'mount');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    await mkdir(destination);
    await writeFile(path.join(source, 'note.md'), '# private');
    await writeFile(path.join(source, 'nested', 'image.txt'), 'content');

    await expect(migrateFolderContents(source, destination)).resolves.toEqual({ files: 2, directories: 1, bytes: 16 });
    await expect(readFile(path.join(destination, 'note.md'), 'utf8')).resolves.toBe('# private');
    await expect(readFile(path.join(destination, 'nested', 'image.txt'), 'utf8')).resolves.toBe('content');
    await expect(readFile(path.join(source, 'note.md'), 'utf8')).resolves.toBe('# private');
  });

  it('does not merge into a non-empty destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-migration-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const destination = path.join(root, 'mount');
    await mkdir(source);
    await mkdir(destination);
    await writeFile(path.join(destination, 'existing.md'), 'keep');
    await expect(migrateFolderContents(source, destination)).rejects.toThrow('不是空目录');
  });

  it('deletes only an explicitly selected non-root source under the control Vault', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-migration-'));
    roots.push(root);
    const source = path.join(root, 'control', 'private');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'note.md'), 'private');
    await removeMigratedSource(source, path.join(root, 'control'));
    await expect(readFile(path.join(source, 'note.md'))).rejects.toBeDefined();
  });

  it('rejects deleting the control Vault root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-migration-'));
    roots.push(root);
    await expect(removeMigratedSource(root, root)).rejects.toThrow('非根文件夹');
  });

  it('does not delete a source that changed after migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ocb-migration-'));
    roots.push(root);
    const control = path.join(root, 'control');
    const source = path.join(control, 'private');
    const destination = path.join(root, 'mount');
    await mkdir(source, { recursive: true });
    await mkdir(destination);
    await writeFile(path.join(source, 'note.md'), 'before');
    await migrateFolderContents(source, destination);
    await writeFile(path.join(source, 'note.md'), 'changed');
    await expect(removeMigratedSource(source, control, destination)).rejects.toThrow('未删除源文件');
    await expect(readFile(path.join(source, 'note.md'), 'utf8')).resolves.toBe('changed');
  });
});
