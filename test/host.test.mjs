import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { apply } from '../src/host.js';
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
  const workspace = { id: 'ws', title: 'Workspace', path: '/w/project', sessionIds: ['worker'] };
  const services = {
    workspaceRegistry: { list: () => [workspace], get: id => id === 'ws' ? workspace : undefined, archivedSessionIds: [] },
    permissionPresets: { current: () => 'workspace-write' },
    agentPresets: { composedPreset: ctx => ctx.preset },
    sessionQuery: { readSession: async id => ({ events: sessions.get(id)?.snapshotEvents() ?? [] }) },
    ...overrides,
  };
  const ctx = {
    logger: { warn() {}, info() {} },
    agents: { withoutInitiator: callback => callback(), get: id => agents.get(id), list: () => [], turnBoundaryOf: session => ({ lastTurn: session.turn }) },
    sessions: { get: id => sessions.get(id), flush: async () => {} },
    tools: { view: () => ({ visible: new Map() }) },
    get: name => services[name],
    on(name, callback) { hooks.set(name, callback); },
    inject(deps, callback) { if (deps.includes('sessionQuery')) injections.push(callback); },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  apply(ctx, { ledgerFile: file, ...config });
  const leader = { id: 'leader', ctx: { preset: 'leader' }, session: {} };
  const worker = { id: 'worker', turn: 1, header: { cwd: '/w/project' }, snapshotEvents: () => [] };
  sessions.set('worker', worker);
  agents.set('worker', { id: 'worker', ctx: { preset: 'standard' }, status: 'idle', session: worker });
  services.sessionController ??= {
    async resolveAgent(id) {
      return { agent: id === 'leader' ? { session: {}, followup(message) { receipts.push(message); } } : agents.get(id) };
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
  return { ctx, hooks, injections, sessions, agents, services, worker, leader, file, readLedger, untilLedger, receipts, api: runtime.current };
}
const event = (type, data) => ({ type, data, time: 1000 });
const start = turn => event('turn/start', { turn });
const end = turn => event('turn/end', { turn, reason: { kind: 'completed' } });
const reply = text => event('assistant/message', { message: { content: [{ type: 'text', text }] } });
const task = (id, turn = 1) => ({ id, title: id, requestId: `request-${id}`, sessionId: 'worker', leaderSessionId: 'leader', status: 'running', turn, createdAt: '2026-01-01' });

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
