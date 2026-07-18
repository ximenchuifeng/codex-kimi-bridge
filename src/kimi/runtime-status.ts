export type BridgeRuntimeStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted'
  | 'failed';

export interface SessionStateFacts {
  status?: unknown;
  busy?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
}

const LEGACY_STATUSES = new Set<BridgeRuntimeStatus>([
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
  'failed',
]);

function unsupported(facts: SessionStateFacts): Error {
  const fields = Object.keys(facts).sort().join(', ') || '(none)';
  return new Error(`Unsupported Kimi session state fields: ${fields}`);
}

export function normalizeRuntimeStatus(facts: SessionStateFacts): BridgeRuntimeStatus {
  if (typeof facts.status === 'string' && LEGACY_STATUSES.has(facts.status as BridgeRuntimeStatus)) {
    return facts.status as BridgeRuntimeStatus;
  }

  if (facts.pending_interaction === 'approval') return 'awaiting_approval';
  if (facts.pending_interaction === 'question') return 'awaiting_question';
  if (facts.pending_interaction !== undefined && facts.pending_interaction !== 'none') {
    throw unsupported(facts);
  }

  if (facts.busy === true) return 'running';
  if (facts.busy !== false) throw unsupported(facts);

  if (facts.last_turn_reason === undefined || facts.last_turn_reason === 'completed') return 'idle';
  if (facts.last_turn_reason === 'cancelled') return 'aborted';
  if (facts.last_turn_reason === 'failed') return 'failed';
  throw unsupported(facts);
}
