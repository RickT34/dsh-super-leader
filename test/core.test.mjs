import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger, isInside, newTaskId, planWorkspaceDirectory, resolveRoot, statusForTurnEnd,
  truncate, textOf, workerBrief, leaderReport, TASK_ID_PATTERN, REPORT_PREFIX,
} from '../src/core.js';

const notRegistered = async () => false;

test('isInside', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
  assert.equal(isInside('/a/b', '/a/b/../c'), false);
});

test('task ids are short, well-formed and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newTaskId(seen);
    assert.match(id, TASK_ID_PATTERN);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
});

test('resolveRoot expands ~ and only accepts configured roots', () => {
  assert.equal(resolveRoot(['~/Work'], undefined, '/home/u'), '/home/u/Work');
  assert.equal(resolveRoot(['~/Work', '/srv/p'], '/srv/p', '/home/u'), '/srv/p');
  assert.throws(() => resolveRoot(['~/Work'], '/etc', '/home/u'), { code: 'root_not_allowed' });
  assert.throws(() => resolveRoot([], undefined, '/home/u'), { code: 'no_roots' });
});

test('planWorkspaceDirectory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'leader-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'leader-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true }), rm(outside, { recursive: true })]));

  for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(65), 'sp ace']) {
    await assert.rejects(planWorkspaceDirectory({ root, name: bad, isRegistered: notRegistered }), { code: 'invalid_name' });
  }
  assert.deepEqual(await planWorkspaceDirectory({ root, name: 'new-proj', isRegistered: notRegistered }), { path: join(root, 'new-proj'), action: 'create' });

  await mkdir(join(root, 'empty'));
  assert.equal((await planWorkspaceDirectory({ root, name: 'empty', isRegistered: notRegistered })).action, 'register');

  await mkdir(join(root, 'full'));
  await writeFile(join(root, 'full', 'f.txt'), 'x');
  await assert.rejects(planWorkspaceDirectory({ root, name: 'full', isRegistered: notRegistered }), { code: 'directory_not_empty' });
  assert.equal((await planWorkspaceDirectory({ root, name: 'full', registerExisting: true, isRegistered: notRegistered })).action, 'register');
  assert.equal((await planWorkspaceDirectory({ root, name: 'full', isRegistered: async () => true })).action, 'exists-registered');

  await writeFile(join(root, 'file'), 'x');
  await assert.rejects(planWorkspaceDirectory({ root, name: 'file', isRegistered: notRegistered }), { code: 'not_directory' });

  await symlink(outside, join(root, 'escape'));
  await assert.rejects(planWorkspaceDirectory({ root, name: 'escape', isRegistered: notRegistered }), { code: 'outside_root' });
});

test('ledger persists tasks and notes atomically', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'leader-ledger-'));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, 'nested', 'ledger.json');
  const ledger = await new Ledger(file).load();
  await ledger.putTask({ id: 'T-000001', title: 'a', status: 'queued', createdAt: '1' });
  await Promise.all([
    ledger.updateTask('T-000001', { status: 'running' }),
    ledger.setWorkspaceNote('/w', { purpose: 'p' }),
  ]);
  assert.equal(await ledger.updateTask('T-missing', { status: 'x' }), undefined);
  const again = await new Ledger(file).load();
  assert.equal(again.task('T-000001').status, 'running');
  assert.equal(again.workspaceNote('/w').purpose, 'p');
});

test('statusForTurnEnd', () => {
  assert.equal(statusForTurnEnd('completed'), 'completed');
  assert.equal(statusForTurnEnd('aborted'), 'cancelled');
  assert.equal(statusForTurnEnd('error'), 'failed');
  assert.equal(statusForTurnEnd('blocked'), 'blocked');
  assert.equal(statusForTurnEnd(undefined), 'finished');
});

test('truncate keeps head and tail within budget', () => {
  assert.equal(truncate('short', 100), 'short');
  const long = 'a'.repeat(5000) + 'TAIL';
  const out = truncate(long, 1000);
  assert.ok(out.length <= 1100);
  assert.ok(out.startsWith('aaa'));
  assert.ok(out.endsWith('TAIL'));
  assert.match(out, /characters omitted/);
});

test('textOf joins text blocks only', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'tool-call', name: 'x' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textOf(undefined), '');
});

test('messages carry the ids and the report contract', () => {
  const brief = workerBrief({ taskId: 'T-abcdef', title: 'Fix', brief: ' do it ', leaderSessionId: 'session-L' });
  assert.match(brief, /^# Task T-abcdef: Fix/);
  assert.match(brief, /## Report/);
  assert.match(brief, /session-L/);
  const report = leaderReport({ task: { id: 'T-abcdef', title: 'Fix', sessionId: 'session-W', workspacePath: '/w' }, status: 'completed', report: '' });
  assert.ok(report.startsWith(REPORT_PREFIX));
  assert.match(report, /without a text reply/);
});

import { sessionDigest, lastRequestOf, stripBriefFooter, touchedFiles } from '../src/core.js';

let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: Date.UTC(2026, 10, 14, 10, 0, seq), data });
const userMsg = (text, kind = 'user') => ev('user/message', { content: [{ type: 'text', text }], source: { kind } });
const reply = text => ev('assistant/message', { message: { content: [{ type: 'text', text }, { type: 'tool-call', name: 'x' }] } });

function sampleLog() {
  seq = 0;
  const brief = workerBrief({ taskId: 'T-aaaaaa', title: 'Add i18n', brief: 'Localize the plugin page.', leaderSessionId: 'session-L' });
  return [
    ev('session/title', { title: 'Old research title' }),
    userMsg('Research leader agents'),
    userMsg('runtime context', 'runtime-context'),
    reply('Found ccteam and firstmate.'),
    ev('turn/end', { reason: { kind: 'completed' } }),
    userMsg('Implement it'),
    ev('tool/call', { name: 'write', arguments: JSON.stringify({ file_path: '/w/src/host.js', content: 'x' }) }),
    ev('tool/call', { name: 'edit', arguments: { file_path: '/w/src/host.js' } }),
    ev('tool/call', { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: /w/README.md\n+x\n*** Update File: /w/src/core.js\n*** End Patch' }) }),
    ev('tool/call', { name: 'bash', arguments: '{"command":"ls"}' }),
    ev('todo/write', { todos: [{ content: 'tests', status: 'completed' }] }),
    reply('Implemented and tested.'),
    ev('turn/end', { reason: { kind: 'completed' } }),
    ev('compaction/summary', { summary: [{ type: 'text', text: 'Summary of earlier work' }] }),
    userMsg(brief),
    reply('Plugin has no UI of its own.\n\n## Report\n- Status: needs-decision'),
  ];
}

test('stripBriefFooter removes the dispatch footer only', () => {
  const brief = workerBrief({ taskId: 'T-aaaaaa', title: 't', brief: 'body', leaderSessionId: 'L' });
  assert.equal(stripBriefFooter(brief), '# Task T-aaaaaa: t\n\nbody');
  const follow = workerBrief({ taskId: 'T-bbbbbb', title: 't', brief: 'next', leaderSessionId: 'L', followup: true });
  assert.equal(stripBriefFooter(follow), '# Task T-bbbbbb: t\n\nnext');
  assert.ok(follow.length < brief.length);
  assert.match(follow, /## Report/);
  assert.equal(stripBriefFooter('plain --- text'), 'plain --- text');
});

for (const followup of [false, true]) {
  test(`${followup ? 'follow-up' : 'initial'} dispatch asks the worker to report uncertainty without interrupting the user`, () => {
    const brief = workerBrief({ taskId: 'T-aaaaaa', title: 't', brief: 'body', leaderSessionId: 'L', followup });
    assert.equal(brief.match(/Do not call ask_user_question/g)?.length, 1);
    assert.match(brief, /most reasonable assumption within the authorized task scope/);
    assert.match(brief, /record your assumptions and risks in the report/);
    assert.match(brief, /cannot proceed, state the blocker/);
    assert.equal(stripBriefFooter(brief), '# Task T-aaaaaa: t\n\nbody');
  });
}

test('touchedFiles reads write, edit and apply_patch arguments', () => {
  assert.deepEqual(touchedFiles('write', '{"file_path":"/a"}'), ['/a']);
  assert.deepEqual(touchedFiles('edit', { file_path: '/b' }), ['/b']);
  assert.deepEqual(touchedFiles('apply_patch', { input: '*** Delete File: /c\n*** Update File: /d' }), ['/c', '/d']);
  assert.deepEqual(touchedFiles('write', 'not json'), []);
});

test('sessionDigest summarizes requests, replies, todos and files', () => {
  const digest = sessionDigest(sampleLog(), { recentTurns: 2 });
  assert.equal(digest.title, 'Old research title');
  assert.equal(digest.exchanges_total, 3);
  assert.deepEqual(digest.earlier_requests, ['1. Research leader agents']);
  assert.equal(digest.recent.length, 2);
  assert.equal(digest.recent[0].request, 'Implement it');
  assert.equal(digest.recent[0].reply, 'Implemented and tested.');
  assert.equal(digest.recent[0].tool_calls, 4);
  assert.equal(digest.recent[0].ended, 'completed');
  const last = digest.recent[1];
  assert.equal(last.request, '# Task T-aaaaaa: Add i18n\n\nLocalize the plugin page.');
  assert.equal(last.ended, 'in-progress');
  assert.match(last.reply, /needs-decision/);
  assert.equal(digest.compacted_summary, 'Summary of earlier work');
  assert.deepEqual(digest.todos, [{ content: 'tests', status: 'completed' }]);
  assert.equal(digest.files_changed[0], '/w/src/host.js');
  assert.deepEqual([...digest.files_changed].sort(), ['/w/README.md', '/w/src/core.js', '/w/src/host.js']);
});

test('sessionDigest truncates long text and handles empty logs', () => {
  seq = 0;
  const digest = sessionDigest([userMsg('x'.repeat(5000)), reply('y'.repeat(5000))], { requestChars: 300, replyChars: 500 });
  assert.ok(digest.recent[0].request.length < 400);
  assert.ok(digest.recent[0].reply.length < 600);
  assert.deepEqual(sessionDigest([]), { title: null, exchanges_total: 0, earlier_requests: [], recent: [], todos: null, files_changed: [] });
});

test('lastRequestOf returns the latest user or agent request', () => {
  assert.equal(lastRequestOf(sampleLog()), '# Task T-aaaaaa: Add i18n');
  seq = 0;
  assert.equal(lastRequestOf([userMsg('first'), userMsg('context', 'runtime-context')]), 'first');
  assert.equal(lastRequestOf([]), null);
});

import { modelOfEvents, formatModel, parseModelArgs, sameSelection } from '../src/core.js';

const header = (provider, model, reasoningEffort, adapterDefaults) => ({ type: 'request/header', data: { header: { config: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }, ...(adapterDefaults ? { adapterDefaults } : {}) } } });
const pick = (provider, model, reasoningEffort) => ({ type: 'model/selection', data: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } });

test('modelOfEvents follows request headers and pending selections', () => {
  assert.deepEqual(modelOfEvents([]), { current: null, lastUsed: null, switchPending: false });
  const used = modelOfEvents([header('litellm', 'flash'), header('litellm', 'opus', 'high')]);
  assert.deepEqual(used.current, { provider: 'litellm', model: 'opus', reasoningEffort: 'high' });
  assert.equal(used.switchPending, false);

  const pending = modelOfEvents([header('litellm', 'flash'), pick('deepseek', 'v4')]);
  assert.deepEqual(pending.current, { provider: 'deepseek', model: 'v4' });
  assert.deepEqual(pending.lastUsed, { provider: 'litellm', model: 'flash' });
  assert.equal(pending.switchPending, true);

  const applied = modelOfEvents([pick('deepseek', 'v4'), header('deepseek', 'v4')]);
  assert.equal(applied.switchPending, false);
  assert.deepEqual(applied.current, { provider: 'deepseek', model: 'v4' });

  // An adapter-defaulted effort is not a user choice.
  assert.deepEqual(modelOfEvents([header('x', 'm', 'high', { reasoningEffort: true })]).current, { provider: 'x', model: 'm' });
  // Malformed events are ignored.
  assert.equal(modelOfEvents([{ type: 'model/selection', data: { provider: '' } }, { type: 'request/header', data: {} }]).current, null);
});

test('formatModel and sameSelection', () => {
  assert.equal(formatModel(null), null);
  assert.equal(formatModel({ provider: 'litellm', model: 'oneapi/Opus 5.5', reasoningEffort: 'xhigh' }), 'litellm/oneapi/Opus 5.5 (xhigh)');
  assert.equal(formatModel({ provider: 'p', model: 'm' }), 'p/m');
  assert.ok(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }));
  assert.ok(!sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'low' }));
  assert.ok(sameSelection(null, null));
  assert.ok(!sameSelection(null, { provider: 'p', model: 'm' }));
});

test('parseModelArgs', () => {
  assert.equal(parseModelArgs({}), undefined);
  assert.throws(() => parseModelArgs({}, { required: true }), { code: 'model_required' });
  assert.deepEqual(parseModelArgs({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(parseModelArgs({ provider: 'p', model: 'm', reasoning_effort: 'low' }), { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.throws(() => parseModelArgs({ model: 'm' }), { code: 'invalid_model' });
  assert.throws(() => parseModelArgs({ reasoning_effort: 'low' }), { code: 'invalid_model' });
  assert.throws(() => parseModelArgs({ provider: 1, model: 'm' }), { code: 'invalid_model' });
});

import { dispatchApprovalText, modelApprovalText, titleOfEvents } from '../src/core.js';

test('titleOfEvents returns the latest title', () => {
  assert.equal(titleOfEvents([]), null);
  assert.equal(titleOfEvents([{ type: 'session/title', data: { title: 'a' } }, { type: 'x' }, { type: 'session/title', data: { title: 'b' } }]), 'b');
});

test('dispatch approval text leads with the target', () => {
  const ws = { title: 'file-stat', path: '/w/file-stat' };
  const existing = dispatchApprovalText({
    title: 'Add --sort', brief: '  Do it.  ', model: undefined,
    place: { kind: 'existing', workspace: ws, sessionRef: 'session-1', sessionTitle: 'T-1 build tool', running: true, mode: 'queue' },
  });
  assert.equal(existing.zh.split('\n\n')[0], [
    '【继续已有会话】Leader 要派发任务「Add --sort」',
    '工作区：file-stat（/w/file-stat）',
    '会话：T-1 build tool（session-1）',
    '状态：正在运行，任务排队，等当前轮次结束后开始（queue）',
  ].join('\n'));
  assert.ok(existing.zh.endsWith('\n\nDo it.'));
  assert.match(existing.en, /^\[Continue existing session\] Leader wants to dispatch "Add --sort"\nWorkspace: file-stat \(\/w\/file-stat\)\nSession: T-1 build tool \(session-1\)\nStatus: running; the task is queued/);

  const steer = dispatchApprovalText({ title: 't', brief: 'b', place: { kind: 'existing', workspace: ws, sessionRef: 's', sessionTitle: null, running: true, mode: 'steer' } });
  assert.match(steer.zh, /会话：（无标题）（s）\n状态：正在运行，任务会注入当前轮次（steer）/);
  const idle = dispatchApprovalText({ title: 't', brief: 'b', place: { kind: 'existing', workspace: ws, sessionRef: 's', sessionTitle: 'x', running: false, mode: 'steer' } });
  assert.match(idle.en, /Status: idle; starts right away/);

  const fresh = dispatchApprovalText({ title: 't', brief: 'b', model: 'litellm/pro (low)', place: { kind: 'new', workspaceRef: 'w-id', workspace: ws } });
  assert.equal(fresh.zh.split('\n\n')[0], '【新建会话】Leader 要派发任务「t」\n工作区：file-stat（/w/file-stat）\n会话：新建会话\n模型：litellm/pro (low)');
  assert.doesNotMatch(fresh.zh, /状态：/);

  const missingWs = dispatchApprovalText({ title: 't', brief: 'b', place: { kind: 'new', workspaceRef: 'nope' } });
  assert.match(missingWs.zh, /工作区：找不到「nope」，派发会失败/);
  const missingSession = dispatchApprovalText({ title: 't', brief: 'b', place: { kind: 'existing', sessionRef: 'gone', sessionMissing: true } });
  assert.match(missingSession.en, /Session: gone not found; the dispatch will fail/);
  assert.doesNotMatch(missingSession.en, /Status:/);
  const loose = dispatchApprovalText({ title: 't', brief: 'b', place: { kind: 'existing', cwd: '/tmp/x', sessionRef: 's', sessionTitle: 'x', running: false } });
  assert.match(loose.zh, /工作区：不在已登记的工作区（目录 \/tmp\/x）/);
});

test('model approval text names the session and current model', () => {
  const text = modelApprovalText({ model: 'litellm/pro (low)', current: 'litellm/flash', place: { sessionRef: 'session-1', sessionTitle: 'Build', workspace: { title: 'w', path: '/w' } } });
  assert.equal(text.zh, 'Leader 要把会话的模型改为 litellm/pro (low)\n会话：Build（session-1）\n工作区：w（/w）\n当前模型：litellm/flash');
  assert.match(text.en, /^Leader wants to switch a session to litellm\/pro \(low\)\nSession: Build \(session-1\)/);
});

import { effectiveWriteTools, ORIGINAL_WRITE_TOOLS, ADDED_WRITE_TOOLS, DEFAULT_WRITE_TOOLS } from '../src/core.js';

test('write tools: default, saved lists, and the always-added tools', () => {
  assert.deepEqual(ORIGINAL_WRITE_TOOLS, ['create_workspace', 'dispatch_task', 'cancel_task']);
  assert.deepEqual(DEFAULT_WRITE_TOOLS, [...ORIGINAL_WRITE_TOOLS, 'set_session_model']);
  assert.deepEqual([...effectiveWriteTools(undefined)].sort(), [...DEFAULT_WRITE_TOOLS].sort());
  // A list saved before set_session_model existed still gets it.
  assert.deepEqual([...effectiveWriteTools(['create_workspace', 'dispatch_task', 'cancel_task'])].sort(), [...DEFAULT_WRITE_TOOLS].sort());
  // A user who turned approval off for some original tools keeps that choice.
  assert.deepEqual([...effectiveWriteTools(['dispatch_task'])].sort(), ['dispatch_task', 'set_session_model']);
  assert.deepEqual([...effectiveWriteTools([])], ADDED_WRITE_TOOLS);
  // Union, not duplication.
  assert.equal(effectiveWriteTools(['set_session_model', 'dispatch_task']).size, 2);
});
