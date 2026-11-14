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
