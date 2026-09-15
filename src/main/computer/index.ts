/**
 * Computer use: seeing the screen and driving the mouse and keyboard.
 *
 * This is deliberately the smallest surface that still lets a model actually operate
 * the machine. The action vocabulary mirrors OpenAI's computer-use tool — click,
 * double_click, scroll, type, keypress, drag, move, wait, screenshot — so a model
 * that already knows how to drive a computer does not have to learn a private
 * dialect, plus the two things a native desktop needs and a browser viewport does not:
 * listing windows and bringing one to the front.
 *
 * Coordinates are always in *screenshot pixels*. Each helper keeps capture and input in
 * one native screen coordinate space; the scale between that space and the returned
 * image is applied here, and every screenshot states the size it was returned at.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ensureUsablePath, normalizeEnvironment } from '../env.js';
import { findWindowsPowerShell, terminateProcessTree } from '../exec.js';
import { logInfo, logWarn } from '../logger.js';
import { HELPER_SCRIPT } from './helper.js';

/** Width the screenshot is scaled down to, matching computer-use convention. */
export const DEFAULT_SCREENSHOT_WIDTH = 1280;
export const MAX_SCREENSHOT_WIDTH = 2560;
const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STARTUP_GRACE_MS = 10_000;
const MAX_FRAMES = 16;
/** Per-image ceiling; the final Desktop tool layer separately measures text + image together. */
export const MAX_SCREENSHOT_PNG_BYTES = Math.floor((((8 * 1024 * 1024) - (64 * 1024)) * 3) / 4);

export type ActionRoute = 'uia' | 'sendinput' | 'focus' | 'shell' | 'local';

export class ComputerError extends Error {
  readonly completedCount: number | null;
  readonly failedIndex: number | null;
  readonly completedRoutes: ActionRoute[] | null;

  constructor(
    message: string,
    details: { completedCount?: number; failedIndex?: number; completedRoutes?: ActionRoute[] } = {}
  ) {
    super(message);
    this.completedCount = details.completedCount ?? null;
    this.failedIndex = details.failedIndex ?? null;
    this.completedRoutes = details.completedRoutes ? [...details.completedRoutes] : null;
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  /** Windows native app identity (AUMID or exact process image path). */
  app?: string;
  processId?: number;
  processPath?: string;
  appUserModelId?: string;
  dpi?: number;
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'foreground' | 'minimized' | 'open';
}

export interface UiElementInfo {
  /** Opaque state-scoped reference accepted by click_ref/set_value. */
  ref: string;
  name: string;
  role: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  bounds: Rect;
  /** Present when the element is fully inside the most recent screenshot frame. */
  imageBounds: Rect | null;
  imageCenter: { x: number; y: number } | null;
  /** Native accessibility actions advertised by this control, when available. */
  actions?: UiActionName[];
  depth?: number;
  focused?: boolean;
  selected?: boolean;
}

export type UiActionName = 'invoke' | 'toggle' | 'select' | 'expand' | 'collapse' | 'focus'
  | 'scroll_up' | 'scroll_down' | 'scroll_left' | 'scroll_right' | 'scroll_into_view';

export interface DesktopApp { id: string; displayName: string; isRunning?: boolean; windows?: WindowInfo[] }

export interface AccessibilityContext {
  documentText?: string;
  selectedText?: string;
  focusedElement?: string;
}

export interface Screenshot {
  /** Base64 PNG. */
  data: string;
  /** Stable id for the coordinate frame used by later pointing actions. */
  frameId: number;
  /** Size of the returned image, which is what coordinates refer to. */
  width: number;
  height: number;
  /** The screen region it shows, in the helper's coordinate space. */
  region: Rect;
  scale: number;
  /**
   * For a window capture: whether that window was actually in front when the pixels were
   * taken. Null for whole-screen captures, where the question does not arise.
   *
   * Window capture never activates its target. False means it was not foreground; this is
   * harmless for direct background capture and relevant only when captureMode says the
   * helper had to fall back to visible screen pixels.
   */
  focused: boolean | null;
  /** How window pixels were obtained; screen_fallback can be occluded. */
  captureMode: 'screen' | 'window' | 'screen_fallback';
  /** Window id whose geometry this frame is bound to, if any. */
  windowId: number | null;
}

export interface ActionResult {
  cursor: PointerResult | null;
  clipboard: string[];
  completedCount: number;
  routes: ActionRoute[];
}

/** Product-policy/lifecycle effect classes rechecked by the MCP owner immediately before I/O. */
export type ComputerSideEffect = 'desktop' | 'clipboard-read' | 'clipboard-write';
export type ComputerSideEffectPreflight = (effect: ComputerSideEffect) => void | Promise<void>;

export type VerificationSpec =
  | { until: 'foreground'; window: number; timeoutMs?: number }
  | { until: 'window_exists'; match: string; timeoutMs?: number }
  | { until: 'window_closed'; match: string; timeoutMs?: number }
  | { until: 'ui_appears'; window?: number; match: string; role?: string; timeoutMs?: number }
  | { until: 'ui_disappears'; window?: number; match: string; role?: string; timeoutMs?: number };

export interface VerificationResult {
  until: VerificationSpec['until'];
  elapsedMs: number;
  detail: string;
  snapshotId: number | null;
}

export type Action =
  | { type: 'click_ref'; ref: string; button?: string; count?: number }
  | { type: 'set_value'; ref: string; text: string }
  | { type: 'ui_action'; ref: string; action: UiActionName }
  | { type: 'launch_app'; app: string }
  | { type: 'paste'; text: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: string; count?: number }
  | { type: 'double_click'; x: number; y: number; button?: string }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number; scrollUnit?: 'wheel' }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; button?: string; duration_ms?: number }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[] }
  | { type: 'focus'; window: number }
  | { type: 'wait'; ms?: number }
  // The clipboard is part of driving a desktop — it is how text gets into an app that has
  // no accessible text field. These two are done in Electron rather than by the helper, but
  // they run inside the same lock and in the caller's order, so "put this on the clipboard,
  // then press ctrl+v" is one uninterrupted sequence.
  | { type: 'read_clipboard' }
  | { type: 'write_clipboard'; text: string };

/** One long-lived Windows PowerShell/Win32 native backend transport. */
interface PendingHelperRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperRuntime {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrTail: string;
  pending: PendingHelperRequest | null;
  /** True after the helper has produced its first valid protocol reply. */
  ready: boolean;
  scriptDirectory: string | null;
  scriptCleanup: Promise<void> | null;
}

let helperRuntime: HelperRuntime | null = null;
let helperStarting: Promise<HelperRuntime> | null = null;
let helperQueue: Promise<void> = Promise.resolve();
let helperGeneration = 0;
let helperStopping = false;
const helperRetirements = new Set<Promise<void>>();

// Transport-owned metadata, never accepted from the native protocol. Capture it before
// resolving a reply: image I/O may yield long enough for another helper to start.
const helperReplyGeneration = new WeakMap<object, number>();

function stampHelperReply(reply: Record<string, any>, generation: number): Record<string, any> {
  helperReplyGeneration.set(reply, generation);
  return reply;
}

function generationOfReply(reply: Record<string, any>): number {
  const generation = helperReplyGeneration.get(reply);
  if (generation === undefined) throw new ComputerError('Desktop reply has no transport identity.');
  return generation;
}

function isHelperGenerationActive(generation: number): boolean {
  if (helperStopping) return false;
  return helperRuntime !== null && helperRuntime.child.exitCode === null && helperRuntime.generation === generation;
}

type ExpectedHelper = { generation: number; code: 'STALE_FRAME' | 'STALE_REF' };

function assertHelperGeneration(generation: number, expected?: ExpectedHelper): void {
  if (helperStopping) throw new ComputerError('The desktop helper is shutting down.');
  if (expected && (generation !== expected.generation || !isHelperGenerationActive(generation))) {
    throw new ComputerError(`${expected.code}: the desktop helper changed. Observe again before retrying.`, {
      completedCount: 0, failedIndex: 0, completedRoutes: []
    });
  }
}

export function helperTimeoutMs(
  request: Record<string, unknown>,
  _platform: NodeJS.Platform = process.platform
): number {
  switch (request['op']) {
    case 'windows':
    case 'active':
    case 'focus':
    case 'cursor':
      return 5_000;
    case 'find_ui':
      return 8_000;
    case 'capture':
    case 'snapshot':
      return 10_000;
    case 'warm':
      return 10_000;
    case 'act':
      {
        const actions = Array.isArray(request['actions']) ? request['actions'].slice(0, 20) : [];
        return 15_000 + actions.reduce((duration, action) => duration + (action?.type === 'drag'
          ? Math.min(2000, Math.max(50, Number(action.durationMs) || 350)) : 0), 0);
      }
    default:
      return HELPER_TIMEOUT_MS;
  }
}

function cleanupHelperScript(runtime: HelperRuntime): Promise<void> {
  return runtime.scriptCleanup ??= (async () => {
    if (!runtime.scriptDirectory) return;
    const directory = runtime.scriptDirectory;
    runtime.scriptDirectory = null;
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      logWarn(`desktop helper script cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  })();
}

function retireHelper(runtime: HelperRuntime): Promise<void> {
  if (helperRuntime === runtime) helperRuntime = null;
  const task = (async () => {
    if (runtime.child.exitCode === null && runtime.child.pid !== undefined) {
      const closed = new Promise<void>((resolve) => runtime.child.once('close', () => resolve()));
      await terminateProcessTree(runtime.child.pid);
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
    await cleanupHelperScript(runtime);
  })();
  helperRetirements.add(task);
  void task.finally(() => helperRetirements.delete(task));
  return task;
}

function readableHelperFailure(stderr: string): string {
  const clean = stderr
    .replace(/^#< CLIXML[\s\S]*/m, '')
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return clean?.slice(0, 300) ?? 'the helper process exited unexpectedly';
}

/**
 * A broken helper must be gone before the serialized request is allowed to settle. `runHelper`
 * advances its queue when this request promise settles; rejecting first would let the next call
 * spawn a replacement while the retired process tree could still be executing desktop input.
 */
function rejectAfterHelperRetirement(runtime: HelperRuntime, pending: PendingHelperRequest, error: ComputerError): void {
  clearTimeout(pending.timer);
  if (runtime.pending === pending) runtime.pending = null;
  void retireHelper(runtime).then(
    () => pending.reject(error),
    () => pending.reject(error)
  );
}

async function startHelper(): Promise<HelperRuntime> {
  if (helperStopping) throw new ComputerError('The desktop helper is shutting down.');
  if (helperRuntime) return helperRuntime;
  if (helperStarting) return helperStarting;

  helperStarting = (async () => {
    const scriptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'octo-desktop-helper-'));
    try {
      const scriptFile = path.join(scriptDirectory, 'helper.ps1');
      // Keep large native source out of inherited environment blocks and command lines.
      // A BOM makes Windows PowerShell 5.1 read this UTF-8 source independently of ACP.
      await fs.writeFile(scriptFile, `\uFEFF${HELPER_SCRIPT}`, 'utf8');
      if (helperStopping) throw new ComputerError('The desktop helper is shutting down.');
      return await new Promise<HelperRuntime>((resolve, reject) => {
        const env = normalizeEnvironment(process.env);
        ensureUsablePath(env);
        const host = findWindowsPowerShell() ?? 'powershell.exe';
        const args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
        const child = spawn(host, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: env as NodeJS.ProcessEnv
        });
        const runtime: HelperRuntime = {
          generation: 0,
          child,
          stdoutBuffer: '',
          stderrTail: '',
          pending: null,
          ready: false,
          scriptDirectory,
          scriptCleanup: null
        };
        let started = false;
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');

        child.stdout.on('data', (chunk: Buffer) => {
          runtime.stdoutBuffer += stdoutDecoder.write(chunk);
          for (;;) {
            const newline = runtime.stdoutBuffer.indexOf('\n');
            if (newline === -1) break;
            const line = runtime.stdoutBuffer.slice(0, newline).trim();
            runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            const pending = runtime.pending;
            if (!pending) {
              logWarn(`desktop helper sent unsolicited output: ${line.slice(0, 200)}`);
              continue;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(line) as unknown;
            } catch {
              rejectAfterHelperRetirement(
                runtime,
                pending,
                new ComputerError('The desktop helper returned malformed JSON.')
              );
              continue;
            }
            if (
              parsed === null ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed) ||
              (((parsed as Record<string, unknown>)['ok'] !== true) && (parsed as Record<string, unknown>)['ok'] !== false)
            ) {
              rejectAfterHelperRetirement(
                runtime,
                pending,
                new ComputerError('The desktop helper returned a malformed protocol response.')
              );
              continue;
            }
            const reply = parsed as Record<string, any>;
            runtime.ready = true;
            clearTimeout(pending.timer);
            runtime.pending = null;
            if (reply['ok'] === false) {
              const code = String(reply['error_code'] ?? 'HELPER_ERROR');
              const message = String(reply['message'] ?? 'Desktop helper failed');
              const completed = Number(reply['completed_count']);
              const failed = Number(reply['failed_index']);
              const completedRoutes = completedHelperRoutes(reply, completed);
              pending.reject(
                new ComputerError(`${code}: ${message}`, {
                  ...(Number.isInteger(completed) && completed >= 0 ? { completedCount: completed } : {}),
                  ...(Number.isInteger(failed) && failed >= 0 ? { failedIndex: failed } : {}),
                  ...(completedRoutes ? { completedRoutes } : {})
                })
              );
            } else {
              pending.resolve(stampHelperReply(reply, runtime.generation));
            }
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          runtime.stderrTail = `${runtime.stderrTail}${stderrDecoder.write(chunk)}`.slice(-8000);
        });
        child.once('spawn', () => {
          started = true;
          helperRuntime = runtime;
          runtime.generation = ++helperGeneration;
          resolve(runtime);
        });
        child.once('error', (error) => {
          if (helperRuntime === runtime) helperRuntime = null;
          if (!started) {
            reject(new ComputerError(`Could not start the desktop helper: ${error.message}`));
            return;
          }
          const pending = runtime.pending;
          if (pending) {
            rejectAfterHelperRetirement(
              runtime,
              pending,
              new ComputerError(`Desktop helper process error: ${error.message}`)
            );
          } else {
            void retireHelper(runtime);
          }
        });
        child.once('close', () => {
          if (helperRuntime === runtime) helperRuntime = null;
          void cleanupHelperScript(runtime);
          const pending = runtime.pending;
          if (pending) {
            clearTimeout(pending.timer);
            runtime.pending = null;
            pending.reject(new ComputerError(`Desktop helper failed: ${readableHelperFailure(runtime.stderrTail)}`));
          }
        });
      });
    } catch (error) {
      if (scriptDirectory) await fs.rm(scriptDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })().finally(() => {
    helperStarting = null;
  });

  return helperStarting;
}

function completedHelperRoutes(reply: Record<string, any>, completed: number): ActionRoute[] | undefined {
  const raw = reply['routes'];
  if (!Number.isInteger(completed) || completed < 0 || !Array.isArray(raw) || raw.length !== completed) {
    return undefined;
  }
  const routes = raw.map(String);
  if (!routes.every((route) => route === 'uia' || route === 'sendinput' || route === 'focus' || route === 'shell')) return undefined;
  return routes as ActionRoute[];
}

/**
 * Stops the long-lived native desktop backend and waits for its process to exit.
 *
 * The helper is an app-owned process, not an implementation detail of one request: a
 * timeout or Electron shutdown must therefore retire the whole tree before the process
 * can be forgotten. Otherwise the compiled helper can survive the UI that owned it.
 */
export async function stopComputerHelper(): Promise<void> {
  helperStopping = true;
  const starting = helperStarting;
  if (starting) await starting.catch(() => null);
  const runtime = helperRuntime;
  helperRuntime = null;
  helperStarting = null;
  uiRefs.clear();
  frames.clear();
  lastFrame = null;
  if (!runtime) {
    await Promise.allSettled([...helperRetirements]);
    return;
  }

  const pending = runtime.pending;
  runtime.pending = null;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new ComputerError('The desktop helper was stopped because the app is shutting down.'));
  }
  try {
    runtime.child.stdin.end();
  } catch {
    // The helper may already have closed its pipe.
  }
  await retireHelper(runtime);
  await Promise.allSettled([...helperRetirements]);
}

async function sendHelperRequest(
  request: Record<string, unknown>,
  expected?: ExpectedHelper,
  beforeSend?: () => void | Promise<void>
): Promise<Record<string, any>> {
  const runtime = await startHelper();
  assertHelperGeneration(runtime.generation, expected);
  if (runtime.pending) throw new ComputerError('Desktop helper received overlapping requests.');
  await beforeSend?.();
  assertHelperGeneration(runtime.generation, expected);
  if (!isHelperGenerationActive(runtime.generation)) {
    throw new ComputerError('The desktop helper changed before the request could be sent.');
  }

  return new Promise<Record<string, any>>((resolve, reject) => {
    let pending: PendingHelperRequest;
    const timer = setTimeout(() => {
      if (runtime.pending !== pending) return;
      rejectAfterHelperRetirement(runtime, pending, new ComputerError('The desktop helper did not answer in time.'));
    }, helperTimeoutMs(request) + (runtime.ready ? 0 : HELPER_STARTUP_GRACE_MS));
    pending = { resolve, reject, timer };
    runtime.pending = pending;
    runtime.child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
      if (!error) return;
      if (runtime.pending !== pending) return;
      rejectAfterHelperRetirement(
        runtime,
        pending,
        new ComputerError(`Could not send a desktop helper request: ${error.message}`)
      );
    });
  });
}

function runHelper(
  request: Record<string, unknown>,
  expected?: ExpectedHelper,
  beforeSend?: () => void | Promise<void>
): Promise<Record<string, any>> {
  const queuedAt = Date.now();
  const operation = typeof request['op'] === 'string' ? request['op'] : 'unknown';
  const result = helperQueue.then(async () => {
    const startedAt = Date.now();
    try {
      return await sendHelperRequest(request, expected, beforeSend);
    } finally {
      logInfo(
        `desktop timing op=${operation} helper_queue_ms=${startedAt - queuedAt} helper_ms=${Date.now() - startedAt}`
      );
    }
  });
  helperQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The region and scale of the most recent screenshot.
 *
 * Actions arrive in the coordinates of the picture the model was looking at, so the
 * conversion back to screen coordinates needs to remember what that picture showed.
 */
interface Frame {
  id: number;
  helperGeneration: number;
  region: Rect;
  scale: number;
  width: number;
  height: number;
  windowId: number | null;
  windowGeometry: Rect | null;
  /** Exact active-display rectangles captured with a screen frame; null for window frames. */
  displayTopology: Rect[] | null;
  captureMode: Screenshot['captureMode'];
}

let nextFrameId = 1;
let lastFrame: Frame | null = null;
const frames = new Map<number, Frame>();

/**
 * Serialises whole multi-step acquisitions, not just single helper requests.
 *
 * `lastFrame` is one global coordinate system shared by every chat and every agent in
 * this app. get_window_state captures a screenshot and then maps UI element bounds into
 * it; without this lock another caller's capture can land between those two awaits and
 * the reply would pair one screenshot with centres computed against a different one.
 */
let exclusiveQueue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const measured = async (): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      logInfo(`desktop timing exclusive_queue_ms=${startedAt - queuedAt} exclusive_ms=${Date.now() - startedAt}`);
    }
  };
  const result = exclusiveQueue.then(measured, measured);
  exclusiveQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
const uiRefs = new Map<
  string,
  { window: number; runtimeKey: string; generation: number; snapshotId: number }
>();

/**
 * Refs carry the helper generation that minted them. A native accessibility identity only
 * means anything to the helper process that issued it, so once the helper restarts every
 * outstanding ref is meaningless — and acting on one would click whatever now happens to
 * hold that id. Stamping the generation makes that detectable instead of silent.
 */
function rememberUiRef(window: number, runtimeKey: string, index: number, snapshotId: number, generation: number): string {
  const ref = `g${generation}_s${snapshotId}_e${index + 1}`;
  uiRefs.set(ref, { window, runtimeKey, generation, snapshotId });
  while (uiRefs.size > 1000) {
    const oldest = uiRefs.keys().next().value as string | undefined;
    if (!oldest) break;
    uiRefs.delete(oldest);
  }
  return ref;
}

function uiTarget(ref: string): { window: number; runtimeKey: string; snapshotId: number } {
  const target = uiRefs.get(ref);
  if (!target) {
    throw new ComputerError(
      `UNKNOWN_UI_REF: ${ref}. Call get_window_state or find_ui again and use a ref from that reply.`
    );
  }
  if (!isHelperGenerationActive(target.generation)) {
    throw new ComputerError(
      `STALE_REF: ${ref} was issued by a desktop helper that is no longer active, so it no longer identifies anything. Call get_window_state again and use a ref from that reply.`
    );
  }
  return target;
}

function rememberFrame(frame: Frame): void {
  frames.set(frame.id, frame);
  lastFrame = frame;
  while (frames.size > MAX_FRAMES) {
    const oldest = frames.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    frames.delete(oldest);
  }
}

function qualifiedFrame(frame: Frame | null, generation = helperGeneration): Frame | null {
  return frame && frame.helperGeneration === generation && isHelperGenerationActive(generation) ? frame : null;
}

function frameById(id: number | undefined): Frame | null {
  return qualifiedFrame(id === undefined ? null : (frames.get(id) ?? null));
}

export async function listWindows(): Promise<{ windows: WindowInfo[]; screen: Rect }> {
  const reply = await runHelper({ op: 'windows' });
  return { windows: (reply['windows'] as WindowInfo[]) ?? [], screen: reply['screen'] as Rect };
}

/** Installed app identities come from the Windows Shell, never model-supplied paths. */
export async function listDesktopApps(opts: { match?: string; limit?: number } = {}): Promise<{ apps: DesktopApp[]; truncated: boolean }> {
  if (process.platform !== 'win32') throw new ComputerError('APPS_UNSUPPORTED: installed app discovery is currently Windows only.');
  return exclusive(async () => {
    const reply = await runHelper({ op: 'apps', match: opts.match ?? '', limit: Math.min(4096, Math.max(1, opts.limit ?? 60)) });
    return { apps: Array.isArray(reply['apps']) ? reply['apps'] : [], truncated: reply['truncated'] === true };
  });
}

export async function focusWindow(id: number): Promise<boolean> {
  const reply = await runHelper({ op: 'focus', id });
  return reply['focused'] === true;
}

export async function activeWindow(): Promise<{ window: WindowInfo | null; screen: Rect }> {
  const reply = await runHelper({ op: 'active' });
  const value = reply['window'];
  const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
  return { window, screen: reply['screen'] as Rect };
}

export async function findUi(opts: {
  window?: number;
  query?: string;
  role?: string;
  maxResults?: number;
}): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[]; accessibility?: AccessibilityContext }> {
  return exclusive(() => findUiLocked(opts, lastFrame));
}

/**
 * Maps elements into `frame` rather than into whatever `lastFrame` happens to be by the
 * time the helper answers. The caller states which picture the coordinates belong to.
 */
async function findUiLocked(
  opts: {
    window?: number;
    query?: string;
    role?: string;
    maxResults?: number;
  },
  frame: Frame | null,
  suppliedReply?: Record<string, any>
): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[]; accessibility?: AccessibilityContext }> {
  const request = {
    op: 'find_ui',
    ...(opts.window === undefined ? {} : { id: opts.window }),
    query: opts.query ?? '',
    role: opts.role ?? '',
    maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 30)))
  };
  const reply = suppliedReply ?? (await runHelper(request));
  const replyGeneration = generationOfReply(reply);
  frame = qualifiedFrame(frame, replyGeneration);
  const raw = Array.isArray(reply['elements']) ? (reply['elements'] as Array<Record<string, any>>) : [];
  const snapshotId = Number(reply['snapshotId']);
  if (!Number.isInteger(snapshotId) || snapshotId < 1) {
    throw new ComputerError('The desktop helper returned UI elements without a valid snapshot identity.');
  }
  const replyWindow = reply['window'];
  const windowId = Number(
    replyWindow && typeof replyWindow === 'object'
      ? (replyWindow as Record<string, unknown>)['id']
      : replyWindow
  );
  if (!Number.isInteger(windowId) || windowId < 1) {
    throw new ComputerError('The desktop helper returned UI elements without a valid window identity.');
  }
  logInfo(
    `desktop uia window_snapshot=${snapshotId} visited=${Number(reply['visited']) || 0} returned=${raw.length} truncated=${reply['truncated'] === true}`
  );
  const elements = raw.map((item, index): UiElementInfo => {
    const bounds = item['bounds'] as Rect;
    let imageBounds: Rect | null = null;
    let imageCenter: { x: number; y: number } | null = null;
    if (
      frame &&
      // A screen fallback can contain an occluding application's pixels even though the
      // semantic tree belongs to the requested window. Keep refs and desktop bounds, but
      // do not claim those controls occupy pixels the screenshot may not show.
      frame.captureMode !== 'screen_fallback' &&
      bounds.x >= frame.region.x &&
      bounds.y >= frame.region.y &&
      bounds.x + bounds.width <= frame.region.x + frame.region.width &&
      bounds.y + bounds.height <= frame.region.y + frame.region.height
    ) {
      // Map both edges against the actual integer image dimensions. Rounding origin and
      // size independently can extend a right-edge control one pixel beyond its image.
      const left = Math.round((bounds.x - frame.region.x) * frame.width / frame.region.width);
      const top = Math.round((bounds.y - frame.region.y) * frame.height / frame.region.height);
      const right = Math.round((bounds.x + bounds.width - frame.region.x) * frame.width / frame.region.width);
      const bottom = Math.round((bounds.y + bounds.height - frame.region.y) * frame.height / frame.region.height);
      imageBounds = { x: left, y: top, width: right - left, height: bottom - top };
      if (right > left && bottom > top) imageCenter = {
        x: Math.min(right - 1, Math.round((left + right) / 2)),
        y: Math.min(bottom - 1, Math.round((top + bottom) / 2))
      };
    }
    const runtimeKey = String(item['runtimeKey'] ?? '');
    return {
      ref: runtimeKey
        ? rememberUiRef(windowId, runtimeKey, index, snapshotId, replyGeneration)
        : `unavailable-${snapshotId}-${index + 1}`,
      name: String(item['name'] ?? ''),
      role: String(item['role'] ?? ''),
      automationId: String(item['automationId'] ?? ''),
      enabled: item['enabled'] === true,
      offscreen: item['offscreen'] === true,
      bounds,
      imageBounds,
      imageCenter,
      ...(Array.isArray(item['actions']) ? { actions: item['actions'] as UiActionName[] } : {}),
      ...(Number.isInteger(item['depth']) ? { depth: Math.min(50, Math.max(0, item['depth'])) } : {}),
      ...(typeof item['focused'] === 'boolean' ? { focused: item['focused'] } : {}),
      ...(typeof item['selected'] === 'boolean' ? { selected: item['selected'] } : {})
    };
  });
  const context: AccessibilityContext = {};
  let textBudget = 8000;
  for (const [source, target] of [['document_text', 'documentText'], ['selected_text', 'selectedText']] as const) {
    if (typeof reply[source] !== 'string' || !reply[source]) continue;
    context[target] = reply[source].slice(0, textBudget);
    textBudget -= context[target]!.length;
  }
  const focused = raw.findIndex(item => item['runtimeKey'] === reply['focused_element']);
  if (focused >= 0) context.focusedElement = elements[focused]!.ref;
  return { window: windowId, snapshotId, elements, ...(Object.keys(context).length > 0 ? { accessibility: context } : {}) };
}

export async function getWindowState(opts: {
  window?: number;
  maxWidth?: number;
  maxElements?: number;
  includeScreenshot?: boolean;
  includeUi?: boolean;
  includeRelated?: boolean;
}): Promise<{
  window: WindowInfo;
  snapshotId: number | null;
  screenshot: Screenshot | null;
  elements: UiElementInfo[];
  uiUnavailable: { code: string; message: string } | null;
  uiTruncated?: boolean;
  accessibility?: AccessibilityContext;
  related?: Array<{ window: WindowInfo; screenshot: Screenshot | null; error?: string }>;
}> {
  return exclusive(async () => {
    const includeScreenshot = opts.includeScreenshot !== false;
    const includeUi = opts.includeUi !== false;
    const limit = Math.min(MAX_SCREENSHOT_WIDTH, Math.max(320, Math.floor(opts.maxWidth ?? DEFAULT_SCREENSHOT_WIDTH)));
    const dir = includeScreenshot ? await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-')) : null;
    const file = dir ? path.join(dir, 'screen.png') : null;
    try {
      // Target lookup, pixels and UIA are one helper transaction. Besides saving two native
      // round trips, this is what gives every semantic ref and pixel coordinate one shared
      // snapshot identity instead of stitching together observations from different moments.
      const reply = await runHelper({
        op: 'snapshot',
        ...(opts.window === undefined ? {} : { id: opts.window }),
        includeScreenshot,
        includeUi,
        includeRelated: process.platform === 'win32' && opts.includeRelated === true,
        maxWidth: limit,
        maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxElements ?? 60))),
        ...(file ? { file } : {})
      });
      const value = reply['window'];
      const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
      if (!window) throw new ComputerError('WINDOW_NOT_FOUND: no matching visible window is available');
      const shot = file ? await screenshotFromReply(reply, file, window.id) : null;
      const frame = shot ? frameById(shot.frameId) : null;
      const unavailableValue = reply['uiUnavailable'];
      const uiUnavailable =
        unavailableValue && typeof unavailableValue === 'object'
          ? {
              code: String((unavailableValue as Record<string, unknown>)['code'] ?? 'UI_UNAVAILABLE'),
              message: String((unavailableValue as Record<string, unknown>)['message'] ?? 'UI controls are unavailable')
            }
          : null;
      const found = includeUi && uiUnavailable === null
        ? await findUiLocked({ window: window.id, maxResults: opts.maxElements ?? 60 }, frame, reply)
        : { window: window.id, snapshotId: null, elements: [] as UiElementInfo[], accessibility: undefined };
      const related: Array<{ window: WindowInfo; screenshot: Screenshot | null; error?: string }> = [];
      if (process.platform === 'win32' && opts.includeRelated && Array.isArray(reply['relatedWindows'])) {
        for (const relatedWindow of (reply['relatedWindows'] as WindowInfo[]).slice(0, 3)) {
          if (!Number.isSafeInteger(relatedWindow.id) || relatedWindow.id <= 0 || relatedWindow.id === window.id) continue;
          try {
            const relatedShot = includeScreenshot
              ? await screenshotLocked({ window: relatedWindow.id, ownerWindow: window.id, maxWidth: limit }, undefined,
                  { generation: generationOfReply(reply), code: 'STALE_FRAME' })
              : null;
            related.push({ window: relatedWindow, screenshot: relatedShot });
          } catch (err) {
            // A disappearing popup must not discard the useful main-window observation.
            // Capture rechecks native ownership; never substitute arbitrary screen pixels.
            related.push({ window: relatedWindow, screenshot: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
          }
        }
      }
      return {
        window,
        snapshotId: found.snapshotId,
        screenshot: shot,
        elements: found.elements,
        uiUnavailable,
        ...(includeUi && uiUnavailable === null && typeof reply['truncated'] === 'boolean' ? { uiTruncated: reply['truncated'] } : {}),
        ...(found.accessibility ? { accessibility: found.accessibility } : {}),
        ...(related.length > 0 ? { related } : {})
      };
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function waitForWindow(opts: {
  title?: string;
  process?: string;
  foreground?: boolean;
  timeoutMs?: number;
}): Promise<WindowInfo> {
  const title = opts.title?.trim().toLowerCase();
  const processName = opts.process?.trim().toLowerCase();
  if (!title && !processName) throw new ComputerError('wait_for_window needs title or process');
  const timeoutMs = Math.min(60_000, Math.max(0, Math.floor(opts.timeoutMs ?? 10_000)));
  const deadline = Date.now() + timeoutMs;
  const matches = (window: WindowInfo): boolean =>
    (!title || window.title.toLowerCase().includes(title)) &&
    (!processName || window.process.toLowerCase().includes(processName));

  for (;;) {
    if (opts.foreground === true) {
      const { window } = await activeWindow();
      if (window && matches(window)) return window;
    } else {
      const { windows } = await listWindows();
      const found = windows.find(matches);
      if (found) return found;
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(
        `WAIT_TIMEOUT: no matching ${opts.foreground === true ? 'foreground ' : ''}window appeared within ${timeoutMs} ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Captures the primary monitor, every monitor, or one window.
 *
 * The helper does the downscaling while the bitmap is still in its hands, because a
 * 4K screenshot is slow to encode, slow to base64 and harder for a model to point at
 * accurately than a 1280-wide one. Nothing downstream ever wants the full-size image,
 * so it is never produced.
 */
export async function screenshot(opts: {
  window?: number;
  full?: boolean;
  maxWidth?: number;
  /** Crop in pixels of the most recent returned screenshot. */
  crop?: Rect;
}): Promise<Screenshot> {
  return exclusive(() => screenshotLocked(opts));
}

async function screenshotFromReply(
  reply: Record<string, any>,
  file: string,
  requestedWindow: number | null
): Promise<Screenshot> {
  const region = reply['region'] as Rect;
  const size = reply['image'] as { width: number; height: number };
  if (
    !region ||
    !size ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    region.width <= 0 ||
    region.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new ComputerError('The desktop helper returned invalid screenshot geometry.');
  }
  const readStartedAt = Date.now();
  const fileInfo = await fs.stat(file).catch(() => {
    throw new ComputerError('The screen capture produced no image.');
  });
  if (fileInfo.size > MAX_SCREENSHOT_PNG_BYTES) {
    throw new ComputerError(
      `SCREENSHOT_TOO_LARGE: encoded PNG is ${fileInfo.size} bytes; limit ${MAX_SCREENSHOT_PNG_BYTES} bytes`
    );
  }
  const png = await fs.readFile(file).catch(() => {
    throw new ComputerError('The screen capture produced no image.');
  });
  if (png.length === 0) throw new ComputerError('The screen capture came back empty.');
  const readMs = Date.now() - readStartedAt;

  const rawMode = String(reply['captureMode'] ?? (requestedWindow === null ? 'screen' : 'screen_fallback'));
  const captureMode: Screenshot['captureMode'] =
    rawMode === 'window' || rawMode === 'screen_fallback' ? rawMode : 'screen';
  // Only an actual background-window bitmap can authorize later input against that
  // window. A screen fallback contains visible pixels (possibly an occluder), so it must
  // retain screen topology rather than relabel those pixels with the requested window.
  const frameWindow = captureMode === 'window' ? requestedWindow : null;
  const scale = size.width / region.width;
  const replyWindowGeometry = reply['windowGeometry'] as Rect | undefined;
  const rawDisplays = reply['displays'];
  const displayTopology = Array.isArray(rawDisplays) && rawDisplays.length > 0 && rawDisplays.every((value) =>
    value &&
    typeof value === 'object' &&
    Number.isFinite((value as Rect).x) &&
    Number.isFinite((value as Rect).y) &&
    Number.isFinite((value as Rect).width) &&
    Number.isFinite((value as Rect).height) &&
    (value as Rect).width > 0 &&
    (value as Rect).height > 0
  )
    ? (rawDisplays as Rect[]).map((value) => ({ ...value }))
    : null;
  const frame: Frame = {
    id: nextFrameId++,
    helperGeneration: generationOfReply(reply),
    region,
    scale,
    width: size.width,
    height: size.height,
    windowId: frameWindow,
    windowGeometry: frameWindow === null ? null : replyWindowGeometry ?? { ...region },
    displayTopology: frameWindow === null ? displayTopology : null,
    captureMode
  };
  rememberFrame(frame);
  const encodeStartedAt = Date.now();
  const data = png.toString('base64');
  logInfo(
    `desktop timing screenshot_read_ms=${readMs} screenshot_base64_ms=${Date.now() - encodeStartedAt} screenshot_bytes=${png.length}`
  );
  return {
    data,
    frameId: frame.id,
    width: frame.width,
    height: frame.height,
    region: frame.region,
    scale: frame.scale,
    focused: requestedWindow === null ? null : reply['focused'] === true,
    captureMode,
    windowId: frame.windowId
  };
}

/**
 * @param cropFrame Frame a crop is expressed in. Callers that ran something between the
 * frame the model saw and this capture pass it explicitly; everyone else means the
 * current one.
 */
async function screenshotLocked(
  opts: {
    window?: number;
    /** Native capture rechecks the exact ownership of a related menu/popup. */
    ownerWindow?: number;
    full?: boolean;
    maxWidth?: number;
    crop?: Rect;
  },
  cropFrame?: Frame | null,
  expected?: ExpectedHelper
): Promise<Screenshot> {
  if (opts.crop && (opts.window !== undefined || opts.full === true)) {
    throw new ComputerError('crop cannot be combined with window or full capture');
  }

  let cropRegion: Rect | undefined;
  if (opts.crop) {
    const source = cropFrame === undefined ? lastFrame : cropFrame;
    const frame = qualifiedFrame(source);
    if (source && !frame) throw new ComputerError('STALE_FRAME: take a new screenshot before cropping.');
    if (!frame) throw new ComputerError('Take a screenshot first — crop coordinates refer to the most recent frame.');
    expected = { generation: frame.helperGeneration, code: 'STALE_FRAME' };
    const crop = {
      x: Math.floor(opts.crop.x),
      y: Math.floor(opts.crop.y),
      width: Math.floor(opts.crop.width),
      height: Math.floor(opts.crop.height)
    };
    if (crop.width <= 0 || crop.height <= 0) throw new ComputerError('crop width and height must be positive');
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.x + crop.width > frame.width ||
      crop.y + crop.height > frame.height
    ) {
      throw new ComputerError(
        `crop must fit inside frame ${frame.id} (${frame.width}x${frame.height})`
      );
    }
    const left = Math.round(frame.region.x + crop.x / frame.scale);
    const top = Math.round(frame.region.y + crop.y / frame.scale);
    const right = Math.round(frame.region.x + (crop.x + crop.width) / frame.scale);
    const bottom = Math.round(frame.region.y + (crop.y + crop.height) / frame.scale);
    cropRegion = {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }

  // By default a crop preserves roughly the pixel density the model selected from
  // the previous frame instead of expanding a small crop back to 1280px wide.
  const requestedWidth =
    opts.maxWidth ?? (opts.crop ? Math.max(1, Math.floor(opts.crop.width)) : DEFAULT_SCREENSHOT_WIDTH);
  const limit = Math.min(
    MAX_SCREENSHOT_WIDTH,
    opts.crop && opts.maxWidth === undefined
      ? Math.max(1, requestedWidth)
      : Math.max(320, Math.floor(requestedWidth))
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-'));
  const file = path.join(dir, 'screen.png');
  try {
    const reply = await runHelper({
      op: 'capture',
      file,
      maxWidth: limit,
      ...(cropRegion === undefined ? {} : { region: cropRegion }),
      ...(opts.window === undefined ? {} : { id: opts.window }),
      ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
      ...(opts.full === true ? { full: true } : {})
    }, expected);
    // A crop is a fresh capture of visible display pixels, even when its coordinates came
    // from a window-bound frame. Keeping the source window id here would let pixels from an
    // occluding app authorize later input against the covered window. Publish the crop as
    // screen-bound so its frame identity describes the pixels that were actually captured.
    return await screenshotFromReply(reply, file, opts.crop ? null : opts.window ?? null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Performs a batch of actions.
 *
 * Image coordinates are converted to screen coordinates against the region the last
 * screenshot showed, so the model can point at what it saw without knowing anything
 * about monitor layout or scaling.
 */
export interface PointerResult {
  screen: { x: number; y: number };
  image: { x: number; y: number } | null;
  frameId: number | null;
  imageSize: { width: number; height: number } | null;
}

export async function act(
  actions: Action[],
  opts: {
    frameId?: number;
    window?: number;
    ownerWindow?: number;
    app?: string;
    ownerApp?: string;
    beforeSideEffect?: ComputerSideEffectPreflight;
  } = {}
): Promise<ActionResult> {
  return exclusive(() => actLocked(actions, opts));
}

/**
 * Acts and then verifies, as one indivisible operation.
 *
 * Doing this as act() followed by screenshot() takes the lock twice, and another chat or
 * agent can focus a window, click, or capture in the gap — so the "after" picture could
 * show someone else's result. That would defeat the only reason to ask for a capture in
 * the same call. The crop is resolved against the frame that was current before the
 * actions ran, which is the one whose coordinates the caller was looking at.
 */
export async function actAndCapture(
  actions: Action[],
  opts: {
    frameId?: number;
    /** Windows physical input is activated and checked against this exact window. */
    window?: number;
    ownerWindow?: number;
    app?: string;
    ownerApp?: string;
    /**
     * MCP-owned live authority/lifecycle check. Invoked after every local wait and immediately
     * before each native input batch or Electron clipboard effect; this layer never interprets
     * the policy result itself.
     */
    beforeSideEffect?: ComputerSideEffectPreflight;
    capture?: {
      window?: number;
      full?: boolean;
      maxWidth?: number;
      crop?: Rect;
      /** Privacy mode: capture whatever window is in front once the actions have run. */
      preferActiveWindow?: boolean;
    };
    verify?: VerificationSpec;
  } = {}
): Promise<ActionResult & { screenshot: Screenshot | null; verification: VerificationResult | null }> {
  return exclusive(async () => {
    const before = opts.frameId === undefined ? qualifiedFrame(lastFrame) : frameById(opts.frameId);
    // capture.crop is expressed in pixels of the screenshot the caller saw, exactly like a
    // coordinate action. Another chat/agent can replace the app-global lastFrame between that
    // screenshot and this call, so using whichever frame happens to be current would crop an
    // unrelated picture. Bind the crop to the same explicit frame identity used by pointing.
    if (opts.capture?.crop) {
      if (opts.frameId === undefined) {
        throw new ComputerError(
          'FRAME_REQUIRED: captureCrop must include the frameId returned with the screenshot its coordinates came from.'
        );
      }
      if (!before) {
        throw new ComputerError(
          `STALE_FRAME: captureCrop is for frame ${opts.frameId}, but that frame is no longer retained. Take a new screenshot and crop that frame.`
        );
      }
    }
    const result = await actLocked(actions, opts);
    let verification: VerificationResult | null = null;
    if (opts.verify) {
      try {
        verification = await verifyDesktopLocked(opts.verify);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ComputerError(
          `POSTCONDITION_FAILED: completed_count=${result.completedCount}. ${message}`,
          { completedCount: result.completedCount, failedIndex: result.completedCount, completedRoutes: result.routes }
        );
      }
    }
    if (!opts.capture) return { ...result, screenshot: null, verification };

    try {
      const { preferActiveWindow, ...capture } = opts.capture;
      // Resolve under the action lock. An explicit input target also owns its default result
      // capture, even if the completed action opened a different foreground window.
      if (capture.window === undefined && capture.full !== true && capture.crop === undefined) {
        capture.window = opts.window ?? (preferActiveWindow ? (await activeWindow()).window?.id : undefined);
      }
      return { ...result, screenshot: await screenshotLocked(capture, before), verification };
    } catch (err) {
      throw new ComputerError(
        `CAPTURE_AFTER_FAILED: completed_count=${result.completedCount}. ${err instanceof Error ? err.message : String(err)}. Observe again; do not repeat completed actions.`,
        { completedCount: result.completedCount, failedIndex: result.completedCount, completedRoutes: result.routes }
      );
    }
  });
}

async function verifyDesktopLocked(spec: VerificationSpec): Promise<VerificationResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(10_000, Math.max(0, Math.floor(spec.timeoutMs ?? 2_000)));
  const deadline = startedAt + timeoutMs;
  const needle = 'match' in spec ? spec.match.trim().toLowerCase() : '';
  for (;;) {
    if (spec.until === 'foreground') {
      const current = (await activeWindow()).window;
      if (current?.id === spec.window) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: `window ${spec.window} is foreground`,
          snapshotId: null
        };
      }
    } else if (spec.until === 'window_exists' || spec.until === 'window_closed') {
      const { windows } = await listWindows();
      const found = windows.find(
        (window) =>
          window.title.toLowerCase().includes(needle) || window.process.toLowerCase().includes(needle)
      );
      if ((spec.until === 'window_exists' && found) || (spec.until === 'window_closed' && !found)) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: found ? `found window ${found.id} ${JSON.stringify(found.title)}` : `no window matches ${JSON.stringify(spec.match)}`,
          snapshotId: null
        };
      }
    } else {
      try {
        const found = await findUiLocked(
          { window: spec.window, query: spec.match, role: spec.role, maxResults: 1 },
          null
        );
        const present = found.elements.length > 0;
        if ((spec.until === 'ui_appears' && present) || (spec.until === 'ui_disappears' && !present)) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: present
              ? `found ${found.elements[0]?.ref ?? 'matching control'}`
              : `no control matches ${JSON.stringify(spec.match)}`,
            snapshotId: found.snapshotId
          };
        }
      } catch (err) {
        // A closing window is a satisfied disappearance, but other UIA failures must remain
        // visible rather than being retried until they look like success.
        if (
          spec.until === 'ui_disappears' &&
          err instanceof ComputerError &&
          /WINDOW_NOT_FOUND|UIA_FAILED: no accessible window/i.test(err.message)
        ) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: 'target window/control is gone',
            snapshotId: null
          };
        }
        throw err;
      }
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(`VERIFY_TIMEOUT: ${spec.until} was not satisfied within ${timeoutMs} ms`);
    }
    // UIA/WinEvent providers are inconsistent across frameworks. A short bounded polling
    // fallback owns the wait locally so the model does not burn turns asking again.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function actLocked(
  actions: Action[],
  opts: {
    frameId?: number;
    window?: number;
    ownerWindow?: number;
    app?: string;
    ownerApp?: string;
    beforeSideEffect?: ComputerSideEffectPreflight;
  }
): Promise<ActionResult> {
  if (process.platform !== 'win32' && actions.some(action => action.type === 'paste' || action.type === 'launch_app' || action.type === 'ui_action')) {
    throw new ComputerError('ACTION_UNSUPPORTED: paste, launch_app and ui_action are currently Windows only.');
  }
  if (actions.some(action => action.type === 'paste') && opts.window === undefined) {
    throw new ComputerError('WINDOW_REQUIRED: paste needs an explicit target window.');
  }
  const firstPaste = actions.findIndex(action => action.type === 'paste');
  if (firstPaste >= 0 && actions.slice(firstPaste + 1).some(action => action.type === 'paste' || action.type === 'write_clipboard')) {
    throw new ComputerError('PASTE_SEQUENCE: observe the first paste result before replacing clipboard text again; queued Ctrl+V does not prove the app consumed it.');
  }
  if (opts.window !== undefined) {
    if (process.platform !== 'win32') throw new ComputerError('WINDOW_TARGET_UNSUPPORTED: window-scoped input is currently Windows only.');
    if (!Number.isSafeInteger(opts.window) || opts.window <= 0) throw new ComputerError('INVALID_WINDOW: expected a window id from observe.');
    if (actions.some(action => action.type === 'focus' && action.window !== opts.window)) {
      throw new ComputerError('WINDOW_MISMATCH: focus must name the same window as the input target.');
    }
  }
  if (opts.ownerWindow !== undefined && (process.platform !== 'win32' || opts.window === undefined ||
      !Number.isSafeInteger(opts.ownerWindow) || opts.ownerWindow <= 0 || opts.ownerWindow === opts.window)) {
    throw new ComputerError('INVALID_WINDOW: popup input requires distinct exact popup and owner windows.');
  }
  const pointing = new Set(['move', 'click', 'double_click', 'scroll', 'drag']);
  const needsFrame = actions.some((a) => pointing.has(a.type));
  if (needsFrame && frames.size === 0) {
    throw new ComputerError('Take a screenshot first — pointing needs a picture to point at.');
  }
  if (needsFrame && opts.frameId === undefined) {
    // The screenshot frame id is the identity of pixel coordinates. `lastFrame` is global to
    // the app and may have been replaced by another chat/agent after this caller saw its image;
    // silently assuming the latest frame turns an attribution failure into a real mouse action
    // on unrelated pixels. Semantic refs do not use image coordinates and stay exempt.
    throw new ComputerError(
      'FRAME_REQUIRED: coordinate actions must include the frameId returned with the screenshot they came from.'
    );
  }
  const requestedFrame = frameById(opts.frameId);
  // Keep a small immutable history so an unrelated observation does not invalidate a
  // caller's coordinates. The helper revalidates a window-bound frame's exact geometry
  // immediately before input, so retaining it does not turn old pixels into blind clicks.
  if (needsFrame && !requestedFrame) {
    throw new ComputerError(
      `STALE_FRAME: frame ${opts.frameId} is no longer retained. Take a screenshot or call get_window_state again and point at the new frame.`
    );
  }
  if (needsFrame && opts.window !== undefined && requestedFrame?.windowId !== opts.window) {
    throw new ComputerError('WINDOW_MISMATCH: coordinates must come from a screenshot of the input target window. Observe that window again.');
  }
  const frame =
    requestedFrame ?? qualifiedFrame(lastFrame) ?? {
      id: 0,
      helperGeneration: 0,
      region: { x: 0, y: 0, width: 1, height: 1 },
      scale: 1,
      width: 1,
      height: 1,
      windowId: null,
      windowGeometry: null,
      displayTopology: null,
      captureMode: 'screen' as const
    };
  if (needsFrame) {
    const assertPointInFrame = (x: number, y: number, label: string): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
        throw new ComputerError(
          `OUT_OF_FRAME: ${label} (${x},${y}) is outside frame ${frame.id} (${frame.width}x${frame.height}). Take a screenshot that includes the target and use coordinates inside that image.`
        );
      }
    };
    for (const action of actions) {
      switch (action.type) {
        case 'move':
        case 'click':
        case 'double_click':
        case 'scroll':
          assertPointInFrame(action.x, action.y, action.type);
          break;
        case 'drag':
          action.path.forEach((point, index) => assertPointInFrame(point.x, point.y, `drag point ${index + 1}`));
          break;
        default:
          break;
      }
    }
  }
  const clampMappedCoordinate = (mapped: number, origin: number, extent: number): number => {
    const lower = Math.ceil(origin);
    const upper = Math.max(lower, Math.ceil(origin + extent) - 1);
    return Math.min(upper, Math.max(lower, mapped));
  };
  const toScreenX = (x: number): number =>
    clampMappedCoordinate(Math.round(frame.region.x + x / frame.scale), frame.region.x, frame.region.width);
  const toScreenY = (y: number): number =>
    clampMappedCoordinate(Math.round(frame.region.y + y / frame.scale), frame.region.y, frame.region.height);

  // Resolve every semantic ref before the first side effect in the batch. Clipboard and wait
  // actions run locally and can occur before a later click_ref/set_value; resolving refs lazily
  // inside that loop used to let an invented/stale ref reject the call only *after* an earlier
  // clipboard write had already happened. Runtime failures can still occur after an action has
  // genuinely started, but deterministic validation errors must not create partial batches.
  const uiTargets = new Map<string, { window: number; runtimeKey: string; snapshotId: number }>();
  for (const action of actions) {
    if (action.type !== 'click_ref' && action.type !== 'set_value' && action.type !== 'ui_action') continue;
    if (!uiTargets.has(action.ref)) uiTargets.set(action.ref, uiTarget(action.ref));
    if (opts.window !== undefined && uiTargets.get(action.ref)!.window !== opts.window) {
      throw new ComputerError('WINDOW_MISMATCH: the accessibility ref belongs to a different input target window.');
    }
  }

  const mapOne = (action: Action): Record<string, unknown> => {
    switch (action.type) {
      case 'click_ref': {
        const target = uiTargets.get(action.ref);
        if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${action.ref}`);
        return {
          type: 'click_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey,
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.count === undefined ? {} : { count: action.count })
        };
      }
      case 'set_value': {
        const target = uiTargets.get(action.ref);
        if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${action.ref}`);
        return {
          type: 'set_value_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey,
          value: action.text
        };
      }
      case 'ui_action': {
        const target = uiTargets.get(action.ref);
        if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${action.ref}`);
        return { type: 'ui_action', window: target.window, snapshotId: target.snapshotId, runtimeKey: target.runtimeKey, action: action.action };
      }
      case 'launch_app':
        return { type: 'launch_app', app: action.app };
      case 'move':
      case 'click':
      case 'double_click':
        return {
          type: action.type,
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          button: 'button' in action ? (action.button ?? 'left') : 'left',
          ...(action.type === 'click' && action.count !== undefined ? { count: action.count } : {})
        };
      case 'scroll':
        return {
          type: 'scroll',
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          scroll_x: action.scroll_x ?? 0,
          scroll_y: action.scroll_y ?? 0,
          ...(action.scrollUnit === 'wheel' ? { rawWheel: true } : {})
        };
      case 'drag':
        return {
          type: 'drag',
          xs: action.path.map((p) => toScreenX(p.x)),
          ys: action.path.map((p) => toScreenY(p.y)),
          button: action.button ?? 'left',
          ...(action.duration_ms === undefined ? {} : { durationMs: action.duration_ms })
        };
      case 'type':
        return { type: 'type', text: action.text };
      case 'keypress':
        return { type: 'keypress', keys: action.keys };
      case 'focus':
        return { type: 'focus', window: action.window };
      default:
        throw new ComputerError(`Unsupported action`);
    }
  };

  // Clipboard steps are not desktop input, so the helper never sees them: the pending
  // batch is flushed at each one instead. That keeps every step in the order it was
  // asked for — put text on the clipboard, then press ctrl+v — without giving up the
  // lock in between, which a second call from the tool layer would have done.
  const clipboard: string[] = [];
  const routes: ActionResult['routes'] = [];
  let completedCount = 0;
  // Validation above is synchronous; pin its helper through every queued native segment,
  // including a segment reached after a local wait or clipboard operation.
  const expected: ExpectedHelper | undefined = needsFrame || uiTargets.size > 0
    ? { generation: helperGeneration, code: uiTargets.size > 0 ? 'STALE_REF' : 'STALE_FRAME' }
    : undefined;
  let batch: ReturnType<typeof mapOne>[] = [];
  let batchIndices: number[] = [];
  let reply: Record<string, any> | null = null;
  let helperUsed = false;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const sending = batch;
    const sendingIndices = batchIndices;
    batch = [];
    batchIndices = [];
    try {
      reply = await runHelper({
        op: 'act',
        actions: sending,
        ...(opts.window === undefined ? {} : { targetWindow: opts.window }),
        ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
        ...(opts.app === undefined ? {} : { targetApp: opts.app }),
        ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }),
        ...(needsFrame
          ? {
              frame: {
                id: frame.id,
                window: frame.windowId,
                ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
                ...(opts.app === undefined ? {} : { targetApp: opts.app }),
                ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }),
                region: frame.region,
                windowGeometry: frame.windowGeometry,
                displays: frame.displayTopology,
                captureMode: frame.captureMode
              }
            }
          : {})
      }, expected, () => opts.beforeSideEffect?.('desktop'));
      helperUsed = true;
      const helperRoutes = Array.isArray(reply['routes']) ? reply['routes'].map(String) : [];
      for (let index = 0; index < sending.length; index++) {
        const route = helperRoutes[index];
        routes.push(route === 'uia' || route === 'focus' || route === 'shell' ? route : 'sendinput');
      }
      completedCount += sending.length;
    } catch (err) {
      const partial = err instanceof ComputerError ? (err.completedCount ?? 0) : 0;
      const failedBatchIndex = err instanceof ComputerError ? (err.failedIndex ?? partial) : partial;
      const helperRoutes = err instanceof ComputerError ? err.completedRoutes : null;
      const hasExactPartialRoutes = helperRoutes !== null && helperRoutes.length === partial;
      if (hasExactPartialRoutes) routes.push(...helperRoutes);
      const totalCompleted = completedCount + partial;
      const originalFailed = sendingIndices[failedBatchIndex] ?? sendingIndices[partial] ?? totalCompleted;
      const message = err instanceof Error ? err.message : String(err);
      const exactRoutes = hasExactPartialRoutes ? [...routes] : null;
      const routeEvidence = exactRoutes
        ? exactRoutes.length > 0
          ? exactRoutes.join('+')
          : 'none'
        : 'unavailable';
      throw new ComputerError(
        `PARTIAL_BATCH: completed_count=${totalCompleted} failed_index=${originalFailed} routes=${routeEvidence}. ${message}`,
        {
          completedCount: totalCompleted,
          failedIndex: originalFailed,
          ...(exactRoutes ? { completedRoutes: exactRoutes } : {})
        }
      );
    }
  };
  for (const [index, action] of actions.entries()) {
    if (action.type === 'paste') {
      await flush();
      try {
        // Target activation is a precondition for publishing the user's clipboard.
        // The physical Ctrl+V still rechecks focus immediately before injection.
        await runHelper({ op: 'act', actions: [{ type: 'focus', window: opts.window }],
          targetWindow: opts.window,
          ...(opts.app === undefined ? {} : { targetApp: opts.app }),
          ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
          ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }) }, expected,
        () => opts.beforeSideEffect?.('desktop'));
        // Clipboard publication remains owned by Electron. The next native action targets
        // the explicitly selected window; it is one authored paste, not two counted steps.
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(helperGeneration, expected);
        await opts.beforeSideEffect?.('clipboard-write');
        assertHelperGeneration(helperGeneration, expected);
        await nativeClipboard.writeText(action.text);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      batch.push({ type: 'keypress', keys: ['ctrl', 'v'] });
      batchIndices.push(index);
      try {
        await flush();
      } catch (err) {
        const partial = err instanceof ComputerError ? err : null;
        throw new ComputerError(
          `${err instanceof Error ? err.message : String(err)}. Clipboard text was replaced; paste delivery is not confirmed.`,
          { completedCount: partial?.completedCount ?? completedCount, failedIndex: partial?.failedIndex ?? index,
            ...(partial?.completedRoutes ? { completedRoutes: partial.completedRoutes } : {}) }
        );
      }
      continue;
    }
    if (action.type === 'wait') {
      await flush();
      const ms = Math.min(10_000, Math.max(0, action.ms ?? 2000));
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'read_clipboard') {
      await flush();
      try {
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(helperGeneration, expected);
        await opts.beforeSideEffect?.('clipboard-read');
        assertHelperGeneration(helperGeneration, expected);
        clipboard.push(await nativeClipboard.readText());
        assertHelperGeneration(helperGeneration, expected);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'write_clipboard') {
      await flush();
      try {
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(helperGeneration, expected);
        await opts.beforeSideEffect?.('clipboard-write');
        assertHelperGeneration(helperGeneration, expected);
        await nativeClipboard.writeText(action.text);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    batch.push(mapOne(action));
    batchIndices.push(index);
  }
  // A pure clipboard/wait batch must not depend on a native accessibility helper at all. This is
  // what makes the connector genuinely useful when the user granted only clipboard access or
  // when the desktop helper is unavailable. Mixed desktop batches still take one final cursor
  // sample after any trailing local wait/clipboard work so the pointer report remains current.
  if (batch.length > 0) {
    await flush();
  } else if (helperUsed) {
    reply = await runHelper({ op: 'cursor' });
  }

  if (reply === null) return { cursor: null, clipboard, completedCount, routes };

  const raw = reply['cursor'] as { x?: unknown; y?: unknown } | undefined;
  const sx = Number(raw?.x);
  const sy = Number(raw?.y);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    throw new ComputerError('The desktop helper returned an invalid pointer position.');
  }
  const current = qualifiedFrame(requestedFrame ?? lastFrame, generationOfReply(reply));
  const image = current
    ? {
        x: Math.round((sx - current.region.x) * current.scale),
        y: Math.round((sy - current.region.y) * current.scale)
      }
    : null;
  return {
    cursor: {
      screen: { x: sx, y: sy },
      image,
      frameId: current?.id ?? null,
      imageSize: current ? { width: current.width, height: current.height } : null
    },
    clipboard,
    completedCount,
    routes
  };
}

function localActionFailure(err: unknown, completedCount: number, failedIndex: number): ComputerError {
  const message = err instanceof Error ? err.message : String(err);
  return new ComputerError(
    `PARTIAL_BATCH: completed_count=${completedCount} failed_index=${failedIndex}. ${message}`,
    { completedCount, failedIndex }
  );
}

/**
 * Electron's clipboard, loaded only if a clipboard action is actually used.
 *
 * Imported lazily rather than at the top of the file because everything else here runs
 * happily outside Electron — the desktop tests drive the helper directly — and a static
 * import would make that impossible for the sake of two actions.
 */
async function electronClipboard(): Promise<Pick<Electron.Clipboard, 'readText' | 'writeText'>> {
  try {
    const { clipboard } = await import('electron');
    if (!clipboard) throw new Error('no clipboard');
    return clipboard;
  } catch {
    throw new ComputerError('The clipboard is only available while the app is running.');
  }
}

/** Confirms the helper can run at all, so the UI can say so before ChatGPT tries. */
export async function checkAvailable(): Promise<string | null> {
  try {
    await listWindows();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`computer use unavailable: ${message}`);
    return message;
  }
}

/**
 * Starts and initializes the helper off the first tool call's critical path.
 *
 * Connection owns when Desktop becomes publishable; shutdown remains owned by
 * `stopComputerHelper`. Clipboard-only configurations deliberately never call this.
 */
export async function prewarmComputerHelper(): Promise<void> {
  try {
    await runHelper({ op: 'warm' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`computer use prewarm failed: ${message}`);
  }
}
