/**
 * The single ownership join between ChatGPT's page model and an inbound MCP request.
 *
 * ChatGPT puts one opaque request id in both places:
 *   - HTTP `x-request-id` on the MCP request (normalised at ingress), and
 *   - `message.metadata.request_id` on the connector request in the page model.
 *
 * Nothing else is ownership evidence. In particular, tool names, timestamps, rendered
 * connector rows, the active tab and "the only chat generating" never enter this registry.
 *
 * Once that exact join has been proved it is permanent. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL - and
 * no later observation can move or erase it either.
 *
 * A second conversation claiming a proven id is a page that is wrong about itself: a React tree
 * still mounted from the chat before it, a fresh chat whose client-side thread id has not yet
 * become the server's, an id the site reused. The answer to a page that is wrong is to refuse
 * the claimant, not to disown a request whose calls are still arriving. Disowning it was the
 * visible failure: one contradicting sighting nulled the owner for good, and from then on every
 * call under that id waited fifteen seconds for evidence that could no longer be accepted and
 * landed in Unattributed activity. First proof wins, and it keeps winning.
 */

import { appendDurableJournal, readDurable, readDurableJournal, readDurableStrict, writeDurableNow } from '../durable.js';
import { scanRequestOwnerEvidenceForMigration, sessionIdsForRequestOwnerMigration } from './store.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
}

interface RequestOwner {
  requestId: string;
  conversationId: string;
  sessionId: string;
}

interface RequestDiagnostic {
  messageId: string;
  tool: string;
  observedAt: number;
}

const MAX_DIAGNOSTICS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
const OWNERS_JOURNAL = 'request-owners';
const OWNER_MIGRATION_STATE = 'request-owner-migration';
const OWNERS_JOURNAL_VERSION = 1;
const OWNER_MIGRATION_VERSION = 1;
/**
 * 5 stores owners and nothing else, because an owner is now the only verdict there is.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 */
const CORRELATIONS_STATE_VERSION = 5;

/** Permanent authority. Never TTL/LRU/pressure-evicted. */
const byRequest = new Map<string, RequestOwner>();
/** Human/debug context only. Bounded independently because losing it cannot move authority. */
const diagnostics = new Map<string, RequestDiagnostic>();
const waiters = new Map<string, Set<() => void>>();
/**
 * Evidence grace belongs to the request, not each tool call in its workflow. All callers
 * measure their allowance from its first wait, so sequential and overlapping calls cannot
 * restart the clock. Keep the start rather than a spent flag: the recorder's longer grace
 * must remain available after a shorter identity lookup expires. This is only wait accounting,
 * never a negative ownership verdict; exact evidence always wins, even after every deadline.
 * Process-local and bounded: a restart or eviction may grant fresh grace, never an owner.
 */
const evidenceWindowStarts = new Map<string, number>();
const MAX_EVIDENCE_WINDOWS = 2_000;
let restored = false;
let restoring: Promise<void> | null = null;
let commitQueue = Promise.resolve();
let synchronousObservationBlocked = false;

interface PersistedCorrelations {
  version: number;
  entries: RequestCorrelation[];
}

interface PersistedOwnerBatch {
  version: number;
  owners: RequestOwner[];
}

interface OwnerMigrationWatermark {
  version: number;
  sessions: Record<string, number>;
}

function wake(requestId: string): void {
  const held = waiters.get(requestId);
  if (!held) return;
  waiters.delete(requestId);
  for (const resolve of held) resolve();
}

function trimDiagnostics(): void {
  while (diagnostics.size > MAX_DIAGNOSTICS) {
    const first = diagnostics.keys().next().value as string | undefined;
    if (!first) break;
    diagnostics.delete(first);
  }
}

function noteDiagnostic(input: RequestCorrelation): void {
  const previous = diagnostics.get(input.requestId);
  if (previous && input.observedAt <= previous.observedAt) return;
  diagnostics.delete(input.requestId);
  diagnostics.set(input.requestId, {
    messageId: input.messageId,
    tool: input.tool,
    observedAt: input.observedAt
  });
  trimDiagnostics();
}

function correlationFor(owner: RequestOwner): RequestCorrelation {
  const diagnostic = diagnostics.get(owner.requestId);
  return {
    ...owner,
    messageId: diagnostic?.messageId ?? '',
    tool: diagnostic?.tool ?? '',
    observedAt: diagnostic?.observedAt ?? 0
  };
}

/**
 * Whether a persisted row still carries everything an owner needs to be restored.
 *
 * The bar is exactly what this registry answers with: a request id, the conversation that
 * proved it, the session epoch that owned it, and when. `tool` is a diagnostic label, kept so
 * a stored row can be read by a human; no caller reads it, and the header above says why it
 * could not be evidence even if one did. Demanding a nonempty one here was therefore a bar the
 * registry itself does not have - and it silently deleted the rows that need restoring most.
 *
 * A request id is published on `message.metadata.request_id` before the `api_tool` message
 * naming the tool exists, so the page proves ownership first and names the tool later. Those
 * early sightings are stored with an empty tool on purpose - the join does not use the name,
 * and waiting for it is what used to file the call under Unattributed activity. Every one of
 * them then failed this check on the next launch, so a workflow whose calls were still arriving
 * lost its proven owner to a restart: the same permanence bug the header describes, arriving
 * through the door marked valid.
 */
function validOwner(value: unknown): value is RequestOwner {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelation>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId)
  );
}

function validDiagnostic(value: unknown): value is RequestCorrelation {
  if (!validOwner(value)) return false;
  const item = value as Partial<RequestCorrelation>;
  return typeof item.messageId === 'string' && item.messageId.length <= 300 &&
    typeof item.tool === 'string' && item.tool.length <= 100 &&
    typeof item.observedAt === 'number' && Number.isFinite(item.observedAt);
}

/**
 * The owner in a persisted row, whatever shape the version that wrote it used.
 *
 * Versions 3 and 4 wrapped it as `{ requestId, value, conflicted }`, where a row with no value
 * was a sticky contradiction. Version 5 stores the owner itself. A wrapper with no usable value
 * carries no owner and is simply dropped, which is all that forgetting an old conflict takes.
 */
function storedValue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  return 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
}

function storedOwner(raw: unknown): RequestOwner | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = storedValue(raw);
  return validOwner(value)
    ? { requestId: value.requestId, conversationId: value.conversationId, sessionId: value.sessionId }
    : null;
}

/**
 * Files one sighting against the permanent owner of its request id.
 *
 * Live ChatGPT gives every connector request in one turn the same request_id. messageId and
 * tool identify individual calls inside that turn, so differences there are expected and change
 * nothing. Only the conversation is ownership, and only the first proof of it counts.
 *
 * The session epoch is first-proof-wins for the same conversation as well. Compact & Resume can
 * leave the old page model mounted while a newer local session epoch exists for that same old
 * conversation id, and re-observing the request from that stale page must not drag an in-flight
 * request into the newer epoch.
 */
function merge(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  const previous = byRequest.get(input.requestId);
  if (!previous) {
    byRequest.set(input.requestId, {
      requestId: input.requestId,
      conversationId: input.conversationId,
      sessionId: input.sessionId
    });
    noteDiagnostic(input);
    evidenceWindowStarts.delete(input.requestId);
    wake(input.requestId);
    return 'stored';
  }

  // Refused, and nothing else: the entry does not change and no waiter is woken, because a
  // claim this registry does not believe is not an answer for anybody waiting on the id.
  if (previous.conversationId !== input.conversationId) return 'refused';

  noteDiagnostic(input);
  return 'same';
}

function mergeOwner(owner: RequestOwner): 'stored' | 'same' | 'refused' {
  const previous = byRequest.get(owner.requestId);
  if (!previous) {
    byRequest.set(owner.requestId, { ...owner });
    evidenceWindowStarts.delete(owner.requestId);
    wake(owner.requestId);
    return 'stored';
  }
  // The conversation owns the workflow. A later local session epoch for that same page must not
  // move the request, but it is not a contradiction either: keep the first session id exactly as
  // live merge() does.
  if (previous.conversationId !== owner.conversationId) return 'refused';
  return 'same';
}

function ownerBatch(owners: readonly RequestOwner[]): PersistedOwnerBatch {
  return {
    version: OWNERS_JOURNAL_VERSION,
    owners: owners.map((owner) => ({ ...owner }))
  };
}

function validOwnerBatch(value: unknown): value is PersistedOwnerBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Partial<PersistedOwnerBatch>;
  return batch.version === OWNERS_JOURNAL_VERSION && Array.isArray(batch.owners) &&
    batch.owners.every(validOwner);
}

function migrationWatermarks(value: unknown): Map<string, number> {
  if (!value || typeof value !== 'object') return new Map();
  const state = value as Partial<OwnerMigrationWatermark>;
  if (state.version !== OWNER_MIGRATION_VERSION || !state.sessions || typeof state.sessions !== 'object') return new Map();
  const restored = new Map<string, number>();
  for (const [sessionId, offset] of Object.entries(state.sessions)) {
    if (/^[0-9a-z-]{8,64}$/i.test(sessionId) && Number.isSafeInteger(offset) && offset >= 0) restored.set(sessionId, offset);
  }
  return restored;
}

/**
 * Restores request ownership before the bridge starts accepting page/MCP traffic.
 *
 * 1.8.2 persists this index directly. On the first 1.8.2 launch there is no index yet, so
 * rebuild it once from already-recorded request_id-attributed tool calls. Those records are
 * themselves the result of the exact page↔HTTP join, and let an old still-running workflow
 * remain owned across the upgrade even if its original tab is already gone.
 */
export async function restoreRequestCorrelations(): Promise<void> {
  if (restored) return;
  if (restoring) return restoring;
  restoring = restoreRequestCorrelationsOnce();
  try {
    await restoring;
    restored = true;
  } finally {
    restoring = null;
  }
}

async function restoreRequestCorrelationsOnce(): Promise<void> {
  const journaled = new Set<string>();

  // Journal authority always wins over the obsolete v3-v5 snapshot. This matters after a
  // downgrade: an old binary can forget/reassign an id that the journal already permanently
  // owns, but returning to this version must never let that stale snapshot move the owner.
  for (const raw of await readDurableJournal<unknown>(OWNERS_JOURNAL)) {
    if (!validOwnerBatch(raw)) {
      throw new Error('Request-owner journal contains an unsupported or invalid committed record');
    }
    for (const owner of raw.owners) {
      const result = mergeOwner(owner);
      if (result === 'refused') {
        throw new Error(`Request-owner journal contains conflicting owners for ${owner.requestId}`);
      }
      journaled.add(owner.requestId);
    }
  }

  // The old whole-file snapshot was never permanent authority: v5 could evict an owner and then
  // accept a later conversation for the same id. Read it strictly on every startup because an old
  // binary may have run after this version and produced a snapshot-only bare owner. Hold it only
  // as fallback for ids whose journal/history does not already carry stronger evidence.
  const saved = await readDurableStrict<PersistedCorrelations>(CORRELATIONS_STATE);
  const legacy = new Map<string, { owner: RequestOwner; diagnostic: RequestCorrelation | null }>();
  if (saved) {
    if (saved.version < 3 || saved.version > CORRELATIONS_STATE_VERSION || !Array.isArray(saved.entries)) {
      throw new Error('Request-correlation snapshot has an unsupported security schema');
    }
    for (const raw of saved.entries) {
      const value = storedValue(raw);
      if (value === null) continue; // v3/v4 conflict-only row: it carried no owner.
      const owner = storedOwner(raw);
      if (!owner) throw new Error('Request-correlation snapshot contains an invalid owner record');
      const previous = legacy.get(owner.requestId)?.owner;
      if (previous && (previous.conversationId !== owner.conversationId || previous.sessionId !== owner.sessionId)) {
        throw new Error(`Request-correlation snapshot contains conflicting owners for ${owner.requestId}`);
      }
      legacy.set(owner.requestId, {
        owner,
        diagnostic: validDiagnostic(value) ? { ...value } : null
      });
    }
  }

  const priorWatermarks = migrationWatermarks(await readDurable<unknown>(OWNER_MIGRATION_STATE));
  let sessionIds: string[];
  try {
    sessionIds = await sessionIdsForRequestOwnerMigration();
  } catch (error) {
    // Narrow consumers/tests may restore already-journaled authority without initializing the
    // session store. Production initializes it before restore. Never canonize legacy fallback
    // without the history scan that is supposed to outrank it.
    if (journaled.size > 0 && legacy.size === 0) return;
    throw error;
  }

  // Per-session byte watermarks make downgrade recovery incremental. An old binary that appends
  // attributed history after our last scan necessarily grows that exact JSONL past its stored
  // committed newline. Missing/corrupt watermark state simply means a safe full rescan.
  const recovered = new Map<string, RequestCorrelation>();
  const nextWatermarks: Record<string, number> = {};
  for (const sessionId of sessionIds) {
    const scan = await scanRequestOwnerEvidenceForMigration(
      sessionId,
      priorWatermarks.get(sessionId) ?? 0,
      (candidate) => {
        if (byRequest.has(candidate.requestId)) return;
        const previous = recovered.get(candidate.requestId);
        if (
          previous &&
          (previous.conversationId !== candidate.conversationId || previous.sessionId !== candidate.sessionId)
        ) {
          // Old v5 could evict the original owner, accept a rebound owner, and retain attributed
          // history for both while eventually dropping the request from its bounded snapshot too.
          // Event timestamps are not ownership evidence, so there is no safe tie-breaker here.
          throw new Error(
            `Request ownership migration conflict for ${candidate.requestId}: retained history contains different owners`
          );
        }
        if (!previous || candidate.observedAt < previous.observedAt ||
            (candidate.observedAt === previous.observedAt && candidate.sessionId < previous.sessionId)) {
          recovered.set(candidate.requestId, candidate);
        }
      }
    );
    nextWatermarks[sessionId] = scan.committedBytes;
  }
  // An unjournaled legacy snapshot and retained exact history can disagree in either direction.
  // Old v5 could evict owner A, accept rebound B, append B-attributed history, and crash before
  // its debounced snapshot changed A -> B; conversely a later stale snapshot can name B while
  // retained history still proves A. Without the new journal there is no durable ordering fact
  // that distinguishes those crash shapes. Never guess and make the wrong Principal permanent.
  for (const candidate of recovered.values()) {
    const fallback = legacy.get(candidate.requestId)?.owner;
    if (!fallback) continue;
    if (fallback.conversationId !== candidate.conversationId || fallback.sessionId !== candidate.sessionId) {
      throw new Error(
        `Request ownership migration conflict for ${candidate.requestId}: legacy snapshot and retained history disagree`
      );
    }
  }
  for (const candidate of [...recovered.values()].sort((a, b) => a.observedAt - b.observedAt)) merge(candidate);

  // Matching retained history corroborates the legacy snapshot; snapshot-only bare correlations
  // remain useful fallback evidence when an older build crashed before any attributed tool row existed.
  for (const { owner, diagnostic } of legacy.values()) {
    if (byRequest.has(owner.requestId)) continue;
    mergeOwner(owner);
    if (diagnostic) noteDiagnostic(diagnostic);
  }

  // Migrate every authority fact we could recover into the append-only store. Keep the old v3-v5
  // file as best-effort downgrade input only; old binaries cannot provide the journal's permanent
  // >50k guarantee, so re-upgrade precedence above is the actual safety boundary.
  const missing = [...byRequest.values()].filter((owner) => !journaled.has(owner.requestId));
  for (let offset = 0; offset < missing.length; offset += 512) {
    await appendDurableJournal(OWNERS_JOURNAL, ownerBatch(missing.slice(offset, offset + 512)));
  }
  // This checkpoint is only a scan optimization. Authority is already journaled above, so a
  // missing/corrupt/failed watermark merely causes safe re-reading on the next launch.
  await writeDurableNow(OWNER_MIGRATION_STATE, {
    version: OWNER_MIGRATION_VERSION,
    sessions: nextWatermarks
  } satisfies OwnerMigrationWatermark).catch(() => undefined);
}

/**
 * Adds page evidence. `request_id` is a turn/workflow ownership key, not a per-tool-call id:
 * one ChatGPT turn can legitimately report several message ids/tools under the same key.
 * Re-reporting that key from the same conversation is therefore idempotent, and reporting it
 * from a different one is refused: the owner an id already has is the owner it keeps.
 */
export function observeRequestCorrelation(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  return observeRequestCorrelations([input])[0]!;
}

/**
 * Adds one page evidence batch while snapshotting the durable registry at most once.
 *
 * Fiber commonly reports several connector calls from one turn together. Feeding them through
 * the single-item API one by one cloned the complete (up to 50k-entry) registry after every new
 * request id, although `writeDurableSoon()` could only keep the newest pending snapshot. Merge
 * the complete synchronous batch first, then queue exactly one snapshot. Individual callers
 * keep the API above, so the durable queue boundary stays synchronous everywhere.
 */
export function observeRequestCorrelations(
  inputs: readonly RequestCorrelation[]
): Array<'stored' | 'same' | 'refused'> {
  if (synchronousObservationBlocked) {
    throw new Error('Request ownership cannot be inserted synchronously while a durable ownership commit is in flight');
  }
  return inputs.map((input) => merge(input));
}

/**
 * Durably admits page ownership before publishing it to authorization lookups or waiters.
 *
 * This is the production ingress. The synchronous helpers above remain useful for deterministic
 * in-memory tests, but browser evidence must cross this barrier before `/correlations` can ACK it.
 * Concurrent browser batches serialize here so two pages racing on one previously unseen id can
 * never both append competing first-owner facts.
 */
export function commitRequestCorrelations(
  inputs: readonly RequestCorrelation[]
): Promise<Array<'stored' | 'same' | 'refused'>> {
  const work = commitQueue.then(async () => {
    const staged = new Map<string, RequestOwner>();
    for (const input of inputs) {
      const previous = staged.get(input.requestId) ?? byRequest.get(input.requestId);
      if (!previous) {
        staged.set(input.requestId, {
          requestId: input.requestId,
          conversationId: input.conversationId,
          sessionId: input.sessionId
        });
      }
    }
    const newOwners = [...staged.values()].filter((owner) => !byRequest.has(owner.requestId));
    synchronousObservationBlocked = true;
    try {
      if (newOwners.length > 0) await appendDurableJournal(OWNERS_JOURNAL, ownerBatch(newOwners));
      return inputs.map((input) => merge(input));
    } finally {
      synchronousObservationBlocked = false;
    }
  });
  commitQueue = work.then(() => undefined, () => undefined);
  return work;
}

/** Exact request-id lookup. An id no page has proved yet resolves to null. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = byRequest.get(requestId);
  return held ? correlationFor(held) : null;
}

/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || timeoutMs <= 0) return immediate;

  const now = performance.now();
  const startedAt = evidenceWindowStarts.get(requestId) ?? now;
  if (!evidenceWindowStarts.has(requestId)) {
    evidenceWindowStarts.set(requestId, startedAt);
    if (evidenceWindowStarts.size > MAX_EVIDENCE_WINDOWS) {
      evidenceWindowStarts.delete(evidenceWindowStarts.keys().next().value!);
    }
  }
  const remainingMs = timeoutMs - (now - startedAt);
  if (remainingMs <= 0) return null;

  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const set = waiters.get(requestId) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(requestId, set);
    timer = setTimeout(() => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(requestId);
      resolve();
    }, remainingMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return requestCorrelation(requestId);
}

/** A conversation being closed cannot invalidate an already issued request. */
export function resetCorrelationRegistryForTests(): void {
  byRequest.clear();
  diagnostics.clear();
  evidenceWindowStarts.clear();
  restored = false;
  restoring = null;
  commitQueue = Promise.resolve();
  synchronousObservationBlocked = false;
  for (const requestId of [...waiters.keys()]) wake(requestId);
}
