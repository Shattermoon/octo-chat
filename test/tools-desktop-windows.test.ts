import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityTools, DESKTOP_CAPABILITIES, type Capabilities } from '../src/shared/types.js';

const native = vi.hoisted(() => ({
  act: vi.fn(),
  getWindowState: vi.fn(),
  call: null as any,
  apis: [] as any[],
  allowUnattributed: false,
  lifecycle: vi.fn(async (): Promise<void> => undefined),
  sideEffects: [] as string[]
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ multiAgent: { allowUnattributedCalls: native.allowUnattributed } }) }));
vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: class extends Error {}, act: native.act, getWindowState: native.getWindowState
}));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => native.call, noteCount: vi.fn() }));
vi.mock('../src/main/mcp/kernel.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/mcp/kernel.js')>(),
  assertCurrentCallLifecycle: native.lifecycle
}));
vi.mock('../src/main/computer/windows-api.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/computer/windows-api.js')>();
  return { ...original, createWindowsComputerApi: () => {
    const mutating = new Set(['launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action', 'activate_window']);
    const api = Object.fromEntries(original.WINDOWS_API_METHODS.map(name => [name, vi.fn(async (input: any, options?: { beforeSideEffect?: (effect: string) => Promise<void> }) => {
      if (mutating.has(name)) {
        await options?.beforeSideEffect?.('desktop');
        if (name === 'type_text' && /[\r\n]/.test(String(input?.text ?? ''))) {
          await options?.beforeSideEffect?.('clipboard-write');
          await options?.beforeSideEffect?.('desktop');
        }
        native.sideEffects.push(name);
      }
      return undefined;
    })]));
    native.apis.push(api);
    return api;
  } };
});
import { registerWindowsDesktopTools } from '../src/main/mcp/tools-desktop-windows.js';
import { authorizeToolAction, type ToolContext } from '../src/main/mcp/kernel.js';
import type { ActionContext, ActionPolicyDecision, ActionRequirement } from '../src/main/action-policy.js';

function surface(
  over: Partial<Capabilities> = {},
  onActionPolicyDecision?: (decision: ActionPolicyDecision, action: ActionContext) => void
) {
  const caps = { screen: true, control: true, clipboardRead: true, clipboardWrite: true, ...over } as Capabilities;
  const ctx: ToolContext = { roots: [], caps, exposedCaps: { ...caps }, readOnly: false, sessionTools: false, agentTools: false, onActionPolicyDecision };
  const tools = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  registerWindowsDesktopTools({ caps, exposedCaps: { ...caps },
    register: (name: string, config: any, handler: any) => tools.set(name, { config, handler }),
    authorize: (name: string, requirement: ActionRequirement) => authorizeToolAction(ctx, 'desktop', name, requirement),
    guarded: async (cap: keyof Capabilities, name: string, run: () => Promise<any>) => {
      const decision = authorizeToolAction(ctx, 'desktop', name, { kind: 'capability', capability: cap });
      if (decision.effect === 'allow') {
        try {
          return await run();
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
          };
        }
      }
      return {
        isError: true,
        content: [{
          type: 'text',
          text: decision.reasonCode === 'caller_identity_required' ? 'CALLER_IDENTITY_REQUIRED' : 'TOOL_DISABLED'
        }]
      };
    }
  } as never);
  return {
    caps,
    ctx,
    tools,
    call: (name: string, args: any = {}) => tools.get(name)!.handler(tools.get(name)!.config.inputSchema.parse(args))
  };
}
const window = { app: 'fixture.exe', id: 71 };
let principalSequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  native.apis.length = 0;
  native.sideEffects.length = 0;
  native.allowUnattributed = false;
  native.lifecycle.mockReset();
  native.lifecycle.mockResolvedValue(undefined);
  native.act.mockImplementation(async (actions: Array<{ type: string }>, opts?: { beforeSideEffect?: (effect: string) => Promise<void> }) => {
    for (const action of actions) {
      const effect = action.type === 'read_clipboard' ? 'clipboard-read'
        : action.type === 'write_clipboard' ? 'clipboard-write'
          : 'desktop';
      await opts?.beforeSideEffect?.(effect);
      native.sideEffects.push(action.type);
    }
    return { cursor: null, clipboard: ['fixture'], completedCount: actions.length, routes: actions.map(() => 'local') };
  });
  const id = ++principalSequence;
  native.call = { caller: { requestId: `request-${id}`, conversationId: `conversation-${id}`, sessionId: `test-${id}` } };
});

describe('Windows Desktop public registrar', () => {
  it('routes application launch and clipboard mutation through the central action vocabulary', async () => {
    const observed: Array<{ decision: ActionPolicyDecision; action: ActionContext }> = [];
    const api = surface({}, (decision, action) => observed.push({ decision, action }));
    await api.call('launch_app', { app: 'fixture.exe' });
    await api.call('write_clipboard', { text: 'fixture' });
    expect(observed.map(entry => ({
      effect: entry.decision.effect,
      actionClass: entry.action.actionClass,
      target: entry.action.target.kind,
      capability: entry.action.capability
    }))).toEqual([
      { effect: 'allow', actionClass: 'launch-application', target: 'application', capability: 'control' },
      { effect: 'allow', actionClass: 'launch-application', target: 'application', capability: 'control' },
      { effect: 'allow', actionClass: 'clipboard-write', target: 'clipboard', capability: 'clipboardWrite' },
      { effect: 'allow', actionClass: 'clipboard-write', target: 'clipboard', capability: 'clipboardWrite' }
    ]);
  });

  it('rechecks multiline type_text as control, clipboard-write, then control at its effect boundaries', async () => {
    const observed: Array<{ decision: ActionPolicyDecision; action: ActionContext }> = [];
    const api = surface({}, (decision, action) => observed.push({ decision, action }));

    const result = await api.call('type_text', { window, text: 'first\nsecond' });

    expect(result.isError).not.toBe(true);
    expect(observed.map(entry => ({
      effect: entry.decision.effect,
      reason: entry.decision.reasonCode,
      actionClass: entry.action.actionClass,
      capability: entry.action.capability
    }))).toEqual([
      { effect: 'allow', reason: 'allowed', actionClass: 'desktop-interact', capability: 'control' },
      { effect: 'allow', reason: 'allowed', actionClass: 'clipboard-write', capability: 'clipboardWrite' },
      { effect: 'allow', reason: 'allowed', actionClass: 'desktop-interact', capability: 'control' },
      { effect: 'allow', reason: 'allowed', actionClass: 'clipboard-write', capability: 'clipboardWrite' },
      { effect: 'allow', reason: 'allowed', actionClass: 'desktop-interact', capability: 'control' }
    ]);
    expect(native.sideEffects).toEqual(['type_text']);
  });

  it('matches the settings tool names to registration for each Desktop permission', () => {
    for (const capability of DESKTOP_CAPABILITIES) {
      const caps = { screen: false, control: false, clipboardRead: false, clipboardWrite: false, [capability]: true };
      expect(capabilityTools(capability, 'windows')).toEqual([...surface(caps).tools.keys()]);
      expect(capabilityTools(capability, 'linux')).toEqual([]);
      expect(capabilityTools(capability)).toEqual([]);
    }
  });

  it('publishes the 13 Window2 operations and separately permissioned clipboard access', () => {
    expect([...surface().tools.keys()].sort()).toEqual(['activate_window', 'click', 'drag', 'get_window', 'get_window_state', 'launch_app', 'list_apps', 'list_windows', 'perform_secondary_action', 'press_key', 'read_clipboard', 'scroll', 'set_value', 'type_text', 'write_clipboard']);
    expect([...surface({ control: false, clipboardRead: false, clipboardWrite: false }).tools.keys()].sort()).toEqual(['get_window', 'get_window_state', 'list_apps', 'list_windows']);
  });

  it('uses live permissions and checks multiline clipboard permission before any native work', async () => {
    const api = surface({ clipboardWrite: false });
    expect((await api.call('type_text', { window, text: 'one\r\ntwo' })).isError).toBe(true);
    expect(native.apis).toHaveLength(0);
    api.caps.control = false;
    expect((await api.call('launch_app', { app: 'fixture.exe' })).isError).toBe(true);
    expect(native.apis).toHaveLength(0);
  });

  it.each([
    ['launch_app', { app: 'fixture.exe' }],
    ['press_key', { window, key: 'A' }],
    ['type_text', { window, text: 'fixture' }],
    ['activate_window', { window }],
    ['click', { window, x: 2, y: 3 }],
    ['scroll', { window, x: 2, y: 3, scrollX: 0, scrollY: 120 }],
    ['set_value', { window, element_index: 0, value: 'fixture' }],
    ['drag', { window, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }],
    ['perform_secondary_action', { window, element_index: 0, action: 'Invoke' }],
    ['write_clipboard', { text: 'fixture' }],
    ['read_clipboard', {}]
  ] as const)('denies unattributed %s before native work while an exact Principal keeps existing behavior', async (method, args) => {
    native.call = { caller: { requestId: `unresolved-${method}`, conversationId: null, sessionId: null } };
    const beforeApis = native.apis.length;
    const denied = await surface().call(method, args);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('CALLER_IDENTITY_REQUIRED');
    expect(native.apis).toHaveLength(beforeApis);
    expect(native.act).not.toHaveBeenCalled();

    native.call = {
      caller: {
        requestId: `exact-${method}`,
        conversationId: `conversation-${method}`,
        sessionId: `session-${method}`
      }
    };
    const allowed = await surface().call(method, args);
    expect(allowed.isError).not.toBe(true);
    if (method === 'read_clipboard' || method === 'write_clipboard') {
      expect(native.act).toHaveBeenCalledTimes(1);
    } else {
      expect(native.apis.at(-1)?.[method]).toHaveBeenCalledOnce();
    }
  });

  it('keeps exact caller state across request registrars and never lends indexes to another caller', async () => {
    await surface().call('get_window_state', { window });
    const first = native.apis[0];
    await surface().call('click', { window, element_index: 2 });
    expect(first.click).toHaveBeenCalledExactlyOnceWith(
      { window, element_index: 2 },
      { beforeSideEffect: expect.any(Function) }
    );
    native.call = { caller: { requestId: 'other-request', conversationId: 'other-chat', sessionId: 'other-principal' } };
    await surface().call('click', { window, element_index: 2 });
    expect(native.apis).toHaveLength(2);
    expect(native.apis[1].click).toHaveBeenCalledOnce();
    native.call = null;
    expect(JSON.stringify(await surface().call('click', { window, x: 2, y: 3 }))).toContain('CALLER_IDENTITY_REQUIRED');
    expect(native.apis).toHaveLength(2);
    await surface().call('list_windows');
    await surface().call('list_windows');
    expect(native.apis).toHaveLength(4);
  });

  it('preserves native values and literal multiline text without returning user input as success prose', async () => {
    const api = surface();
    await api.call('list_windows');
    native.apis[0].list_apps.mockResolvedValue([{ id: 'fixture.exe', displayName: 'Fixture', isRunning: true, windows: [window] }]);
    const apps = await api.call('list_apps');
    expect(apps.structuredContent.value[0]).toMatchObject({ isRunning: true, windows: [window] });
    const result = await api.call('type_text', { window, text: 'one\ntwo\r\nthree' });
    expect(native.apis[0].type_text).toHaveBeenCalledExactlyOnceWith(
      { window, text: 'one\ntwo\r\nthree' },
      { beforeSideEffect: expect.any(Function) }
    );
    expect(result.structuredContent.value).toBeNull();
    expect(result.content[0].text).toContain('observe to verify');
    expect(JSON.stringify(result)).not.toContain('three');
  });

  it('keeps unattributed observation isolated without letting the opt-in authorize Desktop mutation', async () => {
    await surface().call('get_window_state', { window });
    const identified = native.apis[0];
    native.call = { caller: { requestId: 'unresolved-observation' } };
    native.allowUnattributed = true;
    await surface().call('get_window_state', { window });
    const anonymous = native.apis[1];
    native.call = { caller: { requestId: 'unresolved-input' } };
    expect(JSON.stringify(await surface().call('click', { window, element_index: 2 }))).toContain('CALLER_IDENTITY_REQUIRED');
    expect(anonymous.click).not.toHaveBeenCalled();
    expect(identified.click).not.toHaveBeenCalled();
    native.call = null;
    expect(JSON.stringify(await surface().call('drag', { window, from_x: 1, from_y: 1, to_x: 2, to_y: 2 }))).toContain('CALLER_IDENTITY_REQUIRED');
    expect(native.apis).toHaveLength(2);
    native.allowUnattributed = false;
    expect(JSON.stringify(await surface().call('click', { window, x: 2, y: 3 }))).toContain('CALLER_IDENTITY_REQUIRED');
    expect(anonymous.click).not.toHaveBeenCalled();
    native.allowUnattributed = true;
    await surface().call('get_window_state', { window });
    expect(native.apis).toHaveLength(2);
    native.allowUnattributed = false;
    await surface().call('list_windows');
    expect(native.apis).toHaveLength(3);
  });

  it('returns image blocks and structured screenshot values under one combined response bound', async () => {
    const api = surface();
    await api.call('list_windows');
    native.apis[0].get_window_state.mockResolvedValue({ window, accessibility: null, screenshots: [{ id: 'frame-1', url: 'data:image/png;base64,YQ==', width: 1, height: 1, originX: 0, originY: 0, zIndex: 0 }] });
    const result = await api.call('get_window_state', { window });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' });
    expect(result.content[0].text).not.toContain('base64');
    expect(result.structuredContent.value).toEqual(JSON.parse(result.content[0].text));
    expect(result.structuredContent.value.screenshots[0]).not.toHaveProperty('url');
    native.apis[0].get_window_state.mockResolvedValue({ window, screenshots: [{ url: `data:image/png;base64,${'A'.repeat(4_200_000)}` }] });
    expect((await api.call('get_window_state', { window })).content.filter((part: any) => part.type === 'image')).toHaveLength(1);
    native.apis[0].get_window_state.mockResolvedValue({ window, screenshots: [{ url: `data:image/png;base64,${'A'.repeat(8_400_000)}` }] });
    const oversized = await api.call('get_window_state', { window });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized)).toContain('DESKTOP_RESULT_TOO_LARGE');
  });

  it('checks browser chords against the exact target including popup handles', async () => {
    const api = surface();
    native.getWindowState.mockResolvedValue({ window: { id: 71, title: 'Owned browser popup', process: 'chrome' } });
    const result = await api.call('press_key', { window, key: 'Control_L+w' });
    expect(result.isError).toBe(true);
    expect(native.getWindowState).toHaveBeenCalledExactlyOnceWith({ window: 71, includeScreenshot: false, includeUi: false });
    expect(native.apis).toHaveLength(0);
    native.getWindowState.mockResolvedValue({ window: { id: 71, title: 'Editor', process: 'notepad' } });
    await api.call('press_key', { window, key: 'Control_L+w' });
    expect(native.apis[0].press_key).toHaveBeenCalledExactlyOnceWith(
      { window, key: 'Control_L+w' },
      { beforeSideEffect: expect.any(Function) }
    );
  });

  it.each(['capability', 'read-only'] as const)(
    'revalidates %s after Windows browser-chord inspection before native input',
    async revocation => {
      let releaseWindow!: (value: { window: { id: number; title: string; process: string } }) => void;
      native.getWindowState.mockImplementationOnce(() => new Promise(resolve => { releaseWindow = resolve; }));
      const api = surface();
      const pending = api.call('press_key', { window, key: 'Control_L+w' });
      await vi.waitFor(() => expect(native.getWindowState).toHaveBeenCalledTimes(1));
      if (revocation === 'capability') api.caps.control = false;
      else api.ctx.readOnly = true;
      releaseWindow({ window: { id: 71, title: 'Editor', process: 'notepad' } });

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('TOOL_DISABLED');
      if (revocation === 'read-only') {
        expect(JSON.stringify(result)).toContain('Read-only mode is on');
        expect(JSON.stringify(result)).toContain('turn Read-only off');
      }
      expect(native.sideEffects).not.toContain('press_key');
    }
  );

  it('revalidates caller lifecycle after Windows browser-chord inspection before native input', async () => {
    let releaseWindow!: (value: { window: { id: number; title: string; process: string } }) => void;
    native.getWindowState.mockImplementationOnce(() => new Promise(resolve => { releaseWindow = resolve; }));
    const api = surface();
    const pending = api.call('press_key', { window, key: 'Control_L+w' });
    await vi.waitFor(() => expect(native.getWindowState).toHaveBeenCalledTimes(1));
    native.lifecycle.mockRejectedValueOnce(new Error('CHAT_BLOCKED: no further side effect ran'));
    releaseWindow({ window: { id: 71, title: 'Editor', process: 'notepad' } });

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('CHAT_BLOCKED');
    expect(native.sideEffects).not.toContain('press_key');
  });

  it.each(['read_clipboard', 'write_clipboard'] as const)(
    'revalidates %s after act admission before Electron clipboard I/O',
    async method => {
      const api = surface();
      let releaseAct!: () => void;
      native.act.mockImplementationOnce(async (actions: Array<{ type: string }>, opts?: { beforeSideEffect?: (effect: string) => Promise<void> }) => {
        await new Promise<void>(resolve => { releaseAct = resolve; });
        const effect = method === 'read_clipboard' ? 'clipboard-read' : 'clipboard-write';
        await opts?.beforeSideEffect?.(effect);
        native.sideEffects.push(actions[0]!.type);
        return { cursor: null, clipboard: ['fixture'], completedCount: 1, routes: ['local'] };
      });
      const pending = api.call(method, method === 'write_clipboard' ? { text: 'fixture' } : {});
      await vi.waitFor(() => expect(native.act).toHaveBeenCalledTimes(1));
      if (method === 'read_clipboard') api.caps.clipboardRead = false;
      else api.caps.clipboardWrite = false;
      releaseAct();

      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('TOOL_DISABLED');
      expect(native.sideEffects).not.toContain(method);
    }
  );
});
