// Leader memory: a plain MEMORY.md in the Leader session's working directory.
// Pure file logic with no DSH imports, so it can be unit-tested directly.
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MEMORY_FILE = 'MEMORY.md';
export const MEMORY_MAX_CHARS = 32000;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export function memoryPath(dir) {
  if (typeof dir !== 'string' || !dir) throw new MemoryError('no_cwd', 'This session has no working directory.');
  return join(dir, MEMORY_FILE);
}

/** Read MEMORY.md; a missing file reads as empty. */
export async function readMemory(dir) {
  const path = memoryPath(dir);
  try {
    const content = await readFile(path, 'utf8');
    return { path, exists: true, content, chars: content.length };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, exists: false, content: '', chars: 0 };
    throw error;
  }
}

/**
 * Write MEMORY.md atomically.
 * @param mode - append (default): add `content` as a new paragraph at the end;
 *   replace: the file becomes exactly `content` (an empty string clears it).
 */
export async function writeMemory(dir, { content, mode = 'append' }) {
  if (typeof content !== 'string') throw new MemoryError('invalid_content', 'content must be a string');
  if (mode !== 'append' && mode !== 'replace') throw new MemoryError('invalid_mode', 'mode must be append or replace');
  const current = await readMemory(dir);
  let next;
  if (mode === 'replace') {
    next = content.trim() ? `${content.trimEnd()}\n` : '';
  } else {
    const addition = content.trim();
    if (!addition) throw new MemoryError('empty_content', 'content is empty; nothing to append.');
    const base = current.content.trimEnd();
    next = `${base ? `${base}\n\n` : ''}${addition}\n`;
  }
  if (next.length > MEMORY_MAX_CHARS) {
    throw new MemoryError('too_large', `${MEMORY_FILE} would be ${next.length} characters; the limit is ${MEMORY_MAX_CHARS}. Read it, condense it, and write it back with mode "replace".`);
  }
  const temp = `${current.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, next);
    await rename(temp, current.path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { path: current.path, mode, created: !current.exists, chars: next.length, max_chars: MEMORY_MAX_CHARS };
}
