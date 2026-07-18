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
- handoff requirements: a concrete final report plus committed and working-tree change evidence

## Review Loop

1. Prepare or update the spec and implementation plan.
2. Delegate to Kimi.
3. Wait for Kimi to finish or block.
4. Gather handoff and diff.
5. Inspect both `committedChanges` and `workingTreeChanges` in the handoff or review package.
   - A clean working tree does not prove Kimi made no changes; check `committedChanges` for commits and diffs.
   - `workingTreeChanges` may include pre-existing user work listed in `initialDirtyPaths`.
   - `committedChanges.available: false` means evidence is unavailable, not empty; use `unavailableReason` and direct `git log`/`git diff` when needed.
6. Review against acceptance criteria.
7. Send precise follow-up feedback to Kimi if review fails.
8. Independently verify before declaring completion.
