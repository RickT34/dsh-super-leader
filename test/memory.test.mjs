import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_MAX_CHARS, readMemory, writeMemory } from '../src/memory.js';
import { apply } from '../src/tools.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'leader-memory-'));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
}

test('missing MEMORY.md reads as empty', async t => {
  const dir = await tempDir(t);
  assert.deepEqual(await readMemory(dir), { path: join(dir, 'MEMORY.md'), exists: false, content: '', chars: 0 });
});

test('append adds paragraphs; replace rewrites and can clear', async t => {
  const dir = await tempDir(t);
  const first = await writeMemory(dir, { content: '- User prefers Chinese replies\n' });
  assert.equal(first.created, true);
  await writeMemory(dir, { content: '  - Workspace api handles the backend  ', mode: 'append' });
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), '- User prefers Chinese replies\n\n- Workspace api handles the backend\n');
  await writeMemory(dir, { content: '# Memory\n- one', mode: 'replace' });
  assert.equal((await readMemory(dir)).content, '# Memory\n- one\n');
  await writeMemory(dir, { content: '', mode: 'replace' });
  assert.equal((await readMemory(dir)).content, '');
  assert.deepEqual(await readdir(dir), ['MEMORY.md']); // no temp files left
});

test('rejects empty appends, bad modes, and oversized files without touching the file', async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'MEMORY.md'), 'keep\n');
  await assert.rejects(writeMemory(dir, { content: '   ' }), { code: 'empty_content' });
  await assert.rejects(writeMemory(dir, { content: 'x', mode: 'merge' }), { code: 'invalid_mode' });
  await assert.rejects(writeMemory(dir, { content: 'x'.repeat(MEMORY_MAX_CHARS) }), { code: 'too_large' });
  await assert.rejects(writeMemory(undefined, { content: 'x' }), { code: 'no_cwd' });
  assert.equal(await readFile(join(dir, 'MEMORY.md'), 'utf8'), 'keep\n');
});

test('memory tools use the session working directory and report failures', async t => {
  const dir = await tempDir(t);
  const tools = new Map();
  const asked = [];
  const ctx = {
    get: name => name === 'workingDirectory' ? { ensure: async agent => { asked.push(agent.id); return dir; } } : undefined,
    effect() {},
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    tools: { register(tool) { tools.set(tool.name, tool); } },
  };
  apply(ctx, {});
  const exec = { agent: { id: 'leader' } };
  const write = await tools.get('write_memory').execute({ content: '- remember me' }, exec);
  assert.equal(write.ok, true);
  assert.equal(write.mode, 'append');
  const read = await tools.get('read_memory').execute({}, exec);
  assert.equal(read.content, '- remember me\n');
  assert.deepEqual(asked, ['leader', 'leader']);
  const bad = await tools.get('write_memory').execute({ content: 'x', extra: 1 }, exec);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /unknown argument/);
  assert.equal((await tools.get('read_memory').execute({}, {})).error, 'no_agent');
});
