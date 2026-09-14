import type { Capabilities, Capability } from '../shared/types.js';
import { WRITE_CAPABILITIES } from '../shared/types.js';
import {
  WINDOWS_COMPUTER_INPUT_METHODS,
  WINDOWS_COMPUTER_READ_METHODS
} from '../shared/windows-computer.js';

/**
 * Product-wide action vocabulary.
 *
 * Adapters keep their subsystem-specific safety checks (sandboxing, process ownership,
 * browser/native generations, plugin admission) below this layer. This vocabulary answers the
 * cross-surface question those owners cannot answer alone: what effective class of action is
 * being requested, by which proven caller, and which live product permission currently admits
 * it?
 */
export const ACTION_CLASSES = [
  'observe',
  'read-data',
  'write-data',
  'execute-process',
  'launch-application',
  'desktop-interact',
  'clipboard-read',
  'clipboard-write',
  'remote-read',
  'remote-mutate'
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];
export type ActionSourceSurface = 'core' | 'desktop' | 'plugins';

export const ACTION_TARGET_KINDS = [
  'filesystem',
  'process',
  'application',
  'desktop',
  'clipboard',
  'external-integration',
  'application-state'
] as const;

export type ActionTargetKind = (typeof ACTION_TARGET_KINDS)[number];

/** Identity facts proved by the request/call owners, never model-supplied credentials. */
export interface Principal {
  /** Point-in-time identity evidence at policy evaluation; later subsystem proof may strengthen it. */
  readonly conversationId: string | null;
  readonly localSessionId: string | null;
  readonly requestId: string | null;
  readonly runId: string | null;
  readonly agentId: string | null;
}

export interface ActionTarget {
  readonly kind: ActionTargetKind;
}

export interface ActionContext {
  readonly principal: Principal;
  readonly sourceSurface: ActionSourceSurface;
  readonly actionClass: ActionClass;
  readonly target: ActionTarget;
  /** Exact single capability when one exists; composite adapters leave this null. */
  readonly capability: Capability | null;
  /** PR-09 will replace this null placeholder with the durable WorkspaceLease proof. */
  readonly workspaceLease: null;
  readonly operationId: string;
}

export type ActionRequirement =
  | { readonly kind: 'none'; readonly denyInReadOnly?: boolean }
  | { readonly kind: 'capability'; readonly capability: Capability }
  | { readonly kind: 'any-capability'; readonly capabilities: readonly Capability[] };

export const ACTION_POLICY_REASON_CODES = ['allowed', 'read_only', 'capability_disabled'] as const;
export type ActionPolicyReasonCode = (typeof ACTION_POLICY_REASON_CODES)[number];

export interface ActionPolicyDecision {
  readonly effect: 'allow' | 'deny';
  readonly reasonCode: ActionPolicyReasonCode;
  readonly effectiveAuthority: {
    readonly sourceSurface: ActionSourceSurface;
    readonly actionClass: ActionClass;
    readonly target: ActionTargetKind;
    /** How `requiredCapabilities` must be interpreted by diagnostics and later policy consumers. */
    readonly capabilityMode: 'none' | 'single' | 'any';
    readonly requiredCapabilities: readonly Capability[];
  };
  /** Content-free facts suitable for the later diagnostics surface. */
  readonly auditMetadata: {
    readonly operationId: string;
    readonly principal: 'session' | 'conversation' | 'unknown';
  };
}

export interface ActionPolicyState {
  readonly capabilities: Readonly<Capabilities>;
  readonly readOnly: boolean;
}

export interface ActionIntent {
  readonly actionClass: ActionClass;
  readonly target: ActionTargetKind;
}

const CORE_INTENTS: Readonly<Record<string, ActionIntent>> = {
  read: { actionClass: 'read-data', target: 'filesystem' },
  view_image: { actionClass: 'read-data', target: 'filesystem' },
  find: { actionClass: 'read-data', target: 'filesystem' },
  session: { actionClass: 'read-data', target: 'application-state' },
  apply_patch: { actionClass: 'write-data', target: 'filesystem' },
  download_artifact: { actionClass: 'write-data', target: 'filesystem' },
  update_plan: { actionClass: 'write-data', target: 'application-state' },
  agents: { actionClass: 'write-data', target: 'application-state' },
  session_finish: { actionClass: 'write-data', target: 'application-state' },
  exec_command: { actionClass: 'execute-process', target: 'process' },
  write_stdin: { actionClass: 'execute-process', target: 'process' }
};

const WINDOWS_READ = new Set<string>(WINDOWS_COMPUTER_READ_METHODS);
const WINDOWS_INPUT = new Set<string>(WINDOWS_COMPUTER_INPUT_METHODS);

function capabilityIntent(capability: Capability): ActionIntent {
  switch (capability) {
    case 'browse':
    case 'search':
    case 'read':
    case 'metadata':
      return { actionClass: 'read-data', target: 'filesystem' };
    case 'create':
    case 'edit':
    case 'move':
    case 'deleteFile':
    case 'saveArtifact':
      return { actionClass: 'write-data', target: 'filesystem' };
    case 'command':
      return { actionClass: 'execute-process', target: 'process' };
    case 'screen':
      return { actionClass: 'observe', target: 'desktop' };
    case 'control':
      return { actionClass: 'desktop-interact', target: 'desktop' };
    case 'clipboardRead':
      return { actionClass: 'clipboard-read', target: 'clipboard' };
    case 'clipboardWrite':
      return { actionClass: 'clipboard-write', target: 'clipboard' };
  }
}

function requirementCapabilities(requirement: ActionRequirement): readonly Capability[] {
  if (requirement.kind === 'capability') return [requirement.capability];
  if (requirement.kind === 'any-capability') return requirement.capabilities;
  return [];
}

function intentFromRequirements(requirement: ActionRequirement): ActionIntent | null {
  const required = requirementCapabilities(requirement);
  if (required.length === 0) return null;
  const intents = required.map(capabilityIntent);
  const first = intents[0]!;
  return intents.every(intent => intent.actionClass === first.actionClass && intent.target === first.target)
    ? first
    : null;
}

/**
 * One classifier for every adapter that enters the policy seam.
 *
 * Composite adapters use `operation:subeffect` ids while retaining their existing execution
 * logic. The suffix intentionally does not invent another action vocabulary: the live
 * capability requirement below is what maps the subeffect into this central vocabulary.
 */
export function actionIntentFor(
  sourceSurface: ActionSourceSurface,
  operationId: string,
  requirement: ActionRequirement
): ActionIntent {
  if (sourceSurface === 'plugins') {
    // External tool annotations are provider-controlled and cannot be an authorization fact.
    // Until a reviewed typed integration can prove read-only semantics, fail conservative in
    // classification and treat arbitrary plugin calls as remote mutations. This PR does not
    // change plugin admission or read-only behavior.
    return { actionClass: 'remote-mutate', target: 'external-integration' };
  }

  if (sourceSurface === 'core' && operationId === 'download_artifact:remote') {
    return { actionClass: 'remote-read', target: 'external-integration' };
  }

  const [operation, subeffect] = operationId.split(':', 2);
  if (subeffect) {
    const requiredIntent = intentFromRequirements(requirement);
    if (requiredIntent) return requiredIntent;
  }

  if (sourceSurface === 'core') {
    const known = CORE_INTENTS[operation!];
    if (known) return known;
  } else {
    if (operation === 'read_clipboard') return { actionClass: 'clipboard-read', target: 'clipboard' };
    if (operation === 'write_clipboard') return { actionClass: 'clipboard-write', target: 'clipboard' };
    if (operation === 'observe') return { actionClass: 'observe', target: 'desktop' };
    if (operation === 'computer') {
      const requiredIntent = intentFromRequirements(requirement);
      if (requiredIntent) return requiredIntent;
      return { actionClass: 'desktop-interact', target: 'desktop' };
    }
    if (WINDOWS_READ.has(operation!)) return { actionClass: 'observe', target: 'desktop' };
    if (operation === 'launch_app') return { actionClass: 'launch-application', target: 'application' };
    if (WINDOWS_INPUT.has(operation!)) return { actionClass: 'desktop-interact', target: 'desktop' };
  }

  const inferred = intentFromRequirements(requirement);
  if (inferred) return inferred;
  throw new Error(`UNCLASSIFIED_ACTION: ${sourceSurface}:${operationId}`);
}

function authority(context: ActionContext, requirement: ActionRequirement): ActionPolicyDecision['effectiveAuthority'] {
  return {
    sourceSurface: context.sourceSurface,
    actionClass: context.actionClass,
    target: context.target.kind,
    capabilityMode:
      requirement.kind === 'none'
        ? 'none'
        : requirement.kind === 'capability'
          ? 'single'
          : 'any',
    requiredCapabilities: [...requirementCapabilities(requirement)]
  };
}

function audit(context: ActionContext): ActionPolicyDecision['auditMetadata'] {
  return {
    operationId: context.operationId,
    principal: context.principal.localSessionId
      ? 'session'
      : context.principal.conversationId
        ? 'conversation'
        : 'unknown'
  };
}

/** Pure product policy. Subsystem-specific checks remain below this decision. */
export function evaluateActionPolicy(
  context: ActionContext,
  state: ActionPolicyState,
  requirement: ActionRequirement
): ActionPolicyDecision {
  const effectiveAuthority = authority(context, requirement);
  const auditMetadata = audit(context);
  if (requirement.kind === 'none') {
    if (requirement.denyInReadOnly === true && state.readOnly) {
      return { effect: 'deny', reasonCode: 'read_only', effectiveAuthority, auditMetadata };
    }
    return { effect: 'allow', reasonCode: 'allowed', effectiveAuthority, auditMetadata };
  }

  const required = requirementCapabilities(requirement);
  const readOnlyOverride = state.readOnly && required.length > 0 && required.every(capability =>
    WRITE_CAPABILITIES.includes(capability)
  );
  if (readOnlyOverride) {
    return { effect: 'deny', reasonCode: 'read_only', effectiveAuthority, auditMetadata };
  }

  const allowed = requirement.kind === 'capability'
    ? state.capabilities[requirement.capability]
    : required.some(capability => state.capabilities[capability]);
  if (allowed) return { effect: 'allow', reasonCode: 'allowed', effectiveAuthority, auditMetadata };

  return {
    effect: 'deny',
    reasonCode: 'capability_disabled',
    effectiveAuthority,
    auditMetadata
  };
}
