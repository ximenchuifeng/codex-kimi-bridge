# Kimi Delegate Workflow Prompts

Use these prompts when the user wants Codex to coordinate work while Kimi Code performs implementation.

## User To Codex

Use this short prompt for normal work:

```text
用 kimi-delegate 实现这个需求：<需求内容>
Codex 负责 spec/plan/review，Kimi 负责实现。通过后提交并重装插件。
```

Use this fuller prompt when the task is important or needs strict boundaries:

```text
使用 kimi-delegate 开发这个需求。

你是主控 Codex，负责：
1. 理解需求
2. 生成 spec / plan / acceptance criteria
3. 调用 kimi_delegate_and_wait 委托 Kimi 实现
4. 使用返回的 reviewPackage 复核 Kimi 的改动
5. 独立运行验证命令
6. 如果不通过，用 kimi_continue_task 让 Kimi 修复
7. 通过后提交代码并重装插件

重要边界：
- 具体代码实现交给 Kimi，Codex 不要手写实现代码
- Codex 可以写 spec、plan、review feedback、提交代码、重装插件
- 不要改 Kimi server，除非我明确要求
- 不要改 Codex 插件安装机制，除非我明确要求
- 不要泄露 token
- 不要跳过验证

需求：
<这里写你的需求>

验收标准：
<这里写你希望最终满足什么>

完成后告诉我：
1. Kimi sessionId / webUrl
2. 修改文件列表
3. reviewPackage 摘要
4. 验证结果
5. commit hash
6. 是否需要我重启 Codex
```

## Codex To Kimi

Codex should shape delegated work like this:

```text
你是 Kimi Code，负责具体实现。Codex 是主控和 reviewer。

任务：
<具体任务>

验收标准：
1. <标准 1>
2. <标准 2>
3. <标准 3>

实现计划：
1. 先读相关文件
2. 先补测试
3. 再实现最小改动
4. 更新 README/文档
5. 跑完整验证

边界：
- 不要改 Kimi server
- 不要改 Codex 插件安装机制
- 不要提交真实 token
- 不要做无关重构

完成后返回：
1. 修改文件列表
2. 测试结果
3. 关键行为摘要
4. 关键 diff 摘要
5. 是否偏离 plan
6. 已知风险 / 后续建议
7. 等待 Codex 复核
```

## Preferred Tool Flow

1. Call `kimi_bridge_status` when diagnosing readiness.
2. If a previous delegate was interrupted, or you suspect a duplicate/running session, prefer passing `dedupe` to `kimi_delegate_and_wait` with a stable `titleContains` substring and the default `reuseIfStatus`.
3. If you suspect an `aborted` session, call `kimi_find_recent_session` or `kimi_recent_sessions`, inspect the `webUrl`, and use `kimi_continue_task` to resume it. `kimi_delegate_and_wait` will never automatically reuse an aborted session.
4. If you need more control for other cases, call `kimi_find_recent_session` (search by title) or `kimi_recent_sessions` first and inspect `status`, `title`, and `webUrl` before delegating again.
5. Call `kimi_delegate_and_wait` for normal implementation work.
6. If `wait.status` is `idle`, review the embedded `reviewPackage`.
7. If `wait.status` is `timeout`, keep `sessionId` and call `kimi_wait_until_idle` later.
8. If blocked on approval or question, resolve it in Kimi Web and continue the same session.
9. Use `kimi_continue_task` for Codex review feedback.
10. Run local verification before accepting work.

## Dedupe guard template

When calling `kimi_delegate_and_wait`, include a stable `titleContains` substring so the bridge can detect and reuse an existing session after an interruption or quota recovery:

```json
{
  "cwd": "<workspace>",
  "task": "<short task title used as the session title>",
  "acceptanceCriteria": ["..."],
  "plan": ["..."],
  "dedupe": {
    "titleContains": "<unique stable substring from the task title>",
    "status": "<optional status filter>",
    "pageSize": 20,
    "reuseIfStatus": ["running", "idle", "awaiting_approval", "awaiting_question"],
    "includeSummary": true
  }
}
```

Guidelines:

- Pick a `titleContains` value that is stable across retries but specific enough to avoid matching unrelated sessions.
- Omit `dedupe` for one-off exploratory tasks where duplicates are not a concern.
- When `dedupe` returns an existing session, follow `suggestedNextActions` instead of immediately calling `kimi_delegate_task` again.
- `dedupe` only reuses `running`, `idle`, `awaiting_approval`, and `awaiting_question` sessions. For `aborted` sessions, inspect the `webUrl` and use `kimi_continue_task`.
- By default, `dedupe` only reuses sessions whose `metadata.cwd` matches the `cwd` you pass in. This prevents accidentally reusing a session from a different project or workspace. Only add `matchAnyCwd: true` when you intentionally want to recover a session from another workspace; for daily use, leave it out.
- Add `includeSummary: true` when recovering from an interruption or deciding whether to reuse an old session; it returns the last user/assistant message and message count for the matched session and any skipped candidates. Leave it out for normal calls to avoid the extra message fetch.
