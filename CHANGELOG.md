# Changelog

## 0.6.0

- Route pending tool approvals from tracked workers to their owning Leader by default. That Leader can allow the exact request once or reject it using `answer_approval`. This does not change standing permissions or the Leader's own approval rules.
- Batch approval notices per Leader. When the Leader is unavailable or does not answer before the deadline, the original DSH Web or IM flow takes over. The wait defaults to 30 seconds and accepts 5 to 600 whole seconds. Turn off routing or list exact tool names to keep requests in the normal DSH flow.
- Expose pending approvals in `task_status` and `read_session`. Send an approval-ID notice when the original DSH flow still needs a decision, and summarize approvals in completed task reports.
- Log whether the Leader or the native approval chain delivered the decision. Match the log entry to DSH's recorded result by approval ID; the native chain does not expose an individual responder.
- Document standing model routing rules for workers. The Leader applies those rules when choosing a model and reasoning effort for a dispatch.

### Upgrade note

Worker approval routing is enabled by default. Set `workerApprovalMode: off` to keep all worker approvals in DSH's original flow. The obsolete `autoApproveWorkers` setting has no effect.
