import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';

vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(),
  conversationAttachment: async () => 'current' as const
}));

const computer = vi.hoisted(() => ({
  actAndCapture: vi.fn(async () => ({
    cursor: {
      screen: { x: 10, y: 20 },
      image: null,
      imageSize: null,
      frameId: null
    },
    clipboard: [],
    screenshot: null,
    completedCount: 2,
    routes: ['local', 'local'],
    verification: null
  })),
  listWindows: vi.fn(async () => ({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } }))
}));

vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: class ComputerError extends Error {},
  DEFAULT_SCREENSHOT_WIDTH: 1280,
  MAX_SCREENSHOT_WIDTH: 4096,
  actAndCapture: computer.actAndCapture,
  activeWindow: vi.fn(),
  findUi: vi.fn(),
  getWindowState: vi.fn(),
  listWindows: computer.listWindows,
  screenshot: vi.fn(),
  waitForWindow: vi.fn()
}));

import { registerMacOSDesktopTools as registerDesktopTools } from '../src/main/mcp/tools-desktop-macos.js';
import { authorizeToolAction, type ToolContext } from '../src/main/mcp/kernel.js';
import type { ActionRequirement } from '../src/main/action-policy.js';

let principalSequence = 0;
function exactDesktopCall<T>(fn: () => Promise<T>): Promise<T> {
  const id = ++principalSequence;
  const call: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: {
      transportKey: null,
      requestId: `desktop-permission-${id}`,
      conversationId: `desktop-permission-conversation-${id}`,
      sessionId: `desktop-permission-session-${id}`
    },
    outcome: null,
    evidence: emptyEvidence()
  };
  return runInCallContext(call, fn);
}

function caps(over: Partial<Capabilities>): Capabilities {
  return {
    browse: false,
    search: false,
    read: false,
    metadata: false,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    command: false,
    saveArtifact: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false,
    ...over
  };
}

describe('macOS Desktop computer permission normalization', () => {
  it('allows wait in a clipboard-only batch without demanding mouse/keyboard control', async () => {
    const liveCaps = caps({ clipboardRead: true });
    const policyCtx: ToolContext = { roots: [], caps: liveCaps, readOnly: false, privacyScreenshots: false };
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    const registrar = {
      ctx: policyCtx,
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'computer') computerHandler = handler;
      },
      authorize: (name: string, requirement: ActionRequirement) => authorizeToolAction(policyCtx, 'desktop', name, requirement),
      guarded: vi.fn()
    };
    registerDesktopTools(registrar as never);
    expect(computerHandler).not.toBeNull();

    const result = await exactDesktopCall(() => computerHandler!({
      actions: [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }]
    }));

    expect(result.isError).not.toBe(true);
    expect(computer.actAndCapture).toHaveBeenCalledWith(
      [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }],
      expect.objectContaining({ frameId: undefined, capture: undefined })
    );
  });

  it('bounds clipboard text before it becomes an MCP result', async () => {
    const liveCaps = caps({ clipboardRead: true });
    const policyCtx: ToolContext = { roots: [], caps: liveCaps, readOnly: false, privacyScreenshots: false };
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    computer.actAndCapture.mockResolvedValueOnce({
      cursor: null,
      clipboard: ['x'.repeat(250_000)],
      screenshot: null,
      completedCount: 1,
      routes: ['local'],
      verification: null
    } as any);
    const registrar = {
      ctx: policyCtx,
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'computer') computerHandler = handler;
      },
      authorize: (name: string, requirement: ActionRequirement) => authorizeToolAction(policyCtx, 'desktop', name, requirement),
      guarded: vi.fn()
    };
    registerDesktopTools(registrar as never);

    const result = await exactDesktopCall(() => computerHandler!({ actions: [{ type: 'read_clipboard' }] }));
    const text = result.content[0].text as string;
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(70_000);
  });

  it('caps the visible-window list and says when more matches exist', async () => {
    const liveCaps = caps({ screen: true });
    const policyCtx: ToolContext = { roots: [], caps: liveCaps, readOnly: false, privacyScreenshots: false };
    computer.listWindows.mockResolvedValueOnce({
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
      windows: Array.from({ length: 130 }, (_, index) => ({
        id: index + 1,
        process: 'app.exe',
        title: `Window ${index + 1}`,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        state: 'open'
      }))
    } as any);
    let observeHandler: ((input: any) => Promise<any>) | null = null;
    const registrar = {
      ctx: policyCtx,
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'observe') observeHandler = handler;
      },
      authorize: (name: string, requirement: ActionRequirement) => authorizeToolAction(policyCtx, 'desktop', name, requirement),
      guarded: async (_cap: unknown, _name: unknown, fn: () => Promise<any>) => fn()
    };
    registerDesktopTools(registrar as never);

    const result = await observeHandler!({ what: 'windows', max_elements: 3 });
    const text = result.content[0].text as string;
    expect(text).toContain('showing 3 of 130 matching windows');
    expect(text).toContain('Window 3');
    expect(text).not.toContain('Window 4\n');
  });
});
