export interface DelegationPromptInput {
  task: string;
  acceptanceCriteria: readonly string[];
  plan: readonly string[];
  swarmSuggestions?: readonly string[];
}

export interface ContinuePromptInput {
  sessionId: string;
  task: string;
  acceptanceCriteria: readonly string[];
  plan: readonly string[];
  swarmSuggestions?: readonly string[];
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '- none' : items.map((item) => `- ${item}`).join('\n');
}

export function buildContinuationPrompt(input: ContinuePromptInput): string {
  const swarm =
    input.swarmSuggestions && input.swarmSuggestions.length > 0
      ? list(input.swarmSuggestions)
      : '- Use your judgment; avoid AgentSwarm for small or tightly coupled changes.';

  return `This is a follow-up to a delegated task in session ${input.sessionId}. Codex has reviewed the work and is providing additional feedback.

Implement the requested changes in this repository. Do not change unrelated files.

Feedback:
${input.task}

Acceptance criteria:
${list(input.acceptanceCriteria)}

Plan from Codex:
${list(input.plan)}

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
${swarm}

When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring Codex review
`;
}

export function buildDelegationPrompt(input: DelegationPromptInput): string {
  const swarm =
    input.swarmSuggestions && input.swarmSuggestions.length > 0
      ? list(input.swarmSuggestions)
      : '- Use your judgment; avoid AgentSwarm for small or tightly coupled changes.';

  return `You are the implementation worker. Codex is the coordinator and reviewer.

Implement the requested work in this repository. Do not change unrelated files.

Task:
${input.task}

Acceptance criteria:
${list(input.acceptanceCriteria)}

Plan from Codex:
${list(input.plan)}

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
${swarm}

When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring Codex review
`;
}
