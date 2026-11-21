/** Never match by call id across turn boundaries. */
export function currentTurnEvents(events, turn) {
  const start = events.findLastIndex(event => event.type === 'turn/start');
  if (start < 0 || events[start].data?.turn !== turn) return [];
  const current = events.slice(start + 1);
  return current.some(event => event.type === 'turn/end') ? [] : current;
}

export function pendingApprovals(events) {
  const pending = new Map();
  for (const { type, data } of events) {
    if (typeof data?.id !== 'string' || !data.id) continue;
    if (type === 'approval/asked') pending.set(data.id, data);
    if (type === 'approval/decided') pending.delete(data.id);
  }
  return pending;
}

const MAX_ARGUMENT_TEXT = 512 * 1024;

/** DSH allocates the real approval id in the journal before calling the answerers. */
export function approvalDetails(request, events) {
  const { toolName, callId, reason } = request;
  if (typeof toolName !== 'string' || !toolName) return;
  const asks = [...pendingApprovals(events).values()].filter(ask =>
    ask.callId === callId && ask.toolName === toolName && ask.reason === reason);
  if (asks.length !== 1) return;
  const calls = callId ? events.filter(({ type, data }) => (type === 'tool/call' && data?.callId === callId)
    || (type === 'tool/ptc-dispatch-start' && data?.subCallId === callId)) : [];
  const raw = calls.length === 1 && calls[0].data.name === toolName ? calls[0].data.arguments : undefined;
  let args = raw;
  if (typeof raw === 'string') {
    try { args = raw.length <= MAX_ARGUMENT_TEXT ? JSON.parse(raw) : undefined; }
    catch { args = undefined; }
  }
  if (args == null || typeof args !== 'object' || Array.isArray(args)) args = undefined;
  return { approval_id: asks[0].id, call_id: callId, tool: toolName, argument_summary: args === undefined ? null : summarizeArguments(args) };
}

function summarizeArguments(args) {
  const argumentSummary = {
    fields: Object.keys(args).length,
    known_fields: Object.fromEntries(
      ['command', 'path', 'file_path', 'content', 'old_string', 'new_string', 'patch', 'patchText', 'justification']
        .filter(key => Object.hasOwn(args, key) && typeof args[key] === 'string')
        .map(key => [key, { chars: args[key].length }]),
    ),
  };
  if (['read-only', 'workspace-write', 'danger-full-access'].includes(args.sandbox_permissions)) {
    argumentSummary.sandbox_permissions = args.sandbox_permissions;
  }
  return argumentSummary;
}

/** Turn-local history for reports, separate from the live pending indicator. */
export function approvalSummary(events) {
  const summary = { asked: 0, allowed: 0, rejected: 0, unavailable: 0, cancelled: 0 };
  const opened = new Set();
  for (const { type, data } of events) {
    if (typeof data?.id !== 'string' || !data.id) continue;
    if (type === 'approval/asked' && !opened.has(data.id)) {
      opened.add(data.id);
      summary.asked++;
    } else if (type === 'approval/decided' && opened.delete(data.id)) {
      if (data.outcome === 'allowed-once') summary.allowed++;
      else if (['rejected', 'unavailable', 'cancelled'].includes(data.outcome)) summary[data.outcome]++;
    }
  }
  return summary.asked ? summary : undefined;
}

export function approvalSummaryText(summary) {
  if (!summary?.asked) return undefined;
  const { asked, allowed, rejected, unavailable, cancelled } = summary;
  const unresolved = asked - allowed - rejected - unavailable - cancelled;
  return `Worker approvals this turn: ${asked} requested, ${allowed} allowed, ${rejected} rejected, ${unavailable} unavailable, ${cancelled} cancelled${unresolved ? `, ${unresolved} without a recorded decision` : ''}.`;
}
