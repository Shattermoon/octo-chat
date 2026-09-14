import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const broker = vi.hoisted(() => ({
  offer: vi.fn(), ack: vi.fn(), bareOffer: vi.fn(), bareAck: vi.fn(), release: vi.fn(), alive: vi.fn(), record: vi.fn(),
  inputAck: vi.fn(async (): Promise<void> => undefined), outputAck: vi.fn(async (): Promise<void> => undefined),
  allowUnattributed: false, retiredLease: false
}));
vi.mock('../src/main/agents.js', async (original) => ({
  ...await original<typeof import('../src/main/agents.js')>(),
  agentForCaller: () => 'worker-1', agentForFinishCaller: () => 'worker-1',
  offerMessagesForConversation: broker.offer, acknowledgeOffersForConversation: broker.ack,
  offerMessages: broker.bareOffer, acknowledgeOffers: broker.bareAck,
  currentRunId: (conversationId?: string) => conversationId ? `run-${conversationId}` : null,
  releaseQuiescentRun: broker.release,
  noteAgentAlive: broker.alive,
  hasRetiredWorkerLeases: () => broker.retiredLease
}));
vi.mock('../src/main/session/recorder.js', async (original) => ({
  ...await original<typeof import('../src/main/session/recorder.js')>(),
  freshCallOrigin: (_tool: string, _at: number, request: string | null) => request?.startsWith('req-') ? request.slice(4) : null,
  awaitFreshCallOrigin: async () => null,
  recordToolCall: async () => null, recordAgentMessage: broker.record
}));
vi.mock('../src/main/session/store.js', async (original) => ({
  ...await original<typeof import('../src/main/session/store.js')>(), conversationAttachment: async () => 'current'
}));
vi.mock('../src/main/session/input.js', () => ({
  offerToolInput: async () => ({ messages: [], reminder: '' }),
  acknowledgeToolInput: broker.inputAck,
  TOOL_INPUT_HEADER: '\n--- New instructions from the user ---\n'
}));
vi.mock('../src/main/codex/ownership.js', async (original) => ({
  ...await original<typeof import('../src/main/codex/ownership.js')>(),
  acknowledgeBackgroundExecOutput: broker.outputAck
}));
vi.mock('../src/main/config.js', async (original) => {
  const mod = await original<typeof import('../src/main/config.js')>();
  return {
    ...mod,
    getConfig: () => {
      const config = mod.defaultConfig();
      config.multiAgent.allowUnattributedCalls = broker.allowUnattributed;
      return config;
    }
  };
});
import { createRegistrar, dispatch, ok } from '../src/main/mcp/kernel.js';
import { currentCall } from '../src/main/mcp/call-context.js';
import { withInboundRequestId } from '../src/main/mcp/inbound.js';
import { defaultConfig } from '../src/main/config.js';
beforeEach(() => {
  vi.clearAllMocks();
  broker.alive.mockReturnValue(null);
  broker.offer.mockImplementation((conversationId) => conversationId ? { agentId: 'worker-1', messages: [{ id: `m-${conversationId}`, from: 'prime', text: `private-${conversationId}`, offers: 1 }] } : null);
  broker.ack.mockReturnValue(null);
  broker.bareOffer.mockReturnValue([{ id: 'foreign', from: 'prime', text: 'foreign-private', offers: 1 }]);
  broker.inputAck.mockReset();
  broker.inputAck.mockResolvedValue(undefined);
  broker.outputAck.mockReset();
  broker.outputAck.mockResolvedValue(undefined);
  broker.allowUnattributed = false;
  broker.retiredLease = false;
});
it('records same-named worker liveness reports under the exact author conversation', async () => {
  broker.alive.mockImplementation((conversationId) => ({ report: { id: `report-${conversationId}`, from: 'worker-1', to: 'prime', text: 'active again' } }));
  const call = handler();
  await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-a' }), 'sent', 'chat-a');
  expect(broker.record).toHaveBeenCalledWith(expect.objectContaining({ id: 'report-chat-b' }), 'sent', 'chat-b');
});
function handler() {
  let call!: (args: object) => Promise<{ content: Array<{ text?: string }> }>;
  const server = { registerTool: (_name: string, _schema: unknown, callback: typeof call) => { call = callback; } };
  const registrar = createRegistrar(server as never, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'test real dispatch', inputSchema: z.object({}) }, async () => ok('result'));
  return (requestId: string | null) => withInboundRequestId(requestId, () => call({}));
}
it('routes identical friendly workers through their exact conversation inbox and run cleanup', async () => {
  const call = handler();
  const [a, b] = await Promise.all([call('req-chat-a'), call('req-chat-b')]);
  expect(JSON.stringify(a)).toContain('private-chat-a'); expect(JSON.stringify(a)).not.toContain('private-chat-b');
  expect(JSON.stringify(b)).toContain('private-chat-b'); expect(JSON.stringify(b)).not.toContain('private-chat-a');
  expect(JSON.stringify(a)).toContain('• prime: private-chat-a');
  expect(JSON.stringify(a)).not.toContain('m-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-a');
  expect(broker.release).toHaveBeenCalledWith({}, 'run-chat-b');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
});
it('does not fall back to a friendly-id inbox when exact conversation ownership abstains', async () => {
  const result = await handler()(null);
  expect(JSON.stringify(result)).not.toContain('foreign-private');
  expect(broker.bareOffer).not.toHaveBeenCalled(); expect(broker.bareAck).not.toHaveBeenCalled();
  expect(broker.release).not.toHaveBeenCalled();
});

it('offers and acknowledges the worker inbox only on the outer call, outside nested filtering', async () => {
  const registrar = createRegistrar(null, { roots: [], caps: defaultConfig().capabilities, readOnly: true }, 'core');
  registrar.register('read', { description: 'fixture', inputSchema: z.object({}) }, async () => ok('private tool value'));
  const result = await dispatch('exec', {}, null, 'req-chat-a', 'core', async () => {
    const parent = currentCall()!;
    const children = await Promise.all([registrar.invokeNested('read', {}, parent), registrar.invokeNested('read', {}, parent)]);
    expect(children).toEqual([ok('private tool value'), ok('private tool value')]);
    expect(broker.offer).not.toHaveBeenCalled();
    expect(broker.ack).not.toHaveBeenCalled();
    return ok('filtered');
  });
  expect(broker.offer).toHaveBeenCalledTimes(1);
  expect(broker.ack).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).toContain('private-chat-a');
  expect(JSON.stringify(result)).not.toContain('private tool value');
});

it.each([
  { initial: true, next: false, denied: true },
  { initial: false, next: true, denied: false }
])('reads unattributed permission after a held input acknowledgement ($initial → $next)', async ({ initial, next, denied }) => {
  broker.retiredLease = true;
  broker.allowUnattributed = initial;
  let releaseAck!: () => void;
  broker.inputAck.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseAck = resolve; }));
  const run = vi.fn(async () => ok('executed'));
  const pending = dispatch('read', {}, null, `wfr-held-ack-${String(initial)}-${String(next)}`, 'core', run);

  await vi.waitFor(() => expect(broker.inputAck).toHaveBeenCalledTimes(1));
  broker.allowUnattributed = next;
  releaseAck();

  const result = await pending;
  const text = JSON.stringify(result);
  if (denied) {
    expect(text).toContain('CALLER_IDENTITY_REQUIRED');
    expect(run).not.toHaveBeenCalled();
  } else {
    expect(text).not.toContain('CALLER_IDENTITY_REQUIRED');
    expect(run).toHaveBeenCalledOnce();
  }
});

it.each([
  { beforeOutputAck: true, final: false, denied: true },
  { beforeOutputAck: false, final: true, denied: false }
])(
  'reads unattributed permission after the final background-output acknowledgement ($beforeOutputAck → $final)',
  async ({ beforeOutputAck, final, denied }) => {
    broker.retiredLease = true;
    broker.allowUnattributed = beforeOutputAck;
    let releaseOutputAck!: () => void;
    broker.outputAck.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOutputAck = resolve; }));
    const run = vi.fn(async () => ok('executed'));
    const pending = dispatch('read', {}, null, `wfr-held-output-ack-${String(final)}`, 'core', run);

    await vi.waitFor(() => expect(broker.outputAck).toHaveBeenCalledTimes(1));
    broker.allowUnattributed = final;
    releaseOutputAck();

    const result = await pending;
    const text = JSON.stringify(result);
    if (denied) {
      expect(text).toContain('CALLER_IDENTITY_REQUIRED');
      expect(run).not.toHaveBeenCalled();
    } else {
      expect(text).not.toContain('CALLER_IDENTITY_REQUIRED');
      expect(run).toHaveBeenCalledOnce();
    }
  }
);
