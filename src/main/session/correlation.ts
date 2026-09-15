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

import { readDurable, writeDurableSnapshotSoon } from '../durable.js';
import { indexedSessions, readRecentEvents } from './store.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  /** Recent observation detail only. It is not part of the permanent ownership verdict. */
  messageId: string;
  /** Recent observation detail only. It is not part of the permanent ownership verdict. */
  tool: string;
  /** Recent observation detail only. It is not part of the permanent ownership verdict. */
  observedAt: number;
}

export type RequestCorrelationOwner = Pick<RequestCorrelation, 'requestId' | 'conversationId' | 'sessionId'>;

/** Diagnostic observations may be bounded; exact ownership may not. */
const MAX_CORRELATION_DIAGNOSTICS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 6 stores only the permanent owner facts. Observation labels/timestamps are process-local
 * diagnostics and may be discarded under pressure without changing an ownership decision.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 * Version 5 stored the complete observation row and bounded the same map to 50,000 entries. That
 * made a security fact disappear when diagnostic pressure filled the registry. Version 6 keeps
 * the owner index unbounded until a lifecycle-proven reclamation rule exists.
 */
const CORRELATIONS_STATE_VERSION = 6;

const ownersByRequest = new Map<string, RequestCorrelationOwner>();
const diagnosticsByRequest = new Map<string, Pick<RequestCorrelation, 'messageId' | 'tool' | 'observedAt'>>();
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

interface PersistedCorrelations {
  version: number;
  /** v6+ permanent facts. */
  owners?: RequestCorrelationOwner[];
  /** v3-v5 legacy observations/wrappers. */
  entries?: unknown[];
}

function wake(requestId: string): void {
  const held = waiters.get(requestId);
  if (!held) return;
  waiters.delete(requestId);
  for (const resolve of held) resolve();
}

function rememberDiagnostic(input: RequestCorrelation): void {
  diagnosticsByRequest.delete(input.requestId);
  diagnosticsByRequest.set(input.requestId, {
    messageId: input.messageId,
    tool: input.tool,
    observedAt: input.observedAt
  });
  while (diagnosticsByRequest.size > MAX_CORRELATION_DIAGNOSTICS) {
    const oldest = diagnosticsByRequest.keys().next().value as string | undefined;
    if (!oldest) break;
    diagnosticsByRequest.delete(oldest);
  }
}

function snapshot(): PersistedCorrelations {
  return {
    version: CORRELATIONS_STATE_VERSION,
    owners: [...ownersByRequest.values()].map((owner) => ({ ...owner }))
  };
}

function persist(): void {
  writeDurableSnapshotSoon(CORRELATIONS_STATE, snapshot);
}

/**
 * Whether a persisted row still carries the complete permanent ownership fact.
 * Diagnostic message/tool/time detail is intentionally absent from this validity boundary.
 */
function validOwner(value: unknown): value is RequestCorrelationOwner {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelationOwner>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId)
  );
}

/**
 * The owner in a persisted row, whatever shape the version that wrote it used.
 *
 * Versions 3 and 4 wrapped it as `{ requestId, value, conflicted }`, where a row with no value
 * was a sticky contradiction. Version 5 stores the complete observation row directly. A wrapper
 * with no usable value carries no owner and is simply dropped, which is all that forgetting an
 * old conflict takes.
 */
function storedOwner(raw: unknown): RequestCorrelationOwner | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  if (!validOwner(value)) return null;
  return {
    requestId: value.requestId,
    conversationId: value.conversationId,
    sessionId: value.sessionId
  };
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
function merge(input: RequestCorrelationOwner): 'stored' | 'same' | 'refused' {
  const previous = ownersByRequest.get(input.requestId);
  if (!previous) {
    ownersByRequest.set(input.requestId, {
      requestId: input.requestId,
      conversationId: input.conversationId,
      sessionId: input.sessionId
    });
    evidenceWindowStarts.delete(input.requestId);
    wake(input.requestId);
    return 'stored';
  }

  // Refused, and nothing else: the entry does not change and no waiter is woken, because a
  // claim this registry does not believe is not an answer for anybody waiting on the id.
  if (previous.conversationId !== input.conversationId) return 'refused';
  return 'same';
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

  const saved = await readDurable<PersistedCorrelations>(CORRELATIONS_STATE);
  let loaded = false;
  if (saved && saved.version >= 3 && saved.version <= CORRELATIONS_STATE_VERSION) {
    const rows = saved.version >= 6 ? saved.owners : saved.entries;
    if (Array.isArray(rows)) for (const raw of rows) {
      const owner = storedOwner(raw);
      if (!owner) continue;
      merge(owner);
      loaded = true;
    }
  }

  // The durable index is a debounced snapshot, while attributed tool-call JSONL is appended
  // independently. A crash can therefore leave a perfectly valid *nonempty* snapshot that is
  // merely behind the session history. Treat the snapshot as a fast baseline, not as proof that
  // history has nothing newer. Reconcile the durable request-id facts on every restore; merge()
  // is idempotent for the same conversation and still makes contradictions sticky.
  let sessions;
  try {
    sessions = await indexedSessions();
  } catch (error) {
    // A valid direct snapshot can be restored before the session store is initialized (some
    // tests and narrowly scoped consumers do exactly that). In the real app the store is ready
    // before this function runs, so stale-snapshot reconciliation still happens there. With no
    // usable snapshot, however, history is the only recovery source and the initialization
    // error must remain visible rather than silently losing ownership.
    if (loaded) return;
    throw error;
  }
  // Oldest first. History is the one source that can disagree with itself here, because it
  // replays proofs this process did not watch happen, and the owner is whichever proof came
  // first. Sessions arrive newest-first, which would have made it whichever one came last.
  for (const session of sessions.slice(0, 100).reverse()) {
    // The persisted index is the baseline. Reconcile only a bounded newest crash window;
    // parsing every historical JSONL on every launch made startup proportional to years of
    // recorded work and could freeze the main process for a minute before the UI appeared.
    for (const event of await readRecentEvents(session.id, 1024, {
      kinds: ['tool_call'],
      maxBytes: 512 * 1024
    })) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (call.attributionMethod !== 'request_id' || !call.requestId || !call.conversationId) continue;
      merge({
        requestId: call.requestId,
        conversationId: call.conversationId,
        sessionId: session.id
      });
    }
  }
  // Also when the snapshot on disk is an older version that held nothing usable: rewriting it
  // is what actually removes its conflict rows, and leaving them there would make every
  // later launch re-read a verdict this registry no longer has.
  if (ownersByRequest.size > 0 || loaded || (saved?.version ?? CORRELATIONS_STATE_VERSION) !== CORRELATIONS_STATE_VERSION) persist();
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
  let changed = false;
  const results = inputs.map((input) => {
    const result = merge(input);
    if (result !== 'refused') rememberDiagnostic(input);
    if (result === 'stored') changed = true;
    return result;
  });
  if (changed) persist();
  return results;
}

/** Exact request-id lookup. An id no page has proved yet resolves to null. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelationOwner | null {
  if (!requestId) return null;
  const held = ownersByRequest.get(requestId);
  return held ? { ...held } : null;
}

/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelationOwner | null> {
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
  ownersByRequest.clear();
  diagnosticsByRequest.clear();
  evidenceWindowStarts.clear();
  restored = false;
  restoring = null;
  for (const requestId of [...waiters.keys()]) wake(requestId);
}
