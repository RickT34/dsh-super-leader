import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { apply, Config, readConfig } from '../src/host.js';
import { runtime } from '../src/runtime.js';

async function host(t, tasks = {}, overrides = {}, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'leader-host-'));
  const file = join(dir, 'ledger.json');
  await writeFile(file, JSON.stringify({ version: 1, tasks, workspaces: {} }));
  const hooks = new Map();
  const injections = [];
  const disposers = [];
  const sessions = new Map();
  const agents = new Map();
  const receipts = [];
  const logs = [];
  const workspace = { id: 'ws', title: 'Workspace', path: '/w/project', sessionIds: ['worker'] };
  const services = {
    workspaceRegistry: { list: () => [workspace], get: id => id === 'ws' ? workspace : undefined, archivedSessionIds: [] },
    permissionPresets: { current: () => 'workspace-write' },
    agentPresets: { composedPreset: ctx => ctx.preset },
    sessionQuery: { readSession: async id => ({ events: sessions.get(id)?.snapshotEvents() ?? [] }) },
    ...overrides,
  };
  const ctx = {
    logger: { warn() {}, info(message) { logs.push(message); } },
    agents: { withoutInitiator: callback => callback(), get: id => agents.get(id), list: () => [], turnBoundaryOf: session => ({ lastTurn: session.turn }) },
    sessions: { get: id => sessions.get(id), flush: async () => {} },
    tools: { view: () => ({ visible: new Map() }) },
    get: name => services[name],
    on(name, callback) { hooks.set(name, callback); },
    inject(deps, callback) { if (deps.includes('sessionQuery')) injections.push(callback); },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  apply(ctx, { ledgerFile: file, ...config });
  const leader = {
    id: 'leader', ctx: { preset: 'leader' }, status: 'idle', session: { id: 'leader' },
    followup(message) { receipts.push(message); },
  };
  const worker = { id: 'worker', turn: 1, header: { cwd: '/w/project' }, snapshotEvents: () => [] };
  sessions.set('worker', worker);
  agents.set('worker', { id: 'worker', ctx: { preset: 'standard' }, status: 'idle', session: worker });
  services.sessionController ??= {
    async resolveAgent(id) {
      return { agent: id === 'leader' ? leader : agents.get(id) };
    },
    async prompt() { throw new Error('Unexpected prompt: recovery must never replay work'); },
  };
  const readLedger = async () => JSON.parse(await readFile(file, 'utf8'));
  const untilLedger = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const data = await readLedger();
      if (predicate(data)) return data;
      await setImmediate();
    }
    assert.fail('ledger did not reach the expected durable state');
  };
  t.after(async () => { for (const dispose of disposers.reverse()) dispose(); await rm(dir, { recursive: true }); });
  return { ctx, hooks, injections, sessions, agents, services, worker, leader, file, readLedger, untilLedger, receipts, logs, api: runtime.current };
}
const event = (type, data) => ({ type, data, time: 1000 });
const start = turn => event('turn/start', { turn });
const end = turn => event('turn/end', { turn, reason: { kind: 'completed' } });
const reply = text => event('assistant/message', { message: { content: [{ type: 'text', text }] } });
const task = (id, turn = 1) => ({ id, title: id, requestId: `request-${id}`, sessionId: 'worker', leaderSessionId: 'leader', status: 'running', turn, createdAt: '2026-01-01' });

async function workerApproval(t, config = {}, { toolName = 'bash', args, taskOwners = { a: 'leader' }, loadLeader = false } = {}) {
  const tasks = Object.fromEntries(Object.entries(taskOwners).map(([id, leaderSessionId]) => [id, { ...task(id), leaderSessionId }]));
  const h = await host(t, tasks, {}, config);
  if (loadLeader) {
    h.agents.set(h.leader.id, h.leader);
    h.sessions.set(h.leader.session.id, h.leader.session);
  }
  const agent = h.agents.get('worker');
  agent.status = 'running';
  const reason = 'approval fixture reason';
  const asked = event('approval/asked', { id: 'approval-1', callId: 'call-1', toolName, reason });
  const events = [start(1),
    event('user/message', { source: { kind: 'user', rpcId: 'request-a' } }),
    event('user/message', { source: { kind: 'runtime-context' } }),
    event('tool/call', { turn: 1, callId: 'call-1', name: toolName, arguments: args ?? {} }),
    asked,
  ];
  h.worker.snapshotEvents = () => events;
  await h.injections[0]();
  const request = { agent, callId: 'call-1', toolName, reason, signal: new AbortController().signal };
  const ask = (overrides = {}, next = () => 'human-answerer') => h.hooks.get('approval/request')({ ...request, ...overrides }, next);
  const append = entry => { events.push(entry); h.hooks.get('session/event')(h.worker, entry); };
  const decide = (outcome, id = 'approval-1') => append(event('approval/decided', { id, outcome }));
  return { ...h, agent, request, ask, asked, events, append, decide };
}

const leaderApprovalReceipts = h => h.receipts.map(message => message.content[0].text)
  .filter(text => text.startsWith('[Leader approval]'));
const approvalAudits = h => h.logs.filter(line => line.startsWith('super-leader: worker-approval-decision '))
  .map(line => JSON.parse(line.slice('super-leader: worker-approval-decision '.length)));
const fakeApprovalClock = t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
const advanceApprovalClock = async (t, milliseconds) => {
  t.mock.timers.tick(milliseconds);
  await setImmediate();
};

test('default Leader approval delegates immediately when the owner is unloaded', async t => {
  const h = await workerApproval(t);
  const downstream = Promise.resolve('allowed-once');
  assert.equal(h.ask({}, () => downstream), downstream);
  assert.deepEqual(h.logs, []);
});

test('off mode delegates even when the Leader is loaded', async t => {
  const h = await workerApproval(t, { workerApprovalMode: 'off' }, { loadLeader: true });
  assert.equal(await h.ask(), 'human-answerer');
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('default Leader approval accepts a real write request without using the legacy auto-approval flag', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, { autoApproveWorkers: true }, {
    loadLeader: true, toolName: 'write', args: JSON.stringify({ path: '/w/project/test', content: 'hello', sandbox_permissions: 'workspace-write' }),
  });
  const contexts = ['agent-instructions', 'skill-catalog', 'time-context', 'repeat-tool-reminder'];
  h.events.splice(2, 0, ...contexts.map(kind => event('user/message', { source: { kind } })),
    event('user/message', { source: { kind: 'user', rpcId: 'direct-web' } }));
  const native = t.mock.fn(() => 'rejected');
  let settled = false;
  const pending = Promise.resolve(h.ask({}, native)).then(outcome => { settled = true; return outcome; });

  await advanceApprovalClock(t, 249);
  assert.deepEqual(leaderApprovalReceipts(h), []);
  await advanceApprovalClock(t, 1);
  const [batch] = leaderApprovalReceipts(h);
  assert.match(batch ?? '', /approval-1/);
  assert.match(batch, /write/);
  assert.match(batch, /workspace-write/);
  assert.equal(settled, false, 'the legacy flag must not approve the request');
  assert.equal(native.mock.callCount(), 0);
  assert.deepEqual(await h.api.answerApproval({ approvalId: 'approval-1', decision: 'allowed-once', leader: h.leader }), {
    approval_id: 'approval-1', decision: 'allowed-once',
  });
  assert.equal(await pending, 'allowed-once');
  h.decide('allowed-once');
  assert.deepEqual(approvalAudits(h).map(audit => audit.answerer), ['leader']);
});

test('unavailable arguments do not keep a loaded Leader from rejecting a request', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  delete h.events[3].data.arguments;
  const approved = h.ask();
  await advanceApprovalClock(t, 250);
  assert.match(leaderApprovalReceipts(h)[0] ?? '', /approval-1/);
  await h.api.answerApproval({ approvalId: 'approval-1', decision: 'rejected', leader: h.leader });
  assert.equal(await approved, 'rejected');
});

test('manual exclusions match exact tool names and update without remounting', async t => {
  fakeApprovalClock(t);
  let manualTools = ['bash'];
  const h = await workerApproval(t, { workerManualApprovalTools: { get: () => manualTools } }, { loadLeader: true });
  assert.equal(await h.ask(), 'human-answerer');
  manualTools = ['bash_other'];
  const pending = h.ask();
  await advanceApprovalClock(t, 250);
  assert.match(leaderApprovalReceipts(h)[0] ?? '', /approval-1/);
  await h.api.answerApproval({ approvalId: 'approval-1', decision: 'rejected', leader: h.leader });
  assert.equal(await pending, 'rejected');
});

test('a Leader-preset session never reroutes its own request even if a worker task still tracks it', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  h.agent.ctx.preset = 'leader';
  assert.equal(await h.ask(), 'human-answerer');
  await advanceApprovalClock(t, 250);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('a foreign agent object cannot reuse a tracked worker session', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  assert.equal(await h.ask({ agent: { ...h.agent } }), 'human-answerer');
  await advanceApprovalClock(t, 250);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('the same worker in a later unowned turn stays on the native channel', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  h.worker.turn = 2;
  h.events.splice(0, h.events.length, start(2), h.asked);
  assert.equal(await h.ask(), 'human-answerer');
  await advanceApprovalClock(t, 250);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('different Leader owners in the same worker turn make attribution ambiguous', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true, taskOwners: { a: 'leader', b: 'other-leader' } });
  assert.equal(await h.ask(), 'human-answerer');
  await advanceApprovalClock(t, 250);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('another Leader cannot answer, and accepted approval IDs cannot be reused', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const outsider = { id: 'other-leader', ctx: { preset: 'leader' }, status: 'idle', session: { id: 'other-leader' } };
  h.agents.set(outsider.id, outsider);
  const pending = h.ask();
  await advanceApprovalClock(t, 250);
  assert.match(leaderApprovalReceipts(h)[0] ?? '', /approval-1/);
  const answer = leader => h.api.answerApproval({ approvalId: 'approval-1', decision: 'allowed-once', leader });
  await assert.rejects(async () => answer(outsider), { code: 'approval_not_available' });
  await answer(h.leader);
  assert.equal(await pending, 'allowed-once');
  await assert.rejects(async () => answer(h.leader), { code: 'approval_not_available' });
});

test('duplicates neither reroute the pending ID nor cancel its original decision', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const first = h.ask();
  const second = Promise.resolve(h.ask());
  await advanceApprovalClock(t, 250);
  const receipts = leaderApprovalReceipts(h);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].match(/\bapproval-1\b/g)?.length, 1);
  await h.api.answerApproval({ approvalId: 'approval-1', decision: 'rejected', leader: h.leader });
  assert.equal(await first, 'rejected');
  await second;
  h.decide('rejected');
  assert.deepEqual(approvalAudits(h).map(audit => audit.answerer), ['leader']);
});

function addApproval(h, index, signal) {
  const callId = `call-${index}`;
  h.events.push(event('tool/call', { turn: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' }),
    event('approval/asked', { id: `approval-${index}`, callId, toolName: h.request.toolName, reason: h.request.reason }));
  return h.ask({ callId, signal });
}

const approvalIdsIn = text => [...new Set(text?.match(/\bapproval-\d+\b/g) ?? [])];

test('no more than eight approvals per Leader can wait; overflow delegates immediately', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const pending = new AbortController();
  const first = h.ask({ signal: pending.signal });
  try {
    for (let i = 2; i <= 8; i++) addApproval(h, i, pending.signal);
    assert.equal(await addApproval(h, 9, pending.signal), 'human-answerer');
    await advanceApprovalClock(t, 250);
    const [batch] = leaderApprovalReceipts(h);
    assert.deepEqual(approvalIdsIn(batch).sort(), ['approval-1', 'approval-2', 'approval-3', 'approval-4', 'approval-5', 'approval-6', 'approval-7', 'approval-8']);
  } finally {
    pending.abort();
  }
  assert.equal(await first, 'cancelled');
});

test('a second approval batch cannot be sent to the same Leader for three seconds', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const signal = new AbortController();
  const first = h.ask();
  await advanceApprovalClock(t, 250);
  assert.deepEqual(approvalIdsIn(leaderApprovalReceipts(h)[0]), ['approval-1']);
  await h.api.answerApproval({ approvalId: 'approval-1', decision: 'rejected', leader: h.leader });
  assert.equal(await first, 'rejected');

  const second = addApproval(h, 2, signal.signal);
  try {
    await advanceApprovalClock(t, 2999);
    assert.equal(leaderApprovalReceipts(h).length, 1);
    await advanceApprovalClock(t, 1);
    assert.deepEqual(approvalIdsIn(leaderApprovalReceipts(h)[1]), ['approval-2']);
  } finally {
    signal.abort();
  }
  assert.equal(await second, 'cancelled');
});

test('after thirty seconds an unanswered request delegates once and preserves the native outcome', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const downstream = Promise.withResolvers();
  const next = t.mock.fn(() => downstream.promise);
  const pending = h.ask({}, next);
  await advanceApprovalClock(t, 250);
  assert.match(leaderApprovalReceipts(h)[0] ?? '', /approval-1/);
  await advanceApprovalClock(t, 29_749);
  assert.equal(next.mock.callCount(), 0);
  await advanceApprovalClock(t, 1);
  assert.equal(next.mock.callCount(), 1);
  downstream.resolve('allowed-once');
  assert.equal(await pending, 'allowed-once');
  h.decide('allowed-once');
  assert.deepEqual(approvalAudits(h).map(audit => audit.answerer), ['native']);
  await assert.rejects(async () => h.api.answerApproval({ approvalId: 'approval-1', decision: 'rejected', leader: h.leader }), { code: 'approval_not_available' });
});

test('approval timeout configuration accepts only whole seconds from 5 to 600', () => {
  const key = 'workerApprovalTimeoutSeconds';
  assert.equal(readConfig(Config({}), key), 30);
  assert.equal(readConfig(Config({ [key]: 5 }), key), 5);
  assert.equal(readConfig(Config({ [key]: 600 }), key), 600);
  assert.throws(() => Config({ [key]: 4 }));
  assert.throws(() => Config({ [key]: 601 }));
  assert.throws(() => Config({ [key]: 5.5 }));
});

test('changing the approval timeout applies to new requests without moving an existing deadline', async t => {
  fakeApprovalClock(t);
  let seconds = 15;
  const h = await workerApproval(t, { workerApprovalTimeoutSeconds: { get: () => seconds } }, { loadLeader: true });
  const nextFirst = t.mock.fn(() => 'rejected');
  const first = h.ask({}, nextFirst);
  await advanceApprovalClock(t, 250);
  assert.ok(leaderApprovalReceipts(h)[0]?.includes(new Date(1_015_000).toISOString()));

  seconds = 5;
  const second = addApproval(h, 2, h.request.signal);
  await advanceApprovalClock(t, 3000);
  assert.ok(leaderApprovalReceipts(h)[1]?.includes(new Date(1_005_250).toISOString()));
  await advanceApprovalClock(t, 2000);
  assert.equal(await second, 'human-answerer');
  await advanceApprovalClock(t, 9749);
  assert.equal(nextFirst.mock.callCount(), 0);
  await advanceApprovalClock(t, 1);
  assert.equal(await first, 'rejected');
});

test('the original approval is advertised on the native channel only after Leader timeout', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true, toolName: 'write' });
  h.events.pop();
  h.append(h.asked);
  const native = Promise.withResolvers();
  const next = t.mock.fn(() => native.promise);
  const pending = h.ask({}, next);
  const progress = () => h.receipts.map(message => message.content[0].text).filter(text => text.startsWith('[Leader progress]'));

  await advanceApprovalClock(t, 250);
  assert.deepEqual(approvalIdsIn(leaderApprovalReceipts(h)[0]), ['approval-1']);
  await advanceApprovalClock(t, 1250);
  assert.deepEqual(progress(), [], 'an approval owned by Leader must not be advertised as native');
  await advanceApprovalClock(t, 28_500);
  assert.equal(next.mock.callCount(), 1);
  await advanceApprovalClock(t, 1499);
  assert.deepEqual(progress(), []);
  await advanceApprovalClock(t, 1);
  assert.equal(progress().length, 1);
  assert.match(progress()[0], /waiting for approval/);
  assert.match(progress()[0], /approval-1/);
  assert.match(progress()[0], /write/);

  native.resolve('allowed-once');
  assert.equal(await pending, 'allowed-once');
  h.decide('allowed-once');
  const [audit] = approvalAudits(h);
  assert.equal(audit?.approval_id, 'approval-1');
  assert.equal(audit?.tool, 'write');
  assert.equal(audit?.outcome, 'allowed-once');
  assert.equal(audit?.answerer, 'native');
});

test('a routing exception preserves the downstream promise', async t => {
  const h = await workerApproval(t, {}, { loadLeader: true });
  h.worker.snapshotEvents = () => { throw new Error('unreadable journal'); };
  const downstream = Promise.resolve('rejected');
  assert.equal(h.ask({}, () => downstream), downstream);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('worker cancellation retires its pending request without invoking the native answerer', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const controller = new AbortController();
  const next = t.mock.fn(() => 'rejected');
  const pending = h.ask({ signal: controller.signal }, next);
  controller.abort();
  assert.equal(await pending, 'cancelled');
  await advanceApprovalClock(t, 30_000);
  assert.equal(next.mock.callCount(), 0);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('already cancelled requests do not invoke the native channel or the Leader', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const next = t.mock.fn(() => 'rejected');
  assert.equal(await h.ask({ signal: AbortSignal.abort() }, next), 'cancelled');
  await advanceApprovalClock(t, 250);
  assert.equal(next.mock.callCount(), 0);
  assert.deepEqual(leaderApprovalReceipts(h), []);
});

test('Leader unload delegates a pending request without waiting for its timeout', async t => {
  fakeApprovalClock(t);
  const h = await workerApproval(t, {}, { loadLeader: true });
  const next = t.mock.fn(async () => 'rejected');
  const pending = h.ask({}, next);
  await advanceApprovalClock(t, 250);
  assert.match(leaderApprovalReceipts(h)[0] ?? '', /approval-1/);
  h.agents.delete(h.leader.id);
  h.hooks.get('agent/disposed')({ agent: h.leader });
  await setImmediate();
  assert.equal(next.mock.callCount(), 1);
  assert.equal(await pending, 'rejected');
});

test('canonical decisions are logged as native even if the approval hook was not reached', async t => {
  const h = await workerApproval(t, { workerApprovalMode: 'off' });
  h.hooks.get('session/event')(h.worker, h.asked);
  h.decide('rejected');
  assert.deepEqual(approvalAudits(h).map(audit => audit.answerer), ['native']);
});

test('task and session queries distinguish live Web approval, no approval and an unreadable state', async t => {
  const h = await workerApproval(t);
  h.events.pop(); // exercise the session.state path without a synthetic journal pair
  h.services.sessionController.state = async () => ({ pendingInput: ['approval'] });
  assert.equal((await h.api.taskStatus({ taskId: 'a', leader: h.leader })).task.waiting_for_approval, true);
  assert.equal((await h.api.readSession({ sessionId: 'worker', leader: h.leader })).session.waiting_for_approval, true);
  h.services.sessionController.state = async () => ({ pendingInput: ['question'] });
  assert.equal((await h.api.taskStatus({ leader: h.leader })).tasks[0].waiting_for_approval, false);
  h.services.sessionController.state = async () => { throw new Error('unavailable'); };
  assert.equal((await h.api.taskStatus({ taskId: 'a', leader: h.leader })).task.waiting_for_approval, null);
});

test('an active IM-only audit pair sends one approval progress report and the final report records the decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await workerApproval(t);
  h.services.sessionController.state = async () => ({ pendingInput: [] });
  h.hooks.get('session/event')(h.worker, h.asked);
  t.mock.timers.tick(1500);
  await setImmediate();
  assert.match(h.receipts[0]?.content[0].text ?? '', /^\[Leader progress\].*waiting for approval/);
  assert.equal((await h.readLedger()).tasks.a.status, 'running');
  h.append(event('approval/decided', { id: 'approval-1', outcome: 'rejected' }));
  h.append(event('approval/asked', { id: 'approval-2', toolName: 'edit', callId: 'call-2' }));
  t.mock.timers.tick(1500);
  await setImmediate();
  assert.equal(h.receipts.length, 1);
  h.append(event('approval/decided', { id: 'approval-2', outcome: 'allowed-once' }));
  h.append(reply('Work stopped after the rejection.'));
  h.append(end(1));
  const ledger = await h.untilLedger(data => data.tasks.a.reportedAt);
  assert.deepEqual(ledger.tasks.a.approvalSummary, { asked: 2, allowed: 1, rejected: 1, unavailable: 0, cancelled: 0 });
  assert.match(h.receipts[1].content[0].text, /2 requested, 1 allowed, 1 rejected/);
});

test('a settled approval does not send a stale progress report', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await workerApproval(t);
  h.services.sessionController.state = async () => ({ pendingInput: [] });
  h.hooks.get('session/event')(h.worker, h.asked);
  h.append(event('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }));
  t.mock.timers.tick(1500);
  await setImmediate();
  assert.deepEqual(h.receipts, []);
});

test('approval gate enriches reason but preserves displayReason and downstream denials', async t => {
  const h = await host(t);
  h.worker.snapshotEvents = () => [event('session/title', { title: 'Build app' })];
  h.agents.get('worker').status = 'running';
  const exec = { agent: h.leader, name: 'dispatch_task', arguments: { session_id: 'worker', title: 'More work', brief: 'Do this confidential task', mode: 'queue' } };
  const gate = h.hooks.get('tools/pre-execute');
  const decision = await gate(exec, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /^Leader action "dispatch_task" requires approval;/);
  assert.match(decision.reason, /Workspace \(\/w\/project\)/);
  assert.match(decision.reason, /Build app \(worker\)/);
  assert.match(decision.reason, /排队 \(queue\)/);
  assert.doesNotMatch(decision.reason, /confidential|\n/);
  assert.match(decision.displayReason.en, /\nWorkspace: Workspace \(\/w\/project\)\nSession: Build app \(worker\)/);
  assert.ok(decision.displayReason.en.endsWith('\n\nDo this confidential task'));
  assert.deepEqual(await gate(exec, async () => ({ kind: 'deny', reason: 'blocked elsewhere' })), { kind: 'deny', reason: 'blocked elsewhere' });
  h.services.permissionPresets.current = () => 'danger-full-access';
  assert.deepEqual(await gate(exec, async () => ({ kind: 'allow' })), { kind: 'allow' });
});

test('startup reconciles old turn while worker runs a later turn, exposing recovered report', async t => {
  const h = await host(t, { old: task('old') });
  h.worker.turn = 20;
  h.worker.snapshotEvents = () => [start(1), reply('Old task done'), end(1), start(20)];
  h.agents.get('worker').status = 'running';
  await h.injections[0]();
  assert.equal((await h.readLedger()).tasks.old.status, 'completed');
  assert.equal(h.receipts.length, 0);
  const result = await h.api.taskStatus({ taskId: 'old', leader: h.leader });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.report_state, 'recovered');
  assert.equal(result.task.report_missing, true);
  assert.equal(result.task.report, 'Old task done');
  const data = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(data.tasks.old.reportedAt, undefined); // no delivery or replay on recovery
});

test('recovery reattaches all tasks consumed in one turn and handles its end exactly once', async t => {
  const h = await host(t, { a: task('a'), b: task('b') });
  const events = [start(1)];
  h.worker.snapshotEvents = () => events;
  h.agents.get('worker').status = 'running';
  await h.injections[0]();
  events.push(reply('Both done'), end(1));
  h.agents.get('worker').status = 'idle';
  h.hooks.get('session/event')(h.worker, events.at(-1));
  const data = await h.untilLedger(data => data.tasks.a.reportedAt && data.tasks.b.reportedAt);
  assert.equal(data.tasks.a.report, 'Both done');
  assert.equal(data.tasks.b.report, 'Both done');
  assert.equal(h.receipts.length, 2);
  h.hooks.get('session/event')(h.worker, events.at(-1)); // repeated notification
  await setImmediate();
  assert.equal(h.receipts.length, 2);
});

test('reconciliation samples newly loaded live log after asynchronous stored-log read', async t => {
  const h = await host(t, { a: task('a') });
  h.sessions.delete('worker');
  h.agents.delete('worker');
  h.services.sessionQuery.readSession = async () => {
    const stale = [start(1)];
    h.worker.snapshotEvents = () => [start(1), reply('Finished during read'), end(1)];
    h.sessions.set('worker', h.worker);
    h.agents.set('worker', { status: 'idle', session: h.worker });
    return { events: stale };
  };
  await h.injections[0]();
  assert.equal((await h.readLedger()).tasks.a.report, 'Finished during read');
  const result = await h.api.taskStatus({ taskId: 'a', leader: h.leader });
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.report_state, 'recovered');
  assert.equal(result.task.report, 'Finished during read');
});


test('a status query cannot close a task whose prompt admission is still in flight', async t => {
  const h = await host(t);
  const admitted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const events = [];
  h.worker.snapshotEvents = () => events;
  h.services.sessionController.prompt = async request => {
    admitted.resolve();
    await release.promise;
    const input = event('user/message', { source: { kind: 'user', rpcId: request.requestId } });
    events.push(start(1), input);
    h.agents.get('worker').status = 'running';
    h.hooks.get('session/event')(h.worker, input);
  };
  const dispatched = h.api.dispatch({ leader: h.leader, sessionId: 'worker', title: 'New task', brief: 'Do it', mode: 'queue' });
  await admitted.promise;
  const pending = await h.api.taskStatus({ leader: h.leader });
  assert.equal(pending.tasks[0].status, 'queued');
  assert.equal(pending.tasks[0].report_missing, false);
  release.resolve();
  const result = await dispatched;
  events.push(reply('Done after admission'), end(1));
  h.agents.get('worker').status = 'idle';
  h.hooks.get('session/event')(h.worker, events.at(-1));
  const data = await h.untilLedger(data => data.tasks[result.task_id]?.reportedAt);
  assert.equal(data.tasks[result.task_id].status, 'completed');
  assert.equal(h.receipts.length, 1);
});

test('transient reads retry, while a confirmed missing worker closes visibly as lost', async t => {
  const h = await host(t, { a: task('a') });
  h.sessions.delete('worker');
  h.agents.delete('worker');
  h.services.sessionQuery.readSession = async () => { throw new Error('temporary IO error'); };
  await h.injections[0]();
  const deferred = (await h.readLedger()).tasks.a;
  assert.equal(deferred.status, 'running');
  assert.match(deferred.reconciliationError, /unreadable/);
  h.services.sessionQuery.readSession = async () => { throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); };
  const result = await h.api.taskStatus({ taskId: 'a', leader: h.leader });
  assert.equal(result.task.status, 'interrupted');
  assert.equal(result.task.report_state, 'lost');
  assert.equal(result.task.report_missing, true);
  assert.equal(result.task.reconciled.reason, 'worker-session-missing');
  assert.equal(h.receipts.length, 0);
});


test('global tools from any memory plugin require explicit allowTools entries', async t => {
  let allowTools = ['explicit_extra'];
  const h = await host(t, {}, {}, { allowTools: { get: () => allowTools } });
  const names = ['mnemon_runtime_memory', 'mnemon_document_search', 'mnemon_recall', 'other_memory_read', 'other_memory_write', 'bash', 'explicit_extra'];
  h.ctx.tools.view = () => ({ visible: new Map(names.map(name => [name, {}])) });
  h.ctx.agents.list = () => [h.leader];
  const layers = new Set();
  const denied = name => [...layers].some(layer => layer.has(name));
  h.leader.ctx.tools = { restrict({ deny }) {
    const layer = new Set(deny);
    layers.add(layer);
    h.hooks.get('tools/change')(); // real DSH publishes synchronously
    return () => {
      layers.delete(layer);
      h.hooks.get('tools/change')();
    };
  } };
  h.hooks.get('agent/created')({ agent: h.leader });
  assert.deepEqual(names.filter(name => !denied(name)), ['explicit_extra']);
  names.push('late_memory_search');
  h.hooks.get('tools/change')();
  assert.ok(denied('late_memory_search'));
  allowTools = ['explicit_extra', 'mnemon_runtime_memory', 'other_memory_read'];
  h.hooks.get('agent/pre-step')({ agent: h.leader }, () => {});
  assert.deepEqual(names.filter(name => !denied(name)), ['mnemon_runtime_memory', 'other_memory_read', 'explicit_extra']);
  assert.equal(layers.size, 1);
  allowTools = ['explicit_extra'];
  h.hooks.get('agent/pre-step')({ agent: h.leader }, () => {});
  assert.deepEqual(names.filter(name => !denied(name)), ['explicit_extra']);
  assert.equal(layers.size, 1);
  allowTools = ['explicit_extra', 'mnemon_runtime_memory', 'other_memory_read'];
  h.hooks.get('agent/pre-step')({ agent: h.leader }, () => {});
  assert.deepEqual(names.filter(name => !denied(name)), ['mnemon_runtime_memory', 'other_memory_read', 'explicit_extra']);
  assert.equal(layers.size, 1);
});
