import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMetadata, walk } from '../src/main/codex/filesystem.js';
import { rawPromises } from '../src/main/rawfs.js';
import { DIR_LINK, makeTempDir, removeTempDir } from './helpers.js';

let base = '';

beforeAll(async () => {
  base = await makeTempDir('octo-walk-symlink-');
});

afterAll(async () => {
  await removeTempDir(base);
});

function options(followDirectorySymlinks: boolean) {
  return {
    maxDepth: 8,
    maxDirectories: 64,
    maxEntries: 256,
    followDirectorySymlinks
  };
}

function wasTargetStatCalled(spy: ReturnType<typeof vi.spyOn>, candidate: string): boolean {
  const expected = path.resolve(candidate);
  return spy.mock.calls.some((call: unknown[]) => path.resolve(String(call[0])) === expected);
}

describe('filesystem walk no-follow symlink boundary', () => {
  it('does not stat a child directory-link target before skipping the link', async () => {
    const root = path.join(base, 'child-root');
    const target = path.join(base, 'child-target');
    const link = path.join(root, 'escape-dir');
    await fs.mkdir(root);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'secret.txt'), 'outside walk root');
    await fs.symlink(target, link, DIR_LINK);
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      const outcome = await walk(root, options(false));
      expect(outcome.entries.some(entry => entry.path === link)).toBe(false);
      expect(outcome.entries.some(entry => entry.path.endsWith('secret.txt'))).toBe(false);
      expect(wasTargetStatCalled(stat, link)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it('does not stat through a root directory link when no-follow is selected', async () => {
    const target = path.join(base, 'root-target');
    const link = path.join(base, 'root-link');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'inside.txt'), 'target file');
    await fs.symlink(target, link, DIR_LINK);
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      expect(await walk(link, options(false))).toEqual({ entries: [], errors: [], truncated: false });
      expect(wasTargetStatCalled(stat, link)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it('skips an entry replaced by a directory link after readdir but before lstat', async () => {
    const root = path.join(base, 'replacement-root');
    const child = path.join(root, 'changing-entry');
    const target = path.join(base, 'replacement-target');
    await fs.mkdir(root);
    await fs.mkdir(child);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'outside.txt'), 'must not be discovered');

    const realReaddir = rawPromises.readdir.bind(rawPromises);
    let replaced = false;
    const readdir = vi.spyOn(rawPromises, 'readdir').mockImplementation(async (...args: Parameters<typeof rawPromises.readdir>) => {
      const entries = await realReaddir(...args as [any, any]);
      if (!replaced && path.resolve(String(args[0])) === path.resolve(root)) {
        replaced = true;
        await fs.rmdir(child);
        await fs.symlink(target, child, DIR_LINK);
      }
      return entries as any;
    });
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      const outcome = await walk(root, options(false));
      expect(replaced).toBe(true);
      expect(outcome.entries.some(entry => entry.path === child)).toBe(false);
      expect(outcome.entries.some(entry => entry.path.endsWith('outside.txt'))).toBe(false);
      expect(wasTargetStatCalled(stat, child)).toBe(false);
    } finally {
      readdir.mockRestore();
      stat.mockRestore();
    }
  });

  it('skips a dangling child directory link without turning the missing target into a walk error', async () => {
    const root = path.join(base, 'dangling-root');
    const target = path.join(base, 'dangling-target');
    const link = path.join(root, 'dangling-link');
    await fs.mkdir(root);
    await fs.mkdir(target);
    await fs.symlink(target, link, DIR_LINK);
    await fs.rmdir(target);
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      const outcome = await walk(root, options(false));
      expect(outcome.entries.some(entry => entry.path === link)).toBe(false);
      expect(outcome.errors).toEqual([]);
      expect(wasTargetStatCalled(stat, link)).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it('keeps public getMetadata link-follow behavior unchanged', async () => {
    const target = path.join(base, 'metadata-target');
    const link = path.join(base, 'metadata-link');
    await fs.mkdir(target);
    await fs.symlink(target, link, DIR_LINK);
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      expect(await getMetadata(link)).toMatchObject({ isDirectory: true, isSymlink: true });
      expect(wasTargetStatCalled(stat, link)).toBe(true);
    } finally {
      stat.mockRestore();
    }
  });

  it('retains the explicit follow behavior for a directory link', async () => {
    const target = path.join(base, 'follow-target');
    const link = path.join(base, 'follow-link');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'followed.txt'), 'follow me');
    await fs.symlink(target, link, DIR_LINK);
    const stat = vi.spyOn(rawPromises, 'stat');
    try {
      const outcome = await walk(link, options(true));
      expect(outcome.entries.some(entry => entry.path.endsWith('followed.txt'))).toBe(true);
      expect(wasTargetStatCalled(stat, link)).toBe(true);
    } finally {
      stat.mockRestore();
    }
  });
});
