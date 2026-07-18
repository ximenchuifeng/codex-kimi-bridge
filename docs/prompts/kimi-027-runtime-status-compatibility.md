# Kimi 0.27 Runtime Status Compatibility Prompt

Use this prompt in a fresh Codex task to coordinate the compatibility implementation through `kimi-delegate`.

```text
使用 kimi-delegate 实现 Kimi 0.27 runtime status compatibility。

你是主控 Codex，负责 spec/plan/review/verification；具体代码实现全部交给 Kimi。不要由 Codex 手写实现代码。

工作目录：
/Users/ximenchuifeng/Coding/codex-kimi-bridge

已批准 spec：
docs/superpowers/specs/2026-07-18-kimi-027-runtime-status-compatibility-design.md

实施 plan：
docs/superpowers/plans/2026-07-18-kimi-027-runtime-status-compatibility.md

任务标题：
Kimi 0.27 runtime status compatibility

目标：
让 Bridge 同时兼容旧 Kimi Session status 契约和 Kimi 0.27+ 的 busy、pending_interaction、last_turn_reason 契约，并增加明确的 failed 终止状态。

关键验收标准：
1. 所有 lifecycle 工具只基于统一归一化状态作决定。
2. 旧 status 响应继续兼容。
3. Kimi 0.27+ busy/pending_interaction/last_turn_reason 响应正确映射。
4. failed 是明确终止状态，不生成成功 reviewPackage。
5. failed 和 aborted 不被 dedupe 自动复用。
6. recent/find/dedupe 的状态过滤在新旧 server 上一致。
7. approval/question pending 详情保持可用。
8. 未知状态抛出清晰兼容错误，不能被当作 idle。
9. /meta 的 serverVersion/backend 只用于安全诊断，不按版本号分支。
10. 不泄露或提交任何 token。
11. pnpm test、pnpm typecheck、pnpm build、validate_plugin.py 全部通过。

重要 bootstrap 说明：
当前已安装 Bridge 的 wait/status 逻辑正是本次要修复的缺陷。在新 Bridge 构建、重装并重启 Codex 前，不要把旧版 kimi_wait_until_idle 或 kimi_delegate_and_wait 的终止结果当作完成证据。

启动流程：
1. 先调用 kimi_bridge_status，确认 server 可访问。
2. 调用一次 kimi_delegate_task 启动任务，不要在 bootstrap 阶段调用 kimi_delegate_and_wait。
3. task 使用上面的稳定任务标题；swarmMode=false。
4. acceptanceCriteria 使用上述 11 条。
5. plan 参数要求 Kimi 完整读取并逐项执行实施 plan 文件中的 Task 1-6，严格 TDD、按任务提交。
6. 立即向我返回 sessionId 和 webUrl。我会通过 Kimi Web 查看进度。
7. 不要因为旧 wait 返回空状态或异常终止而创建第二个相同 session。
8. 如果 Codex 任务被中断，先按标题查找最近 session，并结合 webUrl、cwd 和消息摘要确认原 session；不要盲目重复 delegate。

Kimi 实施边界：
- 不修改 /Users/ximenchuifeng/Coding/BigWave/kimi-code。
- 不迁移 /api/v2，不引入 @moonshot-ai/klient。
- 不修改 Codex 插件安装机制。
- 不自动回答 approval/question。
- 不做无关重构。
- 不提交、不打印真实 token 或带 token 的 URL。
- 不由 Kimi 重装 Codex 插件；先等待 Codex review。

Kimi 完成后必须返回：
1. sessionId 和 webUrl
2. commits（按顺序）
3. 修改/新增文件列表
4. runtime status 映射摘要
5. pnpm test、pnpm typecheck、pnpm build、插件校验结果
6. 真实 Kimi 0.27 response shape 检查结果，且不包含秘密
7. handoff 和关键 diff 摘要
8. 是否偏离 plan
9. 已知风险和重装后 smoke test 要求
10. 明确确认没有提交或打印 token
11. 等待 Codex 复核

复核流程：
1. 当我确认 Web 中任务已完成后，调用 kimi_review_package；必要时补充 kimi_get_handoff 和 kimi_get_diff。
2. 按 spec、plan 和验收标准逐项复核，不只相信 Kimi 的完成声明。
3. Codex 独立运行四条验证命令。
4. 有问题时只用 kimi_continue_task 给同一个 session 精确反馈，继续由 Kimi 修复。
5. 复核通过后由 Codex 提交尚未提交的 review fixes，执行 pnpm build，并重装 kimi-delegate@codex-kimi-bridge-local。
6. 提醒我重启 Codex。
7. 重启后运行 plan 中 Post-Install Smoke Flow，验证新的 delegate_and_wait、recent sessions、dedupe 和 abort 状态闭环。

不要在 bootstrap 阶段并发启动多个 Kimi session。本任务共享核心类型和工具文件，不开启 swarm。
```

## Suggested `kimi_delegate_task` Shape

```json
{
  "cwd": "/Users/ximenchuifeng/Coding/codex-kimi-bridge",
  "task": "Kimi 0.27 runtime status compatibility",
  "acceptanceCriteria": [
    "Legacy status responses remain compatible",
    "Kimi 0.27 busy, pending_interaction, and last_turn_reason responses normalize correctly",
    "failed is terminal and produces no successful reviewPackage",
    "failed and aborted sessions are never automatically reused by dedupe",
    "recent, find, wait, handoff, review, and dedupe consume normalized status",
    "unknown state shapes fail clearly instead of becoming idle",
    "serverVersion and backend are safe diagnostic-only metadata",
    "no Kimi server, /api/v2, @moonshot-ai/klient, or plugin installation mechanics changes",
    "no token is committed or printed",
    "all local verification commands pass",
    "real Kimi 0.27 response shapes are checked without exposing secrets"
  ],
  "plan": [
    "Read the approved spec and the complete implementation plan before editing",
    "Execute Task 1 through Task 6 in order using TDD and scoped commits",
    "Return the complete handoff required by Task 6 and wait for Codex review"
  ],
  "swarmMode": false
}
```
