import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ attachment: vi.fn(async () => 'current' as 'current' | 'superseded' | 'unknown') }));
vi.mock('../src/main/session/recorder.js', async original => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  recordToolCall: async () => null
}));
vi.mock('../src/main/session/store.js', async original => ({
  ...await original<typeof import('../src/main/session/store.js')>(),
  conversationAttachment: fixture.attachment
}));
import { assertCurrentCallLifecycle, dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall, emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';

beforeEach(() => {
  fixture.attachment.mockReset();
  fixture.attachment.mockResolvedValue('current');
});

it.each([
  'get_window_state',
  'launch_app',
  'click',
  'press_key',
  'type_text',
  'scroll',
  'set_value',
  'drag',
  'perform_secondary_action',
  'activate_window',
  'read_clipboard',
  'write_clipboard'
])(
  'resolves late exact identity before Desktop %s consumes observation state', async name => {
    const requestId = `late-desktop-${name}`;
    const run = vi.fn(async () => {
      expect(currentCall()?.caller).toMatchObject({ requestId, conversationId: 'desktop-chat', sessionId: 'desktop-session' });
      return ok('observed');
    });
    const pending = dispatch(name, {}, null, requestId, 'desktop', run);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(run).not.toHaveBeenCalled();
    observeRequestCorrelation({ requestId, conversationId: 'desktop-chat', sessionId: 'desktop-session',
      messageId: `message-${name}`, tool: name, observedAt: Date.now() });
    expect((await pending).isError).not.toBe(true);
    expect(run).toHaveBeenCalledOnce();
  }
);

it('fail-closes an in-flight sensitive Desktop call when its exact attachment disappears', async () => {
  let resolveAttachment!: (value: 'current' | 'superseded' | 'unknown') => void;
  fixture.attachment.mockImplementationOnce(() => new Promise(resolve => { resolveAttachment = resolve; }));
  const call: CallContext = {
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: {
      transportKey: null,
      requestId: 'pending-desktop-request',
      conversationId: 'pending-desktop-chat',
      sessionId: 'pending-desktop-session'
    },
    outcome: null,
    evidence: emptyEvidence()
  };

  const pending = runInCallContext(call, assertCurrentCallLifecycle);
  await vi.waitFor(() => expect(fixture.attachment).toHaveBeenCalledWith('pending-desktop-chat', 'pending-desktop-session'));
  resolveAttachment('unknown');

  await expect(pending).rejects.toThrow(/CALLER_IDENTITY_REQUIRED.*no longer has its exact current session\/chat attachment/i);
});
