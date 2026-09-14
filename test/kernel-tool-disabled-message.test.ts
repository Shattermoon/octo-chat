import { expect, it, vi } from 'vitest';
import { createRegistrar, ok } from '../src/main/mcp/kernel.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import type { ActionContext, ActionPolicyDecision } from '../src/main/action-policy.js';
import { DEFAULT_CAPABILITIES, WRITE_CAPABILITIES, type Capability } from '../src/shared/types.js';

function registrar(
  readOnly: boolean,
  enabled: Partial<Record<Capability, boolean>> = {},
  onActionPolicyDecision?: (decision: ActionPolicyDecision, action: ActionContext) => void
) {
  return createRegistrar(null, {
    roots: [], readOnly, caps: { ...DEFAULT_CAPABILITIES, ...enabled },
    sessionTools: false, agentTools: false, onActionPolicyDecision
  }, 'core');
}

it('projects the proven caller into the shared Core process policy seam', async () => {
  const observed: Array<{ decision: ActionPolicyDecision; action: ActionContext }> = [];
  const tools = registrar(false, { command: true }, (decision, action) => observed.push({ decision, action }));
  const call: CallContext = {
    startedAt: Date.now(), transportKey: null, agent: 'prime',
    caller: { transportKey: null, requestId: 'request-policy', conversationId: 'conversation-policy', sessionId: 'session-policy' },
    outcome: null, evidence: emptyEvidence()
  };
  const result = await runInCallContext(call, () =>
    tools.guarded('command', 'exec_command', async () => ok('ran'))
  );
  expect(result).toEqual(ok('ran'));
  expect(observed).toHaveLength(1);
  expect(observed[0]!.decision).toMatchObject({ effect: 'allow', reasonCode: 'allowed' });
  expect(observed[0]!.action).toMatchObject({
    sourceSurface: 'core', actionClass: 'execute-process', target: { kind: 'process' }, capability: 'command',
    principal: {
      conversationId: 'conversation-policy', localSessionId: 'session-policy', requestId: 'request-policy', agentId: 'prime'
    }
  });
});

it('keeps the authorization decision authoritative when an observer mutates its snapshot', async () => {
  let observed: ActionPolicyDecision | null = null;
  const tools = registrar(false, { screen: false }, (decision) => {
    observed = decision;
    const mutable = decision as unknown as {
      effect: 'allow' | 'deny';
      reasonCode: string;
      effectiveAuthority: { requiredCapabilities: Capability[] };
    };
    mutable.effect = 'allow';
    mutable.reasonCode = 'allowed';
    mutable.effectiveAuthority.requiredCapabilities.push('read');
  });

  const decision = tools.authorize('observe', { kind: 'capability', capability: 'screen' });
  expect(observed).toMatchObject({ effect: 'allow', reasonCode: 'allowed' });
  expect(decision).toMatchObject({ effect: 'deny', reasonCode: 'capability_disabled' });
  expect(decision.effectiveAuthority.requiredCapabilities).toEqual(['screen']);

  const action = vi.fn(async () => ok('unexpected'));
  const result = await tools.guarded('screen', 'observe', action);
  expect(result.isError).toBe(true);
  expect(action).not.toHaveBeenCalled();
});

it('names the actual Settings permission when a capability is revoked', async () => {
  const tools = registrar(false, { screen: true });
  const action = vi.fn(async () => ok('observed'));
  expect(await tools.guarded('screen', 'observe', action)).toEqual(ok('observed'));
  tools.caps.screen = false;
  action.mockClear();
  const result = await tools.guarded('screen', 'observe', action);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('enable \\"See the screen\\"');
  expect(action).not.toHaveBeenCalled();
});

it.each(WRITE_CAPABILITIES)('explains the Read-only override for %s without running it', async cap => {
  const action = vi.fn(async () => ok('changed'));
  const result = await registrar(true, { [cap]: false }).guarded(cap, 'mutation', action);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('Read-only mode is on');
  expect(JSON.stringify(result)).toContain('turn Read-only off');
  expect(action).not.toHaveBeenCalled();
});

it('does not blame Read-only for a disabled read permission or block an allowed read', async () => {
  const tools = registrar(true, { screen: false, read: true });
  const blocked = await tools.guarded('screen', 'observe', async () => ok('unexpected'));
  expect(JSON.stringify(blocked)).toContain('See the screen');
  expect(JSON.stringify(blocked)).not.toContain('Read-only');
  expect(await tools.guarded('read', 'read', async () => ok('contents'))).toEqual(ok('contents'));
});
