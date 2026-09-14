import { describe, expect, it, vi } from 'vitest';
import {
  actionIntentFor,
  evaluateActionPolicy,
  type ActionContext,
  type ActionRequirement,
  type Principal
} from '../src/main/action-policy.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';

const principal: Principal = {
  conversationId: 'conversation-1',
  localSessionId: 'session-1',
  requestId: 'request-1',
  runId: null,
  agentId: null
};

function context(
  sourceSurface: ActionContext['sourceSurface'],
  operationId: string,
  requirement: ActionRequirement,
  owner: Principal = principal
): ActionContext {
  const intent = actionIntentFor(sourceSurface, operationId, requirement);
  return {
    principal: owner,
    sourceSurface,
    actionClass: intent.actionClass,
    target: { kind: intent.target },
    capability: requirement.kind === 'capability' ? requirement.capability : null,
    workspaceLease: null,
    operationId
  };
}

describe('central action policy', () => {
  it('owns one cross-surface action vocabulary including conservative external mutations', () => {
    expect(actionIntentFor('core', 'exec_command', { kind: 'capability', capability: 'command' }))
      .toEqual({ actionClass: 'execute-process', target: 'process' });
    expect(actionIntentFor('desktop', 'launch_app', { kind: 'capability', capability: 'control' }))
      .toEqual({ actionClass: 'launch-application', target: 'application' });
    expect(actionIntentFor('desktop', 'write_clipboard', { kind: 'capability', capability: 'clipboardWrite' }))
      .toEqual({ actionClass: 'clipboard-write', target: 'clipboard' });
    expect(actionIntentFor('core', 'session', { kind: 'none' }))
      .toEqual({ actionClass: 'read-data', target: 'application-state' });
    expect(actionIntentFor('core', 'update_plan', { kind: 'none' }))
      .toEqual({ actionClass: 'write-data', target: 'application-state' });
    expect(actionIntentFor('core', 'agents', { kind: 'none' }))
      .toEqual({ actionClass: 'write-data', target: 'application-state' });
    expect(actionIntentFor('core', 'session_finish', { kind: 'none' }))
      .toEqual({ actionClass: 'write-data', target: 'application-state' });
    expect(actionIntentFor('core', 'download_artifact:remote', { kind: 'none' }))
      .toEqual({ actionClass: 'remote-read', target: 'external-integration' });
    // Upstream plugin annotations are not an authorization fact; arbitrary dynamic tools remain
    // conservative until a reviewed typed integration can prove a read-only contract.
    expect(actionIntentFor('plugins', 'provider_read_like_name', { kind: 'none' }))
      .toEqual({ actionClass: 'remote-mutate', target: 'external-integration' });
  });

  it('returns structured allow and capability-denial reasons without replacing lower safety owners', () => {
    const requirement = { kind: 'capability', capability: 'command' } as const;
    const action = context('core', 'exec_command', requirement);
    const allowed = evaluateActionPolicy(action, {
      capabilities: { ...DEFAULT_CAPABILITIES, command: true }, readOnly: false
    }, requirement);
    expect(allowed).toMatchObject({
      effect: 'allow', reasonCode: 'allowed',
      effectiveAuthority: {
        sourceSurface: 'core',
        actionClass: 'execute-process',
        target: 'process',
        capabilityMode: 'single',
        requiredCapabilities: ['command']
      },
      auditMetadata: { operationId: 'exec_command', principal: 'session' }
    });

    const denied = evaluateActionPolicy(action, {
      capabilities: { ...DEFAULT_CAPABILITIES, command: false }, readOnly: false
    }, requirement);
    expect(denied.effect).toBe('deny');
    expect(denied.reasonCode).toBe('capability_disabled');
  });

  it('records any-capability authority as alternatives rather than an ambiguous capability list', () => {
    const requirement = {
      kind: 'any-capability',
      capabilities: ['read', 'browse', 'metadata']
    } as const;
    const action = context('core', 'read', requirement);
    const decision = evaluateActionPolicy(action, {
      capabilities: { ...DEFAULT_CAPABILITIES, read: false, browse: true, metadata: false },
      readOnly: false
    }, requirement);

    expect(decision).toMatchObject({
      effect: 'allow',
      reasonCode: 'allowed',
      effectiveAuthority: {
        capabilityMode: 'any',
        requiredCapabilities: ['read', 'browse', 'metadata']
      }
    });
  });

  it('distinguishes a read-only override from an independently disabled read permission', () => {
    const command = { kind: 'capability', capability: 'command' } as const;
    expect(evaluateActionPolicy(context('core', 'exec_command', command), {
      capabilities: { ...DEFAULT_CAPABILITIES, command: true }, readOnly: true
    }, command).reasonCode).toBe('read_only');

    const observe = { kind: 'capability', capability: 'screen' } as const;
    expect(evaluateActionPolicy(context('desktop', 'get_window_state', observe), {
      capabilities: { ...DEFAULT_CAPABILITIES, screen: false }, readOnly: true
    }, observe).reasonCode).toBe('capability_disabled');
  });

  it('requires an exact Principal for sensitive Desktop actions while leaving ordinary observation unchanged', () => {
    const unknown: Principal = {
      conversationId: null,
      localSessionId: null,
      requestId: 'request-without-page-proof',
      runId: null,
      agentId: null
    };
    const cases = [
      ['launch_app', 'control'],
      ['press_key', 'control'],
      ['write_clipboard', 'clipboardWrite'],
      ['read_clipboard', 'clipboardRead']
    ] as const;

    for (const [operationId, capability] of cases) {
      const requirement = { kind: 'capability', capability } as const;
      const action = context('desktop', operationId, requirement, unknown);
      const denied = evaluateActionPolicy(action, {
        capabilities: { ...DEFAULT_CAPABILITIES, [capability]: true },
        readOnly: false
      }, requirement);
      expect(denied).toMatchObject({ effect: 'deny', reasonCode: 'caller_identity_required' });

      expect(evaluateActionPolicy(context('desktop', operationId, requirement), {
        capabilities: { ...DEFAULT_CAPABILITIES, [capability]: true },
        readOnly: false
      }, requirement)).toMatchObject({ effect: 'allow', reasonCode: 'allowed' });
    }

    const observe = { kind: 'capability', capability: 'screen' } as const;
    expect(evaluateActionPolicy(context('desktop', 'get_window_state', observe, unknown), {
      capabilities: { ...DEFAULT_CAPABILITIES, screen: true },
      readOnly: false
    }, observe)).toMatchObject({ effect: 'allow', reasonCode: 'allowed' });
  });

  it('is the live gate used by the registered Core exec_command adapter', async () => {
    const observed: Array<{ decision: import('../src/main/action-policy.js').ActionPolicyDecision; action: ActionContext }> = [];
    const ctx = {
      roots: [],
      readOnly: false,
      caps: { ...DEFAULT_CAPABILITIES, command: false },
      exposedCaps: { ...DEFAULT_CAPABILITIES, command: true },
      sessionTools: false,
      agentTools: false,
      exposedSessionTools: false,
      exposedAgentTools: false,
      exposedFinishTool: false,
      onActionPolicyDecision: (decision: import('../src/main/action-policy.js').ActionPolicyDecision, action: ActionContext) =>
        observed.push({ decision, action })
    };
    const registrar = createRegistrar(null, ctx, 'core');
    let execCommand: ((input: any) => Promise<ToolResult>) | null = null;
    registrar.register = (name, _config, handler) => {
      if (name === 'exec_command') execCommand = handler;
    };
    registerCoreTools(registrar);
    expect(execCommand).not.toBeNull();

    const result = await execCommand!({ cmd: 'this command must never start' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('TOOL_DISABLED');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      decision: { effect: 'deny', reasonCode: 'capability_disabled' },
      action: { sourceSurface: 'core', actionClass: 'execute-process', target: { kind: 'process' }, capability: 'command' }
    });
  });

  it('routes Core application-state adapters through policy before their existing feature gates', async () => {
    const observed: ActionContext[] = [];
    const ctx = {
      roots: [],
      readOnly: false,
      caps: { ...DEFAULT_CAPABILITIES },
      exposedCaps: { ...DEFAULT_CAPABILITIES },
      sessionTools: false,
      agentTools: false,
      exposedSessionTools: true,
      exposedAgentTools: true,
      exposedFinishTool: false,
      onActionPolicyDecision: (_decision: import('../src/main/action-policy.js').ActionPolicyDecision, action: ActionContext) =>
        observed.push(action)
    };
    const registrar = createRegistrar(null, ctx, 'core');
    const handlers = new Map<string, (input: any) => Promise<ToolResult>>();
    registrar.register = (name, _config, handler) => handlers.set(name, handler);
    registerCoreTools(registrar);

    await handlers.get('session')!({ action: 'search' });
    await handlers.get('update_plan')!({ plan: [] });
    await handlers.get('agents')!({ action: 'status' });

    expect(observed.map(action => ({ operationId: action.operationId, actionClass: action.actionClass, target: action.target.kind })))
      .toEqual([
        { operationId: 'session', actionClass: 'read-data', target: 'application-state' },
        { operationId: 'update_plan', actionClass: 'write-data', target: 'application-state' },
        { operationId: 'agents', actionClass: 'write-data', target: 'application-state' }
      ]);
  });

  it('stops an application-state handler when the central policy denies it', async () => {
    const ctx = {
      roots: [],
      readOnly: false,
      caps: { ...DEFAULT_CAPABILITIES },
      exposedCaps: { ...DEFAULT_CAPABILITIES },
      sessionTools: false,
      agentTools: false,
      exposedSessionTools: true,
      exposedAgentTools: false,
      exposedFinishTool: false
    };
    const registrar = createRegistrar(null, ctx, 'core');
    const featureDisabled = vi.fn(registrar.featureDisabled);
    registrar.featureDisabled = featureDisabled;
    registrar.authorize = () => ({
      effect: 'deny',
      reasonCode: 'capability_disabled',
      effectiveAuthority: {
        sourceSurface: 'core',
        actionClass: 'read-data',
        target: 'application-state',
        capabilityMode: 'none',
        requiredCapabilities: []
      },
      auditMetadata: { operationId: 'session', principal: 'unknown' }
    });
    let session: ((input: any) => Promise<ToolResult>) | null = null;
    registrar.register = (name, _config, handler) => {
      if (name === 'session') session = handler;
    };
    registerCoreTools(registrar);

    const result = await session!({ action: 'search' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('denied by the current Octo Chat policy');
    expect(featureDisabled).not.toHaveBeenCalled();
  });

  it('re-evaluates registrar authorization from live context after a handler await', async () => {
    const initial = {
      roots: [],
      readOnly: false,
      caps: { ...DEFAULT_CAPABILITIES, control: true },
      exposedCaps: { ...DEFAULT_CAPABILITIES, control: true }
    };
    let live = { ...initial, caps: { ...initial.caps }, exposedCaps: { ...initial.exposedCaps } };
    const registrar = createRegistrar(null, initial, 'desktop', undefined, () => live);
    const call: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: {
        transportKey: null,
        requestId: 'request-live-policy',
        conversationId: 'conversation-live-policy',
        sessionId: 'session-live-policy'
      },
      outcome: null,
      evidence: emptyEvidence()
    };

    await runInCallContext(call, async () => {
      expect(registrar.authorize('computer:desktop', { kind: 'capability', capability: 'control' }))
        .toMatchObject({ effect: 'allow', reasonCode: 'allowed' });
      live = { ...live, readOnly: true };
      expect(registrar.authorize('computer:desktop', { kind: 'capability', capability: 'control' }))
        .toMatchObject({ effect: 'deny', reasonCode: 'read_only' });
      live = { ...live, readOnly: false, caps: { ...live.caps, control: false } };
      expect(registrar.authorize('computer:desktop', { kind: 'capability', capability: 'control' }))
        .toMatchObject({ effect: 'deny', reasonCode: 'capability_disabled' });
    });
  });
});
