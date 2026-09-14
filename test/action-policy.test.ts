import { describe, expect, it } from 'vitest';
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
  requirement: ActionRequirement
): ActionContext {
  const intent = actionIntentFor(sourceSurface, operationId, requirement);
  return {
    principal,
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
      effectiveAuthority: { sourceSurface: 'core', actionClass: 'execute-process', target: 'process', requiredCapabilities: ['command'] },
      auditMetadata: { operationId: 'exec_command', principal: 'session' }
    });

    const denied = evaluateActionPolicy(action, {
      capabilities: { ...DEFAULT_CAPABILITIES, command: false }, readOnly: false
    }, requirement);
    expect(denied.effect).toBe('deny');
    expect(denied.reasonCode).toBe('capability_disabled');
  });

  it('distinguishes a read-only override from an independently disabled read permission', () => {
    const command = { kind: 'capability', capability: 'command' } as const;
    expect(evaluateActionPolicy(context('core', 'exec_command', command), {
      capabilities: { ...DEFAULT_CAPABILITIES, command: false }, readOnly: true
    }, command).reasonCode).toBe('read_only');

    const observe = { kind: 'capability', capability: 'screen' } as const;
    expect(evaluateActionPolicy(context('desktop', 'get_window_state', observe), {
      capabilities: { ...DEFAULT_CAPABILITIES, screen: false }, readOnly: true
    }, observe).reasonCode).toBe('capability_disabled');
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
});
