/**
 * Small durable JSON files in the app's user-data folder.
 *
 * Two things outlive a restart but are not session history: the multi-agent run's
 * state, and the queue of commands waiting for the Chrome extension. Both are tiny,
 * both are rewritten whole, and losing either one silently is the failure that matters
 * — a pending worker→prime message or a "resume in a new chat" command that evaporates
 * because the app was reopened is exactly the class of loss this app exists to prevent.
 *
 * So: write to a temp file, rename over the target (atomic on NTFS), and coalesce
 * bursts on a short timer so a chatty broker does not rewrite the file per message.
 * A parse failure returns null rather than throwing — a corrupt state file must cost
 * the pending work, never the app's ability to start.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';

const WRITE_DELAY_MS = 300;
const RETRY_MAX_MS = 5_000;

let root = '';
interface PendingWrite {
  generation: number;
  value: unknown;
  snapshot?: () => unknown;
  background?: boolean;
  work?: Promise<void>;
}

const pending = new Map<string, PendingWrite>();
const timers = new Map<string, NodeJS.Timeout>();
const retryAttempts = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
const journalInFlight = new Map<string, Promise<void>>();
const journalPoisoned = new Map<string, Error>();
let nextGeneration = 1;

export function initDurableStore(userDataDir: string): void {
  root = path.join(userDataDir, 'state');
}

export function durableStoreReady(): boolean {
  return root !== '';
}

function fileFor(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable state name: ${name}`);
  return path.join(root, `${name}.json`);
}

function journalFileFor(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable journal name: ${name}`);
  return path.join(root, `${name}.jsonl`);
}

export async function readDurable<T>(name: string): Promise<T | null> {
  if (!root) return null;
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logWarn(`could not read ${name} state: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Reads security-sensitive legacy state without converting corruption or I/O failure into absence.
 * ENOENT alone means there is no older state to migrate.
 */
export async function readDurableStrict<T>(name: string): Promise<T | null> {
  if (!root) throw new Error('Durable store is not initialized');
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logWarn(`could not read security-sensitive ${name} state: ${(err as Error).message}`);
    throw err;
  }
}

/** Reads an append-only security journal. Only ENOENT is an empty journal. */
export async function readDurableJournal<T>(name: string): Promise<T[]> {
  if (!root) throw new Error('Durable store is not initialized');
  let raw: string;
  try {
    raw = await fs.readFile(journalFileFor(name), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    logWarn(`could not read ${name} journal: ${(err as Error).message}`);
    throw err;
  }
  const rows: T[] = [];
  const terminated = raw.endsWith('\n');
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    // Only the final unterminated fragment can be an unacknowledged crash append. A malformed
    // newline-terminated record sat inside a commit boundary and must fail closed: silently
    // skipping it could turn an immutable security fact back into "unowned".
    if (!terminated && index === lines.length - 1) break;
    try { rows.push(JSON.parse(line) as T); }
    catch { throw new Error(`Durable ${name} journal contains a malformed committed record`); }
  }
  return rows;
}

/** Whether a journal file exists. Read errors are authority failures, not absence. */
export async function durableJournalExists(name: string): Promise<boolean> {
  if (!root) throw new Error('Durable store is not initialized');
  try {
    return (await fs.stat(journalFileFor(name))).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function enqueueJournal(name: string, write: () => Promise<void>): Promise<void> {
  const queued = (journalInFlight.get(name) ?? Promise.resolve()).then(write);
  const tracked = queued.catch(() => undefined).then(() => {
    if (journalInFlight.get(name) === tracked) journalInFlight.delete(name);
  });
  journalInFlight.set(name, tracked);
  return queued;
}

async function discardTornJournalTail(file: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r+');
    const stat = await handle.stat();
    if (stat.size === 0) return;
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, stat.size - 1);
    if (byte[0] === 0x0a) return;

    // Search backwards for the last committed newline without materialising an unbounded journal.
    // Everything after it belongs to the one append whose process died before completion.
    const chunk = Buffer.allocUnsafe(4096);
    let cursor = stat.size;
    while (cursor > 0) {
      const wanted = Math.min(chunk.length, cursor);
      cursor -= wanted;
      const { bytesRead } = await handle.read(chunk, 0, wanted, cursor);
      for (let at = bytesRead - 1; at >= 0; at--) {
        if (chunk[at] !== 0x0a) continue;
        await handle.truncate(cursor + at + 1);
        return;
      }
    }
    await handle.truncate(0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Appends one immutable journal record and returns only after that exact append has completed.
 *
 * Appends to one journal are serialized. This is deliberately an admission barrier rather than a
 * debounced projection: callers may publish the fact to other subsystems only after this promise
 * resolves. A rejected append publishes nothing and is safe for the caller to retry.
 */
export async function appendDurableJournal(name: string, value: unknown): Promise<void> {
  if (!root) throw new Error('Durable store is not initialized');
  const line = `${JSON.stringify(value)}\n`;
  await enqueueJournal(name, async () => {
    const poisoned = journalPoisoned.get(name);
    if (poisoned) throw poisoned;
    await fs.mkdir(root, { recursive: true });
    const file = journalFileFor(name);
    await discardTornJournalTail(file);
    let before = 0;
    try {
      before = (await fs.stat(file)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await fs.appendFile(file, line, 'utf8');
    } catch (error) {
      // appendFile may reject after writing all or part of the bytes. Until that ambiguity is
      // removed, allowing another first-owner commit could make restart order disagree with the
      // owners we ACKed in memory. Roll back to the exact pre-append boundary; if rollback itself
      // fails, poison this journal for the rest of the process and fail closed.
      try {
        await fs.truncate(file, before);
      } catch (rollbackError) {
        if (before === 0 && (rollbackError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        const poisonedError = new Error(
          `Durable ${name} journal append failed and rollback also failed: ${(rollbackError as Error).message}`
        );
        journalPoisoned.set(name, poisonedError);
        throw poisonedError;
      }
      throw error;
    }
  });
}

function nextWrite(value: unknown): PendingWrite {
  return { generation: nextGeneration++, value };
}

function enqueue(name: string, write: () => Promise<void>): Promise<void> {
  const queued = (inFlight.get(name) ?? Promise.resolve()).then(write);
  // Only generations of the same file share a temp path and require serialization.
  // Cross-file transaction boundaries belong to the caller's explicit await.
  const tracked = queued.catch(() => undefined).then(() => {
    if (inFlight.get(name) === tracked) inFlight.delete(name);
  });
  inFlight.set(name, tracked);
  return queued;
}

function enqueueSlot(name: string, slot: PendingWrite): Promise<void> {
  if (slot.work) return slot.work;
  const work = enqueue(name, () => flushOne(name, slot));
  slot.work = work;
  const settled = (): void => { delete slot.work; };
  void work.then(settled, settled);
  return work;
}

function schedule(name: string, delay: number): void {
  if (timers.has(name) || !pending.has(name)) return;
  const timer = setTimeout(() => {
    timers.delete(name);
    const slot = pending.get(name);
    if (!slot) return;
    void enqueueSlot(name, slot).catch(() => scheduleRetry(name));
  }, delay);
  timer.unref?.();
  timers.set(name, timer);
}

function scheduleRetry(name: string): void {
  if (!pending.has(name) || timers.has(name)) return;
  const attempt = (retryAttempts.get(name) ?? 0) + 1;
  retryAttempts.set(name, attempt);
  const delay = Math.min(RETRY_MAX_MS, WRITE_DELAY_MS * 2 ** Math.min(attempt, 4));
  schedule(name, delay);
}

async function flushOne(name: string, slot: PendingWrite): Promise<void> {
  if (slot.background && pending.get(name) !== slot) return;
  const target = fileFor(name);
  const tmp = `${target}.tmp`;
  try {
    // Capture once, synchronously at the write boundary. A failed disk write retries this
    // exact value; later live mutations must not silently alter its generation.
    if (slot.snapshot) {
      slot.value = slot.snapshot();
      delete slot.snapshot;
    }
    await fs.mkdir(root, { recursive: true });
    if (slot.value === null) {
      await fs.rm(target, { force: true });
    } else {
      await fs.writeFile(tmp, JSON.stringify(slot.value), 'utf8');
      await fs.rename(tmp, target);
    }
  } catch (err) {
    logWarn(`could not save ${name} state: ${(err as Error).message}`);
    throw err;
  }

  // A newer generation may have arrived while this one was on disk. Completing the older
  // write is still useful, but it must never erase the newer pending snapshot.
  if (pending.get(name)?.generation === slot.generation) {
    pending.delete(name);
    retryAttempts.delete(name);
  }
}

/** Queues a write. Repeated calls before the timer fires collapse into one. */
export function writeDurableSoon(name: string, value: unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(value), background: true });
  if (timers.has(name)) return;
  schedule(name, WRITE_DELAY_MS);
}

/** Coalesces background projections before allocating a snapshot. Never use for a commit barrier. */
export function writeDurableSnapshotSoon(name: string, snapshot: () => unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(undefined), snapshot, background: true });
  schedule(name, WRITE_DELAY_MS);
}

/**
 * Atomically writes one named state before returning.
 *
 * Used for transaction intent immediately before another durable commit: a debounced
 * snapshot is correct for ordinary progress, but cannot close a crash window between two
 * files when recovery needs to know which side of the boundary the process reached.
 */
export async function writeDurableNow(name: string, value: unknown): Promise<void> {
  if (!root) return;
  const timer = timers.get(name);
  if (timer) {
    clearTimeout(timer);
    timers.delete(name);
  }
  const slot = nextWrite(value);
  pending.set(name, slot);
  try {
    // Flush this exact generation even if a newer debounced value arrives while it waits in
    // the serialization queue. Transactional callers need proof that *their* boundary landed,
    // not merely that some later state happened to be written instead.
    await enqueueSlot(name, slot);
  } catch (err) {
    // Keep the newest pending generation recoverable. Callers which deliberately roll a
    // failed staged transition back can supersede it by queueing their safe snapshot.
    scheduleRetry(name);
    throw err;
  }
}

/** Writes everything queued right now. Called before the app quits, and by tests. */
export async function flushDurable(): Promise<void> {
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    timers.delete(name);
  }
  // A failed background write deliberately survives without a timer until retry scheduling,
  // so shutdown must look at pending state itself rather than treating `timers` as authority.
  for (;;) {
    const entries = [...pending.entries()];
    const active = [...inFlight.values(), ...journalInFlight.values()];
    if (entries.length === 0 && active.length === 0) return;
    // Start pending independent files before waiting for a busy file. Reuse an admitted
    // generation's promise so shutdown cannot write an immediate commit twice.
    const results = await Promise.allSettled([...active, ...entries.map(([name, slot]) => enqueueSlot(name, slot))]);
    // Every independent file gets its shutdown attempt, even when another fails.
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Test seam: drops queued writes without touching disk. */
export function resetDurableForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  retryAttempts.clear();
  root = '';
  nextGeneration = 1;
  inFlight.clear();
  journalInFlight.clear();
  journalPoisoned.clear();
}
