import { mkdtemp, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendDurableJournal, flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import {
  observeRequestCorrelation,
  observeRequestCorrelations,
  commitRequestCorrelations,
  requestCorrelation,
  awaitRequestCorrelation,
  restoreRequestCorrelations,
  resetCorrelationRegistryForTests
} from '../src/main/session/correlation.js';

function attributedToolEvent(seq: number, requestId: string, conversationId: string, time = seq) {
  return {
    seq,
    time,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId: `call-${requestId}`,
      tool: 'read',
      attribution: 'request_id',
      requestId,
      conversationId,
      attributionMethod: 'request_id',
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'ok', truncated: false, chars: 2 },
      outcome: 'ok',
      durationMs: 1,
      summary: { kind: 'read', tone: 'neutral', title: `Read ${requestId}` }
    }
  };
}

describe('request correlation ownership', () => {
  beforeEach(() => resetCorrelationRegistryForTests());
  afterEach(() => vi.useRealTimers());

  it('spends grace once per request while accepting late exact evidence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-missing', 60);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await awaitRequestCorrelation('wfr-missing', 60)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const other = awaitRequestCorrelation('wfr-other', 60);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(await other).toBeNull();

    observeRequestCorrelation({ requestId: 'wfr-missing', conversationId: 'conv-late',
      sessionId: 'session-late', messageId: 'message-late', tool: '', observedAt: 1 });
    expect((await awaitRequestCorrelation('wfr-missing', 60))?.conversationId).toBe('conv-late');
  });

  it('shares a deadline across overlapping callers instead of restarting their grace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const first = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(40);
    const second = awaitRequestCorrelation('wfr-overlap', 100);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the remaining longer recorder grace after a shorter identity timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const short = awaitRequestCorrelation('wfr-longer', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-longer', 20);
    await vi.advanceTimersByTimeAsync(4);
    expect(vi.getTimerCount()).toBe(1);
    observeRequestCorrelation({ requestId: 'wfr-longer', conversationId: 'conv-proved',
      sessionId: 'session-proved', messageId: 'message-proved', tool: '', observedAt: 1 });
    expect((await longer)?.conversationId).toBe('conv-proved');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the longer grace at its original deadline and leaves zero-time lookups uncharged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    expect(await awaitRequestCorrelation('wfr-budget', 0)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const short = awaitRequestCorrelation('wfr-budget', 15);
    await vi.advanceTimersByTimeAsync(15);
    expect(await short).toBeNull();
    const longer = awaitRequestCorrelation('wfr-budget', 20);
    await vi.advanceTimersByTimeAsync(5);
    expect(await longer).toBeNull();
    expect(await awaitRequestCorrelation('wfr-budget', 20)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one turn-level request id owned across different MCP messages and tools', () => {
    const requestId = 'wfr_shared_turn';
    const now = Date.now();
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-read',
        tool: 'read',
        observedAt: now
      })
    ).toBe('stored');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-exec',
        tool: 'exec_command',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-session',
        tool: 'session',
        observedAt: now + 2
      })
    ).toBe('same');

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');
  });

  /**
   * The rule the whole registry exists to keep: a request id is bound to a chat once, and then
   * it is that chat's for good.
   *
   * A second conversation claiming a proven id is a page that is wrong about itself - a React
   * tree still mounted from the chat before it, a fresh chat whose client thread id has not
   * caught up. Believing it used to cost the id itself: the entry went permanently unresolved,
   * so every further call of a workflow that was still running waited fifteen seconds for
   * evidence that could no longer be accepted, and landed in Unattributed activity. Refusing
   * the claimant costs the claimant nothing that was ever really theirs.
   */
  it('keeps the first proven owner when a second conversation claims the same request id', () => {
    const requestId = 'wfr_cross_chat';
    const now = Date.now();
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'read',
      observedAt: now
    });
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-refresh',
        tool: 'read',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-b',
        sessionId: 'session-b',
        messageId: 'msg-b',
        tool: 'read',
        observedAt: now + 2
      })
    ).toBe('refused');
    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');

    // And the owner is still an owner afterwards, not a survivor in a degraded state: its own
    // later sightings keep being accepted exactly as they were before anyone argued.
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-later',
        tool: 'exec_command',
        observedAt: now + 3
      })
    ).toBe('same');
    expect(requestCorrelation(requestId)?.observedAt).toBe(now + 3);
  });

  it('does not age a proven request owner out just because the page evidence is old', () => {
    const requestId = 'wfr_long_running_workflow';
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'exec_command',
      // Deliberately ancient. 1.8.1 forgot this after ten minutes and started filing later
      // calls from the same still-running workflow into Unattributed activity.
      observedAt: 1
    });

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
  });

  it('never evicts immutable ownership when diagnostics exceed the former 50k bound', () => {
    const refreshedId = 'wfr_refreshed_old_request';
    const correlation = (requestId: string, observedAt: number) => ({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: `msg-${requestId}`,
      tool: 'read',
      observedAt
    });

    // Fill beyond the old authority bound. Diagnostic context may be pressure-evicted, but the
    // first owner is a security fact and must survive indefinitely.
    observeRequestCorrelations([
      correlation(refreshedId, 1),
      ...Array.from({ length: 49_999 }, (_, index) => correlation(`wfr_fill_${index}`, index + 2))
    ]);
    expect(
      observeRequestCorrelation({
        ...correlation(refreshedId, 100_000),
        messageId: 'msg-refreshed'
      })
    ).toBe('same');

    observeRequestCorrelation(correlation('wfr_newest', 100_001));

    expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(refreshedId)?.observedAt).toBe(100_000);
    expect(requestCorrelation('wfr_fill_0')?.conversationId).toBe('conv-a');
    expect(requestCorrelation('wfr_fill_0')?.sessionId).toBe('session-a');
  });

  it('does not publish a first owner until its exact journal append commits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-barrier-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const realAppend = fs.appendFile.bind(fs);
      vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return realAppend(...args);
      });
      const committing = commitRequestCorrelations([{
        requestId: 'wfr_commit_barrier', conversationId: 'conv-barrier', sessionId: 'session-barrier',
        messageId: 'message-barrier', tool: 'read', observedAt: 1
      }]);
      await reached;
      expect(requestCorrelation('wfr_commit_barrier')).toBeNull();
      release();
      await expect(committing).resolves.toEqual(['stored']);
      expect(requestCorrelation('wfr_commit_barrier')?.conversationId).toBe('conv-barrier');
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not publish an owner when the journal commit fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-failed-commit-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('disk failed'), { code: 'EIO' }));
      await expect(commitRequestCorrelations([{
        requestId: 'wfr_failed_commit', conversationId: 'conv-failed', sessionId: 'session-failed',
        messageId: 'message-failed', tool: 'read', observedAt: 1
      }])).rejects.toMatchObject({ code: 'EIO' });
      expect(requestCorrelation('wfr_failed_commit')).toBeNull();
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps journal authority when a stale v5 snapshot disagrees after downgrade', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-journal-wins-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await appendDurableJournal('request-owners', {
        version: 1,
        owners: [{ requestId: 'wfr_journal_wins', conversationId: 'conv-first', sessionId: 'session-first' }]
      });
      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_journal_wins', conversationId: 'conv-stale', sessionId: 'session-stale',
          messageId: 'stale', tool: 'read', observedAt: 999
        }]
      });
      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_journal_wins')?.conversationId).toBe('conv-first');
      expect(requestCorrelation('wfr_journal_wins')?.sessionId).toBe('session-first');
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unsupported committed owner-journal schema', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-bad-journal-schema-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      await appendDurableJournal('request-owners', {
        version: 99,
        owners: [{ requestId: 'wfr_bad_schema', conversationId: 'conv-bad', sessionId: 'session-bad' }]
      });
      resetCorrelationRegistryForTests();
      await expect(restoreRequestCorrelations()).rejects.toThrow('unsupported or invalid committed record');
      expect(requestCorrelation('wfr_bad_schema')).toBeNull();
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restores proven request ownership from durable state after an app restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'wfr_survives_restart';
      await commitRequestCorrelations([{
        requestId,
        conversationId: 'conv-durable',
        sessionId: 'session-durable',
        messageId: 'msg-durable',
        tool: 'read',
        observedAt: 123
      }]);

      resetCorrelationRegistryForTests();
      expect(requestCorrelation(requestId)).toBeNull();

      await restoreRequestCorrelations();
      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-durable');
      expect(requestCorrelation(requestId)?.sessionId).toBe('session-durable');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ChatGPT publishes `metadata.request_id` before the `api_tool` message that names the tool,
   * and the bridge stores that early sighting with an empty tool on purpose: the join never uses
   * the name, and waiting for it is what used to file the call under Unattributed activity. Two
   * such rows sat in the live 2026-09-01 registry. Both would have been thrown away on the next
   * launch by a validity check stricter than the registry's own answer, taking the proven owner
   * of a workflow whose calls could still be arriving.
   */
  it('restores an owner proved by a request id ChatGPT had not yet given a tool name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-untooled-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'f0f00012-1111-4111-8111-111111111111';
      await commitRequestCorrelations([{
        requestId,
        conversationId: 'conv-bare-request-id',
        sessionId: '2026-01-01-00000028',
        messageId: 'f0f00013-1111-4111-8111-111111111111',
        tool: '',
        observedAt: 1_788_276_631_192
      }]);

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();

      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-bare-request-id');
      expect(requestCorrelation(requestId)?.sessionId).toBe('2026-01-01-00000028');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates older proven owners and forgets the sticky conflicts those versions wrote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-v3-conflict-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await writeDurableNow('request-correlations', {
        version: 3,
        entries: [
          {
            requestId: 'wfr_v3_proven_owner',
            value: {
              requestId: 'wfr_v3_proven_owner',
              conversationId: 'conv-v3-proven',
              sessionId: 'session-v3-proven',
              messageId: 'message-v3-proven',
              tool: 'read',
              observedAt: 100
            },
            conflicted: false
          },
          {
            requestId: 'wfr_v3_false_conflict',
            value: null,
            conflicted: true
          }
        ]
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_v3_proven_owner')?.conversationId).toBe('conv-v3-proven');
      // Forgotten, not restored as a verdict: the id is simply unproved again, and the next page
      // that proves it owns it.
      expect(requestCorrelation('wfr_v3_false_conflict')).toBeNull();
      expect(
        observeRequestCorrelation({
          requestId: 'wfr_v3_false_conflict',
          conversationId: 'conv-after-migration',
          sessionId: 'session-after-migration',
          messageId: 'message-after-migration',
          tool: 'read',
          observedAt: 200
        })
      ).toBe('stored');
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds the first 1.8.2 owner index from already-attributed session history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-migrate-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);

      const session = await createSession({ title: 'old attributed history', conversationId: 'conv-history' });
      await appendEvent(session.id, {
        time: 200,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-history',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr_history',
          conversationId: 'conv-history',
          attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Read history' }
        }
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);

      await flushDurable();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates an owner older than the former 1,024-event recovery window', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-full-history-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-full-history';
      const session = await createSession({ title: 'deep attributed history', conversationId });
      const eventFile = path.join(dir, 'sessions', session.id, 'events.jsonl');
      const target = {
        seq: 2,
        time: 2,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-deep-history', tool: 'read', attribution: 'request_id',
          requestId: 'wfr_deep_history', conversationId, attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 }, outcome: 'ok', durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Deep history' }
        }
      };
      // Thousands of exact rows for one workflow exercise the streaming reducer directly: migration
      // must retain one recovered owner, not one in-memory object per historical tool call.
      const filler = Array.from({ length: 1_100 }, (_, index) =>
        JSON.stringify(attributedToolEvent(index + 3, 'wfr_deep_history', conversationId, index + 3))
      );
      const original = await fs.readFile(eventFile, 'utf8');
      await fs.writeFile(eventFile, `${original}${JSON.stringify(target)}\n${filler.join('\n')}\n`, 'utf8');

      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      const readSizes: number[] = [];
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (String(args[0]) === eventFile) {
          const realRead = handle.read.bind(handle);
          (handle as any).read = async (...readArgs: any[]) => {
            if (typeof readArgs[2] === 'number') readSizes.push(readArgs[2]);
            return (realRead as any)(...readArgs);
          };
        }
        return handle;
      });
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_deep_history')).toMatchObject({
        conversationId,
        sessionId: session.id
      });
      expect(readSizes.length).toBeGreaterThan(1);
      expect(Math.max(...readSizes)).toBeLessThanOrEqual(64 * 1024);
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers request ownership appended by an older build after the stored history watermark', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-watermark-suffix-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-watermark-suffix';
      const session = await createSession({ title: 'watermark suffix', conversationId });
      await appendEvent(session.id, attributedToolEvent(1, 'wfr_before_watermark', conversationId) as any);

      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_before_watermark')?.conversationId).toBe(conversationId);
      const firstWatermark = await readDurable<{ version: number; sessions: Record<string, number> }>('request-owner-migration');
      const committed = firstWatermark?.sessions[session.id] ?? 0;
      expect(committed).toBeGreaterThan(0);

      // Simulate an older binary appending exact attributed history and crashing before its
      // debounced v5 correlation snapshot changed. Only growth beyond our per-session watermark
      // can reveal this on re-upgrade.
      const eventFile = path.join(dir, 'sessions', session.id, 'events.jsonl');
      await fs.appendFile(eventFile, `${JSON.stringify(attributedToolEvent(2, 'wfr_after_watermark', conversationId, 2))}\n`, 'utf8');
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_after_watermark')).toMatchObject({ conversationId, sessionId: session.id });
      const nextWatermark = await readDurable<{ version: number; sessions: Record<string, number> }>('request-owner-migration');
      expect(nextWatermark?.sessions[session.id]).toBeGreaterThan(committed);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('imports a legacy snapshot-only owner even after history already has a watermark', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-watermark-snapshot-fallback-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'snapshot fallback', conversationId: 'conv-watermark-existing' });
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      expect((await readDurable<{ sessions: Record<string, number> }>('request-owner-migration'))?.sessions[session.id]).toBeGreaterThanOrEqual(0);

      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_snapshot_only_after_watermark',
          conversationId: 'conv-snapshot-only',
          sessionId: 'session-snapshot-only',
          messageId: 'snapshot-only',
          tool: '',
          observedAt: 100
        }]
      });
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_snapshot_only_after_watermark')).toMatchObject({
        conversationId: 'conv-snapshot-only', sessionId: 'session-snapshot-only'
      });
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when unjournaled legacy snapshot and retained exact history disagree', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-history-wins-snapshot-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'history wins', conversationId: 'conv-original-history' });
      await fs.appendFile(
        path.join(dir, 'sessions', session.id, 'events.jsonl'),
        `${JSON.stringify(attributedToolEvent(1, 'wfr_history_wins_snapshot', 'conv-original-history', 1))}\n`,
        'utf8'
      );
      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_history_wins_snapshot', conversationId: 'conv-stale-rebound', sessionId: 'session-stale-rebound',
          messageId: 'stale-rebound', tool: 'read', observedAt: 999
        }]
      });
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await expect(restoreRequestCorrelations()).rejects.toThrow(
        'Request ownership migration conflict for wfr_history_wins_snapshot'
      );
      expect(requestCorrelation('wfr_history_wins_snapshot')).toBeNull();
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when retained exact history contains two owners and no legacy snapshot can resolve them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-history-conflict-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const first = await createSession({ title: 'first history owner', conversationId: 'conv-history-first' });
      const rebound = await createSession({ title: 'rebound history owner', conversationId: 'conv-history-rebound' });
      const requestId = 'wfr_history_owner_conflict';
      await fs.appendFile(
        path.join(dir, 'sessions', first.id, 'events.jsonl'),
        `${JSON.stringify(attributedToolEvent(1, requestId, 'conv-history-first', 100))}\n`,
        'utf8'
      );
      await fs.appendFile(
        path.join(dir, 'sessions', rebound.id, 'events.jsonl'),
        `${JSON.stringify(attributedToolEvent(1, requestId, 'conv-history-rebound', 1))}\n`,
        'utf8'
      );

      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await expect(restoreRequestCorrelations()).rejects.toThrow(
        `Request ownership migration conflict for ${requestId}: retained history contains different owners`
      );
      expect(requestCorrelation(requestId)).toBeNull();
      expect(await readDurable('request-owner-migration')).toBeNull();
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not advance a history watermark across an unterminated crash tail', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-watermark-torn-tail-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const session = await createSession({ title: 'torn watermark', conversationId: 'conv-torn-watermark' });
      await appendEvent(session.id, attributedToolEvent(1, 'wfr_torn_seed', 'conv-torn-watermark') as any);
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      const first = await readDurable<{ sessions: Record<string, number> }>('request-owner-migration');
      const committed = first!.sessions[session.id]!;
      await fs.appendFile(path.join(dir, 'sessions', session.id, 'events.jsonl'), '{"seq":999,"kind":"tool_call"', 'utf8');

      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      const second = await readDurable<{ sessions: Record<string, number> }>('request-owner-migration');
      expect(second!.sessions[session.id]).toBe(committed);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('full-scans a session when its event file shrank below the stored watermark', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-watermark-shrink-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-watermark-shrink';
      const session = await createSession({ title: 'watermark shrink', conversationId });
      for (let index = 0; index < 8; index++) {
        await appendEvent(session.id, { time: index + 1, source: 'app', kind: 'progress',
          message: { text: 'padding-padding-padding', truncated: false, chars: 23 } });
      }
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      const previous = (await readDurable<{ sessions: Record<string, number> }>('request-owner-migration'))!.sessions[session.id]!;

      const replacement = `${JSON.stringify(attributedToolEvent(1, 'wfr_after_shrink', conversationId, 1))}\n`;
      expect(Buffer.byteLength(replacement)).toBeLessThan(previous);
      await fs.writeFile(path.join(dir, 'sessions', session.id, 'events.jsonl'), replacement, 'utf8');
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_after_shrink')).toMatchObject({ conversationId, sessionId: session.id });
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reopen an unchanged events journal once its committed-byte watermark matches size', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-watermark-hot-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-watermark-hot';
      const session = await createSession({ title: 'watermark hot', conversationId });
      await appendEvent(session.id, attributedToolEvent(1, 'wfr_watermark_hot', conversationId) as any);
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      await restoreRequestCorrelations();

      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      const eventFile = path.join(dir, 'sessions', session.id, 'events.jsonl');
      const open = vi.spyOn(fs, 'open');
      await restoreRequestCorrelations();
      expect(open.mock.calls.filter(([file]) => String(file) === eventFile)).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the legacy correlation snapshot is corrupt before migration', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-corrupt-legacy-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await fs.mkdir(path.join(dir, 'state'), { recursive: true });
      await fs.writeFile(path.join(dir, 'state', 'request-correlations.json'), '{not-json', 'utf8');
      resetCorrelationRegistryForTests();
      await expect(restoreRequestCorrelations()).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reconciles a valid stale snapshot with newer durable attributed history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-stale-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-stale-reconcile';
      const session = await createSession({ title: 'stale correlation snapshot', conversationId });
      const toolCall = (callId: string, requestId: string, time: number) => ({
        time,
        source: 'mcp' as const,
        kind: 'tool_call' as const,
        call: {
          callId,
          tool: 'read',
          attribution: 'request_id' as const,
          requestId,
          conversationId,
          attributionMethod: 'request_id' as const,
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok' as const,
          durationMs: 1,
          summary: { kind: 'read' as const, tone: 'neutral' as const, title: callId }
        }
      });

      await writeDurableNow('request-correlations', {
        version: 5,
        entries: [{
          requestId: 'wfr_old_snapshot',
          conversationId,
          sessionId: session.id,
          messageId: 'msg-old',
          tool: 'read',
          observedAt: 1
        }]
      });
      await appendEvent(session.id, toolCall('call-old', 'wfr_old_snapshot', 1));
      await appendEvent(session.id, toolCall('call-new', 'wfr_new_history', 2));
      // The old v5 snapshot knows only the first owner. Full one-time migration must recover the
      // newer request from retained history rather than trusting the stale bounded snapshot.
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);

      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_old_snapshot')?.conversationId).toBe(conversationId);
      expect(requestCorrelation('wfr_new_history')?.conversationId).toBe(conversationId);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
