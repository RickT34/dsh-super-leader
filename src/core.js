// Pure logic with no DSH imports, so it can be unit-tested directly.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_PRESET_ID = 'leader';
export const DEFAULT_WRITE_TOOLS = ['create_workspace', 'dispatch_task', 'cancel_task'];
export const DEFAULT_FULL_ACCESS = ['danger-full-access'];
export const REPORT_PREFIX = '[Leader report]';
export const DIR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TASK_ID_PATTERN = /^T-[0-9a-f]{6}$/;

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** Whether `child` equals `root` or lies under it (both absolute, already normalized). */
export function isInside(root, child) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/** Generate a short task id that is not already used. */
export function newTaskId(existing) {
  for (let i = 0; i < 100; i++) {
    const id = `T-${randomBytes(3).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
  throw new Error('could not allocate a task id');
}

/** Resolve the workspace root a directory name is created under. */
export function resolveRoot(roots, requested, home = homedir()) {
  const normalized = roots.map(root => resolve(expandHome(root, home)));
  if (normalized.length === 0) throw new LeaderError('no_roots', 'No workspace root is configured (super-leader.workspaceRoots).');
  if (requested === undefined || requested === '') return normalized[0];
  const wanted = resolve(expandHome(requested, home));
  const match = normalized.find(root => root === wanted);
  if (match === undefined) throw new LeaderError('root_not_allowed', `"${requested}" is not a configured workspace root. Allowed roots: ${normalized.join(', ')}`);
  return match;
}

/**
 * Validate a new workspace directory and decide what to do with it.
 * @returns {{ path: string, action: 'create' | 'register' | 'exists-registered' }}
 */
export async function planWorkspaceDirectory({ root, name, registerExisting, isRegistered }) {
  if (typeof name !== 'string' || !DIR_NAME_PATTERN.test(name)) {
    throw new LeaderError('invalid_name', 'name must be 1-64 characters of letters, digits, ".", "_" or "-", starting with a letter or digit.');
  }
  const path = join(root, name);
  let info;
  try { info = await stat(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (info === undefined) return { path, action: 'create' };
  if (!info.isDirectory()) throw new LeaderError('not_directory', `${path} exists and is not a directory.`);
  const real = await realpath(path);
  const realRoot = await realpath(root);
  if (!isInside(realRoot, real)) throw new LeaderError('outside_root', `${path} resolves outside the workspace root.`);
  if (await isRegistered(real)) return { path: real, action: 'exists-registered' };
  const entries = await readdir(real);
  if (entries.length > 0 && !registerExisting) {
    throw new LeaderError('directory_not_empty', `${real} already exists and is not empty. Ask the user whether to register it as a workspace, then retry with register_existing: true.`);
  }
  return { path: real, action: 'register' };
}

export class LeaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeaderError';
    this.code = code;
  }
}

/** Atomic JSON ledger of tasks and workspace notes. */
export class Ledger {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, tasks: {}, workspaces: {} };
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && parsed.version === 1 && typeof parsed.tasks === 'object' && typeof parsed.workspaces === 'object') this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  /** Serialize writes; each write replaces the file atomically. */
  save() {
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`);
      await rename(temp, this.file);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  taskIds() { return new Set(Object.keys(this.data.tasks)); }
  task(id) { return this.data.tasks[id]; }
  tasks() { return Object.values(this.data.tasks); }

  putTask(task) {
    this.data.tasks[task.id] = task;
    return this.save();
  }

  updateTask(id, patch) {
    const task = this.data.tasks[id];
    if (task === undefined) return Promise.resolve(undefined);
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return this.save().then(() => task);
  }

  workspaceNote(path) { return this.data.workspaces[path]; }

  setWorkspaceNote(path, note) {
    this.data.workspaces[path] = { ...this.data.workspaces[path], ...note };
    return this.save();
  }
}

/** Map a DSH turn-end reason kind to a task status. */
export function statusForTurnEnd(kind) {
  switch (kind) {
    case 'completed': return 'completed';
    case 'aborted': return 'cancelled';
    case 'error': return 'failed';
    case 'blocked': return 'blocked';
    default: return 'finished';
  }
}

/** Truncate text to a character budget, keeping the head and tail. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 40;
  return `${text.slice(0, head)}\n…[${text.length - head - Math.max(tail, 0)} characters omitted]…\n${tail > 0 ? text.slice(-tail) : ''}`;
}

/** Extract plain text from assistant message content blocks. */
export function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

export const BRIEF_FOOTER_MARK = '\n---\nThis task was assigned by a leader session';
const FOLLOWUP_FOOTER_MARK = '\n---\nFollow-up from the leader session';

/**
 * The message a worker receives. A session that already received a Leader task
 * knows the report format, so a follow-up gets a one-line footer.
 */
export function workerBrief({ taskId, title, brief, leaderSessionId, followup = false }) {
  if (followup) {
    return [
      `# Task ${taskId}: ${title}`,
      '',
      brief.trim(),
      `${FOLLOWUP_FOOTER_MARK} (${leaderSessionId}). End your final reply with the same "## Report" block as before (Status / Summary / Changes / Open questions).`,
    ].join('\n');
  }
  return [
    `# Task ${taskId}: ${title}`,
    '',
    brief.trim(),
    '',
    '---',
    `This task was assigned by a leader session (${leaderSessionId}) on behalf of the user.`,
    'Work on it in this session. When you finish, or when you cannot continue, end your final reply with a short report in this form:',
    '',
    '## Report',
    '- Status: done | blocked | needs-decision',
    '- Summary: what you did and the result',
    '- Changes: files or artifacts you created or changed',
    '- Open questions: decisions or information you need from the user (or "none")',
  ].join('\n');
}

/** The message the leader receives when a worker turn ends. */
export function leaderReport({ task, status, report }) {
  const lines = [
    `${REPORT_PREFIX} Task ${task.id} "${task.title}" — status: ${status}`,
    `Worker session: ${task.sessionId}${task.workspacePath ? ` (workspace ${task.workspacePath})` : ''}`,
    '',
    report.length > 0 ? report : '(The worker ended its turn without a text reply.)',
    '',
    'Relay the outcome to the user in your own words. If the report contains open questions or decisions, ask the user about them; do not decide for them.',
  ];
  return lines.join('\n');
}

export const LEADER_PERSONA = `You are the Leader: a coordinator that manages the user's DeepSeek Harness workspaces and sessions. You do not do the work yourself. Your job is to understand what the user wants, decide where the work should happen, hand it to a worker session, and report the outcome back.

## How you work
1. Clarify before dispatching. For every request, check that you know: the goal, the scope, the expected deliverable, how the user will judge it done, and which workspace it belongs to. If any of these is missing or ambiguous, ask with ask_user_question. Offer concrete options (candidate workspaces, "continue session X" vs "new session") so the user can answer with one click. Never fill gaps with guesses. Asking one more question is cheaper than a wrong dispatch. When you ask, stop and wait for the answer: never ask a question and act on your own guess in the same turn.
2. Look before routing. Use list_workspaces and list_sessions to find candidates. Titles are often stale or vague, so before choosing an existing session, call read_session on it to see what it actually did and where it stopped. Continue an existing session when the task builds on its work; otherwise create a new session in the right workspace. If the session's state changes what the user should decide (for example the work is half done, or it went a different way), tell the user and ask.
3. Create a workspace only for genuinely new projects. Ask the user to confirm the directory name and purpose with ask_user_question (offer your suggested name as the first option) before calling create_workspace, unless the user already gave both.
4. Fit the brief to the target.
   - Existing session: it already has its own context. Write only the next step: what the user wants now, what changed, any decision the user made, and how to tell it is done. A few lines is normal. Do not restate the project, re-describe its code, or prescribe how to implement things it already knows better than you.
   - New session: it knows nothing and cannot see this conversation. The brief must be self-contained: goal, background the user gave, constraints, deliverable, and acceptance criteria.
   - In both cases, use the user's own words for requirements, and do not state guesses about the project as facts. If you are unsure whether something exists, say so and let the worker check.
5. Do not re-confirm what an approval card already shows. When the user has answered your clarifying questions, dispatch; the approval card (when approval is required) is the final confirmation.
6. Stay at the coordination level. Do not try to read code, inspect files, or solve the task. read_session tells you what a worker did; it is for routing and briefing, not for doing the work. If you need technical facts that no session has, dispatch a short investigation task instead.
7. Relay reports faithfully. When a "${REPORT_PREFIX}" message arrives, summarize the result for the user, and turn any open questions or decisions in it into questions for the user. Never make decisions on the user's behalf.
8. Track work with task_status. Use cancel_task only when the user asks to stop a task.

Reply in the user's language. Keep messages short and concrete.`;

// ── session digest ──────────────────────────────────────────────────────────
// A compact, read-only picture of what a session has done, built from its raw
// event log, so the Leader can route by content instead of by title.

const REQUEST_SOURCES = new Set(['user', 'agent-message', 'schedule']);
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor']);

/** Remove the footer dsh-super-leader appends to dispatched briefs. */
export function stripBriefFooter(text) {
  for (const mark of [BRIEF_FOOTER_MARK, FOLLOWUP_FOOTER_MARK]) {
    const at = text.indexOf(mark);
    if (at >= 0) return text.slice(0, at).trimEnd();
  }
  return text;
}

function firstLine(text, max) {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** File paths a write-type tool call touched. */
export function touchedFiles(name, rawArgs) {
  const args = parseArgs(rawArgs);
  if (name === 'apply_patch' && typeof args.input === 'string') {
    return [...args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1].trim());
  }
  const path = args.file_path ?? args.path;
  return typeof path === 'string' ? [path] : [];
}

/**
 * Summarize a session event log.
 * @param events - raw session events in seq order.
 * @param options - recentTurns: exchanges shown in full; budgets in characters.
 */
export function sessionDigest(events, { recentTurns = 4, requestChars = 800, replyChars = 1500, olderReplyChars = 400, summaryChars = 2500, maxFiles = 30 } = {}) {
  const exchanges = [];
  let current;
  let title = null;
  let todos = null;
  let compaction = null;
  const files = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string') title = data.title;
        break;
      case 'todo/write':
        if (Array.isArray(data.todos)) todos = data.todos;
        break;
      case 'compaction/summary':
        compaction = { text: textOf(data.summary), before: exchanges.length };
        break;
      case 'user/message': {
        const kind = data.source?.kind;
        if (!REQUEST_SOURCES.has(kind)) break;
        const text = stripBriefFooter(textOf(data.content));
        if (!text) break;
        current = { from: kind === 'user' ? 'user' : kind, time: event.time, request: text, reply: '', tools: 0, end: null };
        exchanges.push(current);
        break;
      }
      case 'assistant/message': {
        if (current === undefined) break;
        const text = textOf(data.message?.content);
        if (text) current.reply = text;
        break;
      }
      case 'tool/call':
        if (current !== undefined) current.tools += 1;
        if (WRITE_TOOLS.has(data.name)) for (const path of touchedFiles(data.name, data.arguments)) files.set(path, (files.get(path) ?? 0) + 1);
        break;
      case 'turn/end':
        if (current !== undefined) current.end = data.reason?.kind ?? null;
        break;
      default:
        break;
    }
  }
  const recentStart = Math.max(0, exchanges.length - recentTurns);
  const view = (exchange, index) => {
    const latest = index === exchanges.length - 1;
    return {
      n: index + 1,
      from: exchange.from,
      at: exchange.time === undefined ? null : new Date(exchange.time).toISOString(),
      request: truncate(exchange.request, requestChars),
      reply: exchange.reply ? truncate(exchange.reply, latest ? replyChars : olderReplyChars) : null,
      tool_calls: exchange.tools,
      ended: exchange.end ?? (latest ? 'in-progress' : null),
    };
  };
  const fileList = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxFiles).map(([path]) => path);
  return {
    title,
    exchanges_total: exchanges.length,
    earlier_requests: exchanges.slice(0, recentStart).map((exchange, index) => `${index + 1}. ${firstLine(exchange.request, 100)}`),
    ...(compaction && compaction.text ? { compacted_summary: truncate(compaction.text, summaryChars) } : {}),
    recent: exchanges.slice(recentStart).map((exchange, offset) => view(exchange, recentStart + offset)),
    todos,
    files_changed: fileList,
    ...(files.size > fileList.length ? { files_changed_more: files.size - fileList.length } : {}),
  };
}

/** First line of the latest user or agent request in a session, for list rows. */
export function lastRequestOf(events, max = 120) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'user/message' || !REQUEST_SOURCES.has(event.data?.source?.kind)) continue;
    const text = stripBriefFooter(textOf(event.data.content));
    if (text) return firstLine(text, max);
  }
  return null;
}
