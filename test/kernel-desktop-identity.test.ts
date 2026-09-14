import { expect, it, vi } from 'vitest';
vi.mock('../src/main/session/recorder.js', async original => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  recordToolCall: async () => null
}));
vi.mock('../src/main/session/store.js', async original => ({
  ...await original<typeof import('../src/main/session/store.js')>(),
  conversationAttachment: async () => 'current'
}));
import { dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';

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

it('resolves late exact identity before the macOS composite computer surface can mutate', async () => {
  const requestId = 'late-desktop-computer';
  const run = vi.fn(async () => {
    expect(currentCall()?.caller).toMatchObject({
      requestId,
      conversationId: 'desktop-computer-chat',
      sessionId: 'desktop-computer-session'
    });
    return ok('mutated');
  });
  const pending = dispatch(
    'computer',
    { actions: [{ type: 'write_clipboard', text: 'fixture' }] },
    null,
    requestId,
    'desktop',
    run
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(run).not.toHaveBeenCalled();
  observeRequestCorrelation({
    requestId,
    conversationId: 'desktop-computer-chat',
    sessionId: 'desktop-computer-session',
    messageId: 'message-computer',
    tool: 'computer',
    observedAt: Date.now()
  });
  expect((await pending).isError).not.toBe(true);
  expect(run).toHaveBeenCalledOnce();
});

it('does not require identity merely to run a local wait-only Desktop batch', async () => {
  const run = vi.fn(async () => ok('waited'));
  const result = await dispatch('computer', { actions: [{ type: 'wait', ms: 0 }] }, null, 'wait-only', 'desktop', run);
  expect(result).toEqual(ok('waited'));
  expect(run).toHaveBeenCalledOnce();
});
