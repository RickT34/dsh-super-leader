# Changelog

## 0.6.3

- Document the deployment-side `session-query-sqlite` configuration that enables `session_search` and `session_event_search`, the `openAt` choices, the first-search timeout, and recovery when one damaged stored Session blocks the first index build. Code and preset are unchanged.

## 0.6.2

- Add web search/fetch, read-only Session queries, deliverable presentation, todo tracking, and schedule management tools to the Leader preset.

## 0.6.1

- Show `waiting_for_user_answer` separately from approval in `task_status` and `read_session`, and notify the owning Leader when a tracked worker is still waiting for a user answer. The original question channel still owns the answer.
- Instruct workers in initial and follow-up briefs to avoid interrupting the user with question tools, proceed on reasonable in-scope assumptions, and report assumptions, risks, and genuine blockers.

## 0.6.0

- Route pending tool approvals from tracked workers to their owning Leader by default. That Leader can allow the exact request once or reject it using `answer_approval`. This does not change standing permissions or the Leader's own approval rules.
- Batch approval notices per Leader. When the Leader is unavailable or does not answer before the deadline, the original DSH Web or IM flow takes over. The wait defaults to 30 seconds and accepts 5 to 600 whole seconds. Turn off routing or list exact tool names to keep requests in the normal DSH flow.
- Expose pending approvals in `task_status` and `read_session`. Send an approval-ID notice when the original DSH flow still needs a decision, and summarize approvals in completed task reports.
- Log whether the Leader or the native approval chain delivered the decision. Match the log entry to DSH's recorded result by approval ID; the native chain does not expose an individual responder.
- Document standing model routing rules for workers. The Leader applies those rules when choosing a model and reasoning effort for a dispatch.

### Upgrade note

Worker approval routing is enabled by default. Set `workerApprovalMode: off` to keep all worker approvals in DSH's original flow. The obsolete `autoApproveWorkers` setting has no effect.
