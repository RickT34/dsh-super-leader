export const APPROVAL_BATCH_MS = 250;
export const APPROVAL_RATE_MS = 3000;
const MAX_PER_LEADER = 8;

/** Own only the Leader leg of the waterfall. undefined delegates the request unchanged. */
export function createApprovalRelay({ canAnswer, deliver, onDecision, onFallback }) {
  const pending = new Map();
  const queues = new Map();

  function eligible(entry) {
    try { return !entry.signal?.aborted && Date.now() < entry.expiresAt && canAnswer(entry); }
    catch { return false; }
  }

  function settle(entry, outcome) {
    if (pending.get(entry.id) !== entry) return;
    pending.delete(entry.id);
    if (entry.signal?.aborted) outcome = 'cancelled';
    const queue = entry.queue;
    queue.entries.delete(entry);
    if (!queue.entries.size && !queue.timer && queue.nextAt <= Date.now()) queues.delete(queue.ownerId);
    clearTimeout(entry.deadline);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.completion.resolve(outcome);
    if (outcome === undefined) onFallback(entry);
  }

  function schedule(queue) {
    if (queue.timer) return;
    queue.timer = setTimeout(() => {
      queue.timer = undefined;
      const entries = [...queue.entries].filter(entry => !entry.delivered);
      for (const entry of entries) {
        if (!eligible(entry)) settle(entry, undefined);
      }
      const batch = entries.filter(entry => pending.has(entry.id));
      if (batch.length) {
        queue.nextAt = Date.now() + APPROVAL_RATE_MS;
        try {
          deliver(batch);
          for (const entry of batch) entry.delivered = true;
        } catch {
          for (const entry of batch) settle(entry, undefined);
        }
        schedule(queue);
      } else if (!queue.entries.size) {
        queues.delete(queue.ownerId);
      }
    }, Math.max(APPROVAL_BATCH_MS, queue.nextAt - Date.now()));
    queue.timer.unref?.();
  }

  return {
    offer(details, signal, timeoutMs) {
      if (signal?.aborted || pending.has(details.id)) return undefined;
      let queue = queues.get(details.ownerId);
      if (!queue) {
        queue = { ownerId: details.ownerId, entries: new Set(), nextAt: 0 };
        queues.set(details.ownerId, queue);
      }
      if (queue.entries.size >= MAX_PER_LEADER) return undefined;
      const completion = Promise.withResolvers();
      const entry = { ...details, queue, signal, completion, delivered: false, expiresAt: Date.now() + timeoutMs };
      entry.abort = () => settle(entry, 'cancelled');
      entry.deadline = setTimeout(() => settle(entry, undefined), timeoutMs);
      entry.deadline.unref?.();
      pending.set(entry.id, entry);
      queue.entries.add(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      schedule(queue);
      return completion.promise;
    },
    answer(id, owner, outcome) {
      const entry = pending.get(id);
      if (!entry || !entry.delivered || entry.owner !== owner) return false;
      if (!eligible(entry)) {
        settle(entry, undefined);
        return false;
      }
      onDecision(entry, outcome);
      settle(entry, outcome);
      return true;
    },
    has(id) { return pending.has(id); },
    release(predicate) {
      for (const entry of pending.values()) if (predicate(entry)) settle(entry, undefined);
    },
    dispose() {
      for (const entry of pending.values()) settle(entry, undefined);
      for (const queue of queues.values()) clearTimeout(queue.timer);
      queues.clear();
    },
  };
}
