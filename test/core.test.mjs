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
