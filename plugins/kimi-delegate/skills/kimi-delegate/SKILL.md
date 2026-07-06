---
name: kimi-delegate
description: Use when Codex should coordinate a software task but delegate implementation execution to Kimi Code.
---

# Kimi Delegate

Use this skill when the user wants Codex to act as planner, reviewer, and coordinator while Kimi Code performs implementation.

## Rules

- Codex owns spec, plan, review, verification, and final completion decisions.
- Kimi owns implementation execution.
- Do not implement code directly in Codex when the user has asked for Kimi execution.
- Use `kimi_delegate_task` to send implementation tasks to Kimi.
- Use `kimi_get_handoff` and `kimi_get_diff` before reviewing Kimi's work.
- Use `kimi_continue_task` for review feedback until acceptance criteria pass.
- Enable swarm mode only when the task has independent work items.
- Do not auto-approve destructive commands.

## Delegation Prompt

Every task sent to Kimi must include:

- task
- acceptance criteria
- Codex plan
- swarm split suggestion when useful
- handoff requirements

## Review Loop

1. Prepare or update the spec and implementation plan.
2. Delegate to Kimi.
3. Wait for Kimi to finish or block.
4. Gather handoff and diff.
5. Review against acceptance criteria.
6. Send precise follow-up feedback to Kimi if review fails.
7. Independently verify before declaring completion.
