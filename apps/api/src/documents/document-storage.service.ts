import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Environment } from '../config/environment';

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMP_MAX_AGE_MS = 3_600_000;

/**
 * Private local storage for original uploads. Keys are generated here (never derived from user
 * input), files are only reachable through authenticated API calls, and every path is checked to
 * stay inside the storage root and not to be a symbolic link.
 */
@Injectable()
export class DocumentStorageService implements OnModuleInit {
  private readonly logger = new Logger(DocumentStorageService.name);
  readonly root: string;
  private readonly filesDir: string;
  readonly tempDir: string;

  constructor(config: ConfigService<Environment, true>) {
    this.root = config.get('DOCUMENT_STORAGE_DIR', { infer: true });
    this.filesDir = join(this.root, 'files');
    this.tempDir = join(this.root, 'tmp');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    await this.sweepTemporary();
  }

  /** A fresh temporary path on the same volume as the final location (so commit is an atomic rename). */
  newTemporaryPath(): string {
    return join(this.tempDir, `${randomUUID()}.part`);
  }

  newKey(): string {
    const id = randomUUID();
    return `${id.slice(0, 2)}/${id}`;
  }

  async commit(temporaryPath: string, key: string): Promise<void> {
    const target = this.resolveKey(key);
    await mkdir(join(this.filesDir, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    await rename(temporaryPath, target);
  }

  /** Locates an existing original (inside the root, a regular file, not a link), or null. */
  async locate(key: string): Promise<{ path: string; size: number } | null> {
    try {
      const target = this.resolveKey(key);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const real = await realpath(target);
      if (!real.startsWith((await realpath(this.filesDir)) + sep)) return null;
      return { path: target, size: info.size };
    } catch {
      return null;
    }
  }

  async open(key: string): Promise<{ stream: ReadStream; size: number } | null> {
    const located = await this.locate(key);
    return located === null ? null : { stream: createReadStream(located.path), size: located.size };
  }

  async remove(key: string): Promise<void> {
    try {
      await rm(this.resolveKey(key), { force: true });
    } catch {
      this.logger.warn('Could not remove a stored document file; the orphan sweeper will retry');
    }
  }

  async removeTemporary(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }

  /**
   * Orphan sweep: stored files without a database row (a crash between rename and insert, or a
   * failed delete) are removed after a grace period. Returns the number of files removed.
   */
  async sweepOrphans(known: ReadonlySet<string>, graceMs: number): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const shard of await readdir(this.filesDir).catch(() => [])) {
      for (const name of await readdir(join(this.filesDir, shard)).catch(() => [])) {
        const key = `${shard}/${name}`;
        if (!KEY_PATTERN.test(key) || known.has(key)) continue;
        const info = await stat(join(this.filesDir, key)).catch(() => null);
        if (info !== null && now - info.mtimeMs > graceMs) {
          await rm(join(this.filesDir, key), { force: true }).catch(() => undefined);
          removed += 1;
        }
      }
    }
    return removed;
  }

  async listKeys(): Promise<string[]> {
    const keys: string[] = [];
    for (const shard of await readdir(this.filesDir).catch(() => [])) {
      for (const name of await readdir(join(this.filesDir, shard)).catch(() => [])) {
        keys.push(`${shard}/${name}`);
      }
    }
    return keys;
  }

  /** Abandoned partial uploads from a previous process are cleaned up at start-up. */
  async sweepTemporary(): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(this.tempDir).catch(() => [])) {
      const path = join(this.tempDir, name);
      const info = await stat(path).catch(() => null);
      if (info !== null && now - info.mtimeMs > TEMP_MAX_AGE_MS) await rm(path, { force: true });
    }
  }

  private resolveKey(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('invalid storage key');
    return join(this.filesDir, key);
  }
}
