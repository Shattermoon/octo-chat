import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  appendEvent,
  createSession,
  deleteSession,
  endSession,
  findSessionByConversation,
  flushSessions,
  getSession,
  indexedSessions,
  initSessionStore,
  pruneSessions,
  rebindSession,
  resetSessionStoreForTests,
  saveHandoff,
  sessionDirectoryMissing,
  sessionsRoot,
  unsetSessionRootForTests,
  waitForConversationDeletionSettlement,
  writeAsset
} from '../src/main/session/store.js';
import { resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import { endResumeClaim, noteResumeOpening, resetResumeGate } from '../src/main/session/resume-gate.js';
import { makeTempDir, removeTempDir } from './helpers.js';

interface Gate {
  entered: Promise<void>;
  release(): void;
  hold(): Promise<void>;
}

function gate(): Gate {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { entered: reached, release, hold: async () => { entered(); await held; } };
}

describe('session deletion lifecycle fence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('octo-session-delete-');
    initConfigPath(dir);
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
    initSessionStore(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetResumeGate();
    resetRecorderForTests();
    resetSessionStoreForTests();
    unsetSessionRootForTests();
    await removeTempDir(dir);
  });

  it('prevents a paused cold reconstruction from publishing or recreating a deleted session', async () => {
    const summary = await createSession({ conversationId: 'delete-cold-reconstruct' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'durable seed', truncated: false, chars: 12 }
    });
    await endSession(summary.id);

    const pause = gate();
    const realRead = fs.readFile.bind(fs);
    let held = false;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (!held && target === path.join(sessionsRoot(), summary.id, 'meta.json')) {
        held = true;
        await pause.hold();
      }
      return realRead(...args);
    });

    const lateAppend = appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'progress',
      message: { text: 'must not resurrect', truncated: false, chars: 18 }
    });
    await pause.entered;
    const deleting = deleteSession(summary.id);
    expect(await sessionDirectoryMissing(summary.id)).toBe(false);
    pause.release();

    await expect(lateAppend).rejects.toThrow(/lifecycle|deleted/i);
    await deleting;
    expect(await getSession(summary.id)).toBeNull();
    expect(await sessionDirectoryMissing(summary.id)).toBe(true);
    await expect(appendEvent(summary.id, {
      time: 3, source: 'extension', kind: 'turn_start'
    })).rejects.toThrow(/deleted/i);
    await expect(fs.stat(path.join(sessionsRoot(), summary.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains initialization that was already visible before deleting the session', async () => {
    const pause = gate();
    const realWrite = fs.writeFile.bind(fs);
    let held = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (!held && target.endsWith(`${path.sep}events.jsonl`)) {
        held = true;
        await pause.hold();
      }
      return realWrite(...args);
    });

    const creating = createSession({ conversationId: 'delete-while-creating' });
    await pause.entered;
    const visible = await findSessionByConversation('delete-while-creating');
    expect(visible).not.toBeNull();
    const deleting = deleteSession(visible!.id);
    pause.release();

    await expect(creating).rejects.toThrow(/lifecycle|deleted/i);
    await deleting;
    expect(await getSession(visible!.id)).toBeNull();
    expect(await findSessionByConversation('delete-while-creating')).toBeNull();
    await expect(fs.stat(path.join(sessionsRoot(), visible!.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains an admitted asset write and refuses new direct writes after deletion', async () => {
    const summary = await createSession({ conversationId: 'delete-asset-write' });
    const pause = gate();
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${path.sep}${summary.id}${path.sep}assets${path.sep}`)) await pause.hold();
      return realWrite(...args);
    });

    const asset = writeAsset(summary.id, Buffer.from('asset-before-delete'), 'text/plain');
    await pause.entered;
    const deleting = deleteSession(summary.id);
    expect(await sessionDirectoryMissing(summary.id)).toBe(false);
    pause.release();
    await asset;
    await deleting;

    await expect(writeAsset(summary.id, Buffer.from('late-asset'), 'text/plain')).rejects.toThrow(/deleted/i);
    await expect(saveHandoff({
      id: '2026-09-15-latehandoff', sessionId: summary.id, createdAt: Date.now(), text: 'late',
      sourceEvents: 0, sourceTokens: 0, notes: []
    })).rejects.toThrow(/deleted/i);
  });

  it('drains an admitted handoff write before retiring the canonical directory', async () => {
    const summary = await createSession({ conversationId: 'delete-handoff-write' });
    const pause = gate();
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${path.sep}${summary.id}${path.sep}handoffs${path.sep}`)) await pause.hold();
      return realWrite(...args);
    });
    const saving = saveHandoff({
      id: '2026-09-15-handoff', sessionId: summary.id, createdAt: Date.now(), text: 'carry',
      sourceEvents: 0, sourceTokens: 0, notes: []
    });
    await pause.entered;
    const deleting = deleteSession(summary.id);
    pause.release();
    await saving;
    await deleting;
    expect(await getSession(summary.id)).toBeNull();
  });

  it('suppresses a metadata flush that races after deletion has entered its tombstone transaction', async () => {
    const summary = await createSession({ conversationId: 'delete-meta-flush-race' });
    await appendEvent(summary.id, {
      time: 1, source: 'extension', kind: 'progress',
      message: { text: 'dirty metadata before delete', truncated: false, chars: 28 }
    });

    const commit = gate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), summary.id) && path.basename(String(to)).startsWith('.deleted-')) {
        await commit.hold();
      }
      return realRename(from, to);
    });

    const deleting = deleteSession(summary.id);
    await commit.entered;
    // enqueueSessionOperation checks lifecycle synchronously, but as an async function its refusal
    // is a rejected promise that flushSessionEntry's existing catch can deliberately suppress.
    await expect(flushSessions()).resolves.toBeUndefined();
    commit.release();
    await deleting;
    expect(await sessionDirectoryMissing(summary.id)).toBe(true);
  });

  it('coalesces duplicate deletes and restores active state when the atomic rename fails', async () => {
    const summary = await createSession({ conversationId: 'delete-rename-failure' });
    const source = path.join(sessionsRoot(), summary.id);
    const pause = gate();
    const realRename = fs.rename.bind(fs);
    let commits = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === source && path.basename(String(to)).startsWith('.deleted-')) {
        commits += 1;
        await pause.hold();
        throw Object.assign(new Error('busy deletion commit'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });

    const first = deleteSession(summary.id);
    await pause.entered;
    const second = deleteSession(summary.id);
    expect(await sessionDirectoryMissing(summary.id)).toBe(false);
    pause.release();
    await expect(first).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(second).rejects.toMatchObject({ code: 'EBUSY' });
    expect(commits).toBe(1);
    expect(await getSession(summary.id)).not.toBeNull();
    await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start' });

    vi.restoreAllMocks();
    await deleteSession(summary.id);
    expect(await getSession(summary.id)).toBeNull();
  });

  it('rebuilds conversation ownership when delete fails after racing session creation', async () => {
    const conversationId = 'delete-create-rollback-catalog';
    const initialize = gate();
    const realWrite = fs.writeFile.bind(fs);
    let held = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (!held && String(args[0]).endsWith(`${path.sep}events.jsonl`)) {
        held = true;
        await initialize.hold();
      }
      return realWrite(...args);
    });

    const creating = createSession({ conversationId });
    await initialize.entered;
    const visible = await findSessionByConversation(conversationId);
    expect(visible).not.toBeNull(); // also establishes the derived catalog before meta lands.

    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), visible!.id) && path.basename(String(to)).startsWith('.deleted-')) {
        throw Object.assign(new Error('delete commit failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    const deleting = deleteSession(visible!.id);
    expect(await findSessionByConversation(conversationId)).toBeNull();
    initialize.release();

    await expect(creating).rejects.toThrow(/lifecycle/i);
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await findSessionByConversation(conversationId)).toMatchObject({ id: visible!.id, conversationId });
  });

  it('makes a cold recorder wait for delete settlement before choosing a replacement session', async () => {
    const conversationId = 'delete-cold-recorder-wait';
    const originalId = await sessionForConversation(conversationId);
    expect(originalId).toBeTruthy();
    resetRecorderForTests(); // simulate a cold recorder while the durable session remains.

    const commit = gate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), originalId!) && path.basename(String(to)).startsWith('.deleted-')) {
        await commit.hold();
        throw Object.assign(new Error('delete commit failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    const deleting = deleteSession(originalId!);
    await commit.entered;
    expect(waitForConversationDeletionSettlement(conversationId)).not.toBeNull();

    let reopened = false;
    const reopening = sessionForConversation(conversationId).then((id) => { reopened = true; return id; });
    await Promise.resolve();
    expect(reopened).toBe(false);
    commit.release();
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await reopening).toBe(originalId);
  });

  it('fences a cold-store delete before durable lineage has finished loading', async () => {
    const conversationId = 'delete-cold-store-lineage';
    const originalId = await sessionForConversation(conversationId);
    expect(originalId).toBeTruthy();
    resetRecorderForTests();
    resetSessionStoreForTests();
    initSessionStore(dir); // simulate restart: no open row and no attachment catalog.

    const lineage = gate();
    const realRead = fs.readFile.bind(fs);
    let heldMeta = false;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (!heldMeta && String(args[0]) === path.join(sessionsRoot(), originalId!, 'meta.json')) {
        heldMeta = true;
        await lineage.hold();
      }
      return realRead(...args);
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), originalId!) && path.basename(String(to)).startsWith('.deleted-')) {
        throw Object.assign(new Error('cold-store delete commit failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });

    const deleting = deleteSession(originalId!);
    await lineage.entered;
    // The delete has fenced mutation but still does not know which conversation it owns. Creation
    // must conservatively join that transaction rather than treating the missing catalog row as
    // authority to mint a replacement.
    expect(waitForConversationDeletionSettlement(conversationId)).not.toBeNull();
    let settled = false;
    const reopening = sessionForConversation(conversationId).then((id) => { settled = true; return id; });
    await Promise.resolve();
    expect(settled).toBe(false);

    lineage.release();
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await reopening).toBe(originalId);
    expect((await indexedSessions()).filter((summary) => summary.conversationId === conversationId)).toHaveLength(1);
  });

  it('fences historical Compact & Resume lineage while deletion is unresolved', async () => {
    const sourceConversation = 'delete-historical-source';
    const currentConversation = 'delete-historical-current';
    const sessionId = await sessionForConversation(sourceConversation);
    expect(sessionId).toBeTruthy();
    expect(await rebindSession(sessionId!, sourceConversation, currentConversation)).toBe(true);
    resetRecorderForTests();

    const commit = gate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), sessionId!) && path.basename(String(to)).startsWith('.deleted-')) {
        await commit.hold();
        throw Object.assign(new Error('historical delete commit failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    const deleting = deleteSession(sessionId!);
    await commit.entered;
    expect(waitForConversationDeletionSettlement(sourceConversation)).not.toBeNull();

    let settled = false;
    const reopening = sessionForConversation(sourceConversation).then((id) => { settled = true; return id; });
    await Promise.resolve();
    expect(settled).toBe(false);
    commit.release();
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    // The old source remains superseded by the restored A→B lineage; it must not mint a new epoch.
    expect(await reopening).toBeNull();
    expect(await findSessionByConversation(currentConversation)).toMatchObject({ id: sessionId });
    expect((await indexedSessions()).filter((summary) => summary.chatIds.includes(sourceConversation))).toHaveLength(1);
  });

  it('rechecks deletion after a resume-settle wait before recreating a historical source chat', async () => {
    const sourceConversation = 'delete-after-resume-settle-source';
    const currentConversation = 'delete-after-resume-settle-current';
    const sessionId = await sessionForConversation(sourceConversation);
    expect(sessionId).toBeTruthy();
    expect(await rebindSession(sessionId!, sourceConversation, currentConversation)).toBe(true);
    resetRecorderForTests();

    const settleReached = gate();
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 50) settleReached.release();
      return realTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    noteResumeOpening('delete-after-resume-settle-token');
    let reopened = false;
    const reopening = sessionForConversation(sourceConversation).then((id) => { reopened = true; return id; });
    // `hold()` signals entry, so use it as a one-shot promise that resolves when the recorder has
    // armed its 50 ms resume-settle timer.
    await settleReached.hold();

    const commit = gate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), sessionId!) && path.basename(String(to)).startsWith('.deleted-')) {
        await commit.hold();
        throw Object.assign(new Error('delete during resume settle failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    const deleting = deleteSession(sessionId!);
    await commit.entered;
    endResumeClaim('delete-after-resume-settle-token');
    await new Promise<void>((resolve) => realTimeout(resolve, 80));
    expect(reopened).toBe(false);

    commit.release();
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await reopening).toBeNull();
    expect(await findSessionByConversation(currentConversation)).toMatchObject({ id: sessionId });
    expect((await indexedSessions()).filter((summary) => summary.chatIds.includes(sourceConversation))).toHaveLength(1);
  });

  it('does not let a rebind claim a conversation while its existing session deletion is unresolved', async () => {
    const sourceConversation = '11111111-1111-4111-8111-111111111111';
    const targetConversation = '22222222-2222-4222-8222-222222222222';
    const sourceId = await sessionForConversation(sourceConversation);
    const targetId = await sessionForConversation(targetConversation);
    expect(sourceId).toBeTruthy();
    expect(targetId).toBeTruthy();

    const commit = gate();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(sessionsRoot(), targetId!) && path.basename(String(to)).startsWith('.deleted-')) {
        await commit.hold();
        throw Object.assign(new Error('target deletion commit failed'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });

    const deleting = deleteSession(targetId!);
    await commit.entered;

    let rebound = false;
    const rebinding = rebindSession(sourceId!, sourceConversation, targetConversation).then((value) => {
      rebound = true;
      return value;
    });
    await Promise.resolve();
    expect(rebound).toBe(false);
    expect((await findSessionByConversation(sourceConversation))?.id).toBe(sourceId);
    expect((await getSession(sourceId!))?.conversationId).toBe(sourceConversation);

    commit.release();
    await expect(deleting).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await rebinding).toBe(false);
    expect((await findSessionByConversation(sourceConversation))?.id).toBe(sourceId);
    expect((await findSessionByConversation(targetConversation))?.id).toBe(targetId);
    expect((await indexedSessions()).filter((summary) => summary.conversationId === targetConversation)).toHaveLength(1);
  });

  it('pruning skips a session that is in the middle of becoming live again', async () => {
    const summary = await createSession({ conversationId: 'prune-opening-race' });
    await endSession(summary.id);
    await indexedSessions(); // Build the catalog before the cold reopen is paused.

    const pause = gate();
    const realRead = fs.readFile.bind(fs);
    let held = false;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (!held && target === path.join(sessionsRoot(), summary.id, 'meta.json')) {
        held = true;
        await pause.hold();
      }
      return realRead(...args);
    });

    const reopening = appendEvent(summary.id, {
      time: summary.updatedAt + 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reopening', truncated: false, chars: 9 }
    });
    await pause.entered;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(summary.updatedAt + 60 * 24 * 60 * 60 * 1000);
    expect(await pruneSessions(30)).toBe(0);
    pause.release();
    await reopening;
    expect(await getSession(summary.id)).not.toBeNull();
  });
});
