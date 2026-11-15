import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalReason, dispatchApprovalText, reconcileTask, reportState, reportNote, requestLocation,
} from '../src/core.js';

const task = { id: 'T-000001', status: 'running', turn: 14, requestId: 'req-1' };
const time = Date.UTC(2026, 10, 15);
const event = (type, data) => ({ type, data, time });
const start = turn => event('turn/start', { turn });
const end = (turn, kind = 'completed') => event('turn/end', { turn, reason: { kind } });
const reply = text => event('assistant/message', { message: { content: [{ type: 'text', text }] } });
const message = { id: 'msg-1', source: { kind: 'user', rpcId: 'req-1' }, content: [{ type: 'text', text: 'Do it' }] };
const insert = event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
const claim = event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });

// These assertions are about the IM-facing contract, independent of displayReason.
test('reason keeps English prefix and one-line target, excluding the brief', () => {
  const place = { kind: 'existing', workspace: { title: '项目\nA', path: '/home/user/Work/app' }, sessionTitle: '实现\r\n功能', sessionRef: 'session-abc', running: true, mode: 'queue' };
  const reason = approvalReason('dispatch_task', place);
  assert.equal(reason, 'Leader action "dispatch_task" requires approval; 工作区：项目 A (/home/user/Work/app); 会话：实现 功能 (session-abc); 状态：排队 (queue)');
  assert.doesNotMatch(reason, /[\r\n\u2028\u2029]/);
  assert.match(approvalReason('dispatch_task', { ...place, mode: 'steer' }), /注入当前轮次 \(steer\)$/);
  assert.match(approvalReason('dispatch_task', { ...place, running: false }), /状态：空闲$/);
  assert.match(approvalReason('dispatch_task', { kind: 'new', workspace: place.workspace }), /会话：新建会话; 状态：新建后开始$/);
  const brief = 'PRIVATE BRIEF ONLY IN DISPLAY REASON';
  assert.ok(dispatchApprovalText({ title: 'T', brief, place }).en.includes(brief));
  assert.ok(!reason.includes(brief));
  assert.equal(approvalReason('cancel_task'), 'Leader action "cancel_task" requires approval');
});

test('reason bounds titles while preserving path and id', () => {
  const reason = approvalReason('dispatch_task', { kind: 'existing', workspace: { title: 'w'.repeat(1000), path: '/w/long-project-path' }, sessionTitle: 's'.repeat(1000), sessionRef: 'session-full-id' });
  assert.ok(reason.length < 300);
  assert.match(reason, /\/w\/long-project-path/);
  assert.match(reason, /session-full-id/);
  assert.match(approvalReason('dispatch_task', { kind: 'new', workspaceRef: 'missing' }), /未找到工作区/);
});

test('reconcile completed historical turn even while same worker runs a newer task', () => {
  const decision = reconcileTask(task, [start(14), reply('Done'), end(14), start(19)], { running: true, lastTurn: 19 });
  assert.equal(decision.action, 'close');
  assert.equal(decision.patch.status, 'completed');
  const repaired = { ...task, ...decision.patch };
  assert.equal(repaired.finishedAt, new Date(time).toISOString());
  assert.equal(repaired.report, 'Done');
  assert.equal(reportState(repaired), 'recovered');
  assert.match(reportNote(repaired), /recovered.*worker session log/);
  assert.deepEqual(reconcileTask(repaired, []), { action: 'skip' });
});

test('reconcile preserves exact running turn; does not equate a busy worker to this task', () => {
  const events = [start(14), reply('Working')];
  assert.deepEqual(reconcileTask(task, events, { running: true, lastTurn: 14 }), { action: 'track-turn', turn: 14 });
  const decision = reconcileTask(task, events, { running: true, lastTurn: 19 });
  assert.equal(decision.patch.status, 'interrupted');
  assert.equal(reportState({ ...task, ...decision.patch }), 'lost');
  assert.match(reportNote({ ...task, ...decision.patch }), /Nothing was re-run/);
});

test('reconcile tracks only actual pending inbox requests, including claims before user/message', () => {
  const queued = { ...task, status: 'queued', turn: undefined };
  assert.deepEqual(reconcileTask(queued, [insert]), { action: 'track-request' });
  assert.deepEqual(requestLocation([insert, start(14), claim], 'req-1'), { turn: 14, pending: false });
  const failed = reconcileTask(queued, [insert, start(14), claim, end(14, 'error')]);
  assert.equal(failed.patch.status, 'failed');
  assert.equal(failed.patch.turn, 14);
  assert.equal(reportState({ ...queued, ...failed.patch }), 'lost');
  assert.equal(reconcileTask(queued, []).patch.reconciled.reason, 'request-not-pending');
  const cancelled = { ...claim, data: { ...claim.data, outcome: 'canceled' } };
  assert.equal(reconcileTask(queued, [insert, cancelled]).patch.status, 'interrupted');
});

test('reconcile handles all terminal reasons and separates final report from tool preambles', () => {
  for (const [kind, expected] of [['completed', 'completed'], ['aborted', 'cancelled'], ['error', 'failed'], ['blocked', 'blocked'], ['interrupted', 'interrupted']]) {
    assert.equal(reconcileTask(task, [start(14), end(14, kind)]).patch.status, expected);
  }
  const events = [start(14), reply('I will inspect it'), event('tool/call', { name: 'read' }), end(14, 'interrupted')];
  const decision = reconcileTask(task, events);
  assert.equal(decision.patch.report, '');
  assert.equal(reportState({ ...task, ...decision.patch }), 'lost');
  const errorEnd = event('turn/end', { turn: 14, reason: { kind: 'error', error: { message: 'provider unavailable' } } });
  assert.match(reconcileTask(task, [start(14), errorEnd]).patch.report, /provider unavailable/);
});

test('unreadable logs defer instead of declaring a possibly running task lost', () => {
  assert.deepEqual(reconcileTask(task, undefined), { action: 'defer' });
  assert.equal(reportState({ ...task, status: 'completed', report: 'saved', reportedAt: 'time' }), 'delivered');
  assert.equal(reportState({ ...task, status: 'completed', report: 'saved' }), 'undelivered');
});


test('steered requests claimed in one batch retain their own task identity', () => {
  const second = { ...message, id: 'msg-2', source: { kind: 'user', rpcId: 'req-2' } };
  const inserted = event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message, second] });
  const claimed = event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 2, inserted: [] });
  const events = [start(14), inserted, claimed, reply('Both done'), end(14)];
  assert.equal(requestLocation(events, 'req-1').turn, 14);
  assert.equal(requestLocation(events, 'req-2').turn, 14);
  const secondTask = { status: 'queued', requestId: 'req-2' };
  assert.equal(reconcileTask(secondTask, events).patch.report, 'Both done');
});

test('recovery does not mislabel interrupted streams or tool-call preambles as final reports', () => {
  const preamble = event('assistant/message', { message: { content: [{ type: 'text', text: 'Will inspect' }, { type: 'tool-call', name: 'read' }] } });
  const interrupted = event('assistant/message', { interrupted: true, message: { content: [{ type: 'text', text: 'Partial answer' }] } });
  assert.equal(reconcileTask(task, [start(14), preamble, end(14)]).patch.report, '');
  assert.equal(reconcileTask(task, [start(14), interrupted, end(14)]).patch.report, '');
});
