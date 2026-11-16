// Preset-scoped half: the Leader tools and persona. Mounted only inside the
// Leader agent preset, so only Leader sessions see these tools.
import { LEADER_PERSONA, parseModelArgs } from './core.js';
import { requireRuntime } from './runtime.js';
import { MEMORY_FILE, MEMORY_MAX_CHARS, readMemory, writeMemory } from './memory.js';

export const name = 'super-leader-tools';
export const inject = ['tools', 'systemPrompt'];

const OPEN_OBJECT = { type: 'object', additionalProperties: true };
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];

function objectSchema(properties, required = []) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function onlyKeys(args, allowed) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  const extra = Object.keys(args).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`unknown argument(s): ${extra.join(', ')}`);
  return args;
}

function str(args, key, { required = false, max = 100000 } = {}) {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (value.length > max) throw new Error(`${key} is longer than ${max} characters`);
  return value;
}

function bool(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

/** Drop undefined and non-JSON values: DSH requires lossless JSON tool output. */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Run a tool body and turn known failures into a structured result the model can act on. */
async function run(exec, body) {
  const leader = exec.agent;
  if (leader === undefined) return { ok: false, error: 'no_agent', message: 'This tool must be called by an agent.' };
  try {
    return jsonSafe({ ok: true, ...(await body(requireRuntime(), leader)) });
  } catch (error) {
    if (exec.signal?.aborted) throw error;
    return { ok: false, error: error?.code ?? 'failed', message: error?.message ?? String(error) };
  }
}

/** The calling session's working directory (where MEMORY.md lives). */
async function sessionCwd(ctx, exec) {
  const owner = ctx.get('workingDirectory');
  if (owner !== undefined) return owner.ensure(exec.agent, exec.signal);
  return exec.agent.session?.header?.cwd;
}

/** Like run(), for tools that need only the session, not the host plugin. */
async function runLocal(exec, body) {
  if (exec.agent === undefined) return { ok: false, error: 'no_agent', message: 'This tool must be called by an agent.' };
  try {
    return jsonSafe({ ok: true, ...(await body()) });
  } catch (error) {
    if (exec.signal?.aborted) throw error;
    return { ok: false, error: error?.code ?? 'failed', message: error?.message ?? String(error) };
  }
}

const card = (title, kind, rawInput) => ({ card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) });

export function apply(ctx, config = {}) {
  const persona = typeof config.persona === 'string' && config.persona.trim() ? config.persona : LEADER_PERSONA;
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: persona,
  }), 'super-leader persona');
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-suffix',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '',
  }), 'super-leader persona suffix');

  ctx.tools.register({
    name: 'list_workspaces',
    description: 'List the registered DSH workspaces: id, title, absolute path, number of sessions, and the purpose note recorded for it. Read-only.',
    parameters: objectSchema({}),
    output: { schema: OPEN_OBJECT, render },
    presentCall: () => card('List workspaces', 'read'),
    execute: (args, exec) => run(exec, async rt => { onlyKeys(args ?? {}, []); return rt.listWorkspaces(); }),
  });

  ctx.tools.register({
    name: 'list_sessions',
    description: 'List top-level DSH sessions (newest first): id, title, workspace, whether it is running, last update, the model it will use next, the first line of its latest request, and the latest task the Leader dispatched to it. Titles are often stale; use read_session to see what a session actually did. Read-only.',
    parameters: objectSchema({
      workspace_id: { type: 'string', description: 'Only sessions in this workspace (id or exact title).' },
      query: { type: 'string', description: 'Case-insensitive substring filter on title or directory.' },
      limit: { type: 'integer', description: 'Maximum rows, 1-100; default 30.' },
    }),
    output: { schema: OPEN_OBJECT, render },
    presentCall: () => card('List sessions', 'read'),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['workspace_id', 'query', 'limit']);
      const limit = args.limit === undefined ? 30 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
      return rt.listSessions({ workspaceId: str(args, 'workspace_id'), query: str(args, 'query'), limit, leader }, exec.signal);
    }),
  });

  ctx.tools.register({
    name: 'read_session',
    description: 'Read what a session has actually done (and which model it uses): its recent requests and the agent\'s replies, a one-line list of earlier requests, its todo list, files it wrote or edited, and Leader tasks sent to it. Read-only. Call this before dispatching to an existing session, so the brief only needs to state what is new.',
    parameters: objectSchema({
      session_id: { type: 'string', description: 'Session id from list_sessions.' },
      recent_turns: { type: 'integer', description: 'How many latest exchanges to show in full, 1-10; default 4.' },
    }, ['session_id']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card('Read session', 'read', args?.session_id),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['session_id', 'recent_turns']);
      const recentTurns = args.recent_turns === undefined ? 4 : args.recent_turns;
      if (!Number.isInteger(recentTurns) || recentTurns < 1 || recentTurns > 10) throw new Error('recent_turns must be an integer from 1 to 10');
      return rt.readSession({ sessionId: str(args, 'session_id', { required: true, max: 200 }), recentTurns, leader });
    }),
  });

  ctx.tools.register({
    name: 'task_status',
    description: 'Show tasks this Leader dispatched: status (queued, running, completed, blocked, failed, cancelled, interrupted), report_state (pending, delivered, recovered, undelivered, lost), worker session, and the worker report. recovered means you never received the report and its text was rebuilt from the worker log; lost means there is no report. Tell the user when a report was recovered or lost. Read-only.',
    parameters: objectSchema({
      task_id: { type: 'string', description: 'One task id such as T-3f9a01. Omit to list recent tasks.' },
      include_report: { type: 'boolean', description: 'Include full reports when listing; default false (a single task always includes it).' },
    }),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card('Task status', 'read', args?.task_id),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['task_id', 'include_report']);
      return rt.taskStatus({ taskId: str(args, 'task_id'), includeReport: bool(args, 'include_report') ?? false, leader });
    }),
  });

  ctx.tools.register({
    name: 'create_workspace',
    description: 'Create a new project directory under an allowed workspace root and register it as a DSH workspace. Optionally clone a git repository into it, run git init, and write an AGENTS.md describing the project. If the directory is already a workspace, returns it. Requires user approval unless the session has full access. Confirm the name and purpose with the user first.',
    parameters: objectSchema({
      name: { type: 'string', description: 'Directory name: letters, digits, ".", "_" or "-", max 64 characters.' },
      purpose: { type: 'string', description: 'One or two sentences on what this workspace is for; stored as its routing note.' },
      title: { type: 'string', description: 'Display title; defaults to the directory name.' },
      root: { type: 'string', description: 'One of the configured workspace roots; defaults to the first.' },
      git_clone_url: { type: 'string', description: 'Clone this repository into the new directory.' },
      git_init: { type: 'boolean', description: 'Run git init in a new empty directory.' },
      write_agents_md: { type: 'boolean', description: 'Write an AGENTS.md with the purpose when none exists; default true.' },
      register_existing: { type: 'boolean', description: 'Allow registering an existing non-empty directory. Only after the user agreed.' },
    }, ['name', 'purpose']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card(`Create workspace ${args?.name ?? ''}`.trim(), 'other', args),
    execute: (args, exec) => run(exec, async rt => {
      onlyKeys(args, ['name', 'purpose', 'title', 'root', 'git_clone_url', 'git_init', 'write_agents_md', 'register_existing']);
      return rt.createWorkspace({
        name: str(args, 'name', { required: true, max: 64 }),
        purpose: str(args, 'purpose', { required: true, max: 2000 }),
        title: str(args, 'title', { max: 200 }),
        root: str(args, 'root', { max: 4096 }),
        gitCloneUrl: str(args, 'git_clone_url', { max: 2048 }),
        gitInit: bool(args, 'git_init') ?? false,
        writeAgentsMd: bool(args, 'write_agents_md') ?? true,
        registerExisting: bool(args, 'register_existing') ?? false,
      }, exec.signal);
    }),
  });

  ctx.tools.register({
    name: 'dispatch_task',
    description: 'Send a task to a worker session. Target either an existing session (session_id) or a workspace (workspace_id) where a new session is created. For an existing session, read_session first and write only the next step: what is new or changed relative to what it already did, plus the done criteria; do not restate the project. For a new session, the worker knows nothing, so the brief must be self-contained: goal, context, constraints, deliverable, acceptance criteria. When the worker finishes its turn you receive a "[Leader report]" message. Requires user approval unless the session has full access.',
    parameters: objectSchema({
      title: { type: 'string', description: 'Short task title (also used as the new session title).' },
      brief: { type: 'string', description: 'The complete, self-contained task brief.' },
      session_id: { type: 'string', description: 'Existing worker session to continue. Exclusive with workspace_id.' },
      workspace_id: { type: 'string', description: 'Workspace (id, or exact title) in which to create a new worker session. Exclusive with session_id.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'For a busy existing session: queue (default) waits for its current turn; steer injects into the running turn.' },
      provider: { type: 'string', description: 'Optional: run the worker on this provider (with model). Only when the user asked for a specific model; ids come from list_models.' },
      model: { type: 'string', description: 'Optional: model id, together with provider.' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort for that model, from list_models.' },
    }, ['title', 'brief']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card(`Dispatch: ${args?.title ?? ''}`.trim(), 'other', args?.brief),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['title', 'brief', 'session_id', 'workspace_id', 'mode', 'provider', 'model', 'reasoning_effort']);
      const sessionId = str(args, 'session_id');
      const workspaceId = str(args, 'workspace_id');
      if ((sessionId === undefined) === (workspaceId === undefined)) throw new Error('pass exactly one of session_id or workspace_id');
      const mode = args.mode ?? 'queue';
      if (mode !== 'queue' && mode !== 'steer') throw new Error('mode must be queue or steer');
      return rt.dispatch({
        leader,
        title: str(args, 'title', { required: true, max: 120 }),
        brief: str(args, 'brief', { required: true, max: 60000 }),
        sessionId, workspaceId, mode,
        model: parseModelArgs(args),
      }, exec.signal);
    }),
  });

  ctx.tools.register({
    name: 'list_models',
    description: 'List the providers and models this DSH can route to, with each model\'s reasoning efforts, and the host default model. Read-only. Use it before naming a model in dispatch_task or set_session_model.',
    parameters: objectSchema({
      provider: { type: 'string', description: 'Only this provider.' },
      query: { type: 'string', description: 'Case-insensitive substring filter on model id or name.' },
    }),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card('List models', 'read', args?.query ?? args?.provider),
    execute: (args, exec) => run(exec, async rt => {
      onlyKeys(args, ['provider', 'query']);
      return rt.listModels({ provider: str(args, 'provider', { max: 200 }), query: str(args, 'query', { max: 200 }) }, exec.signal);
    }),
  });

  ctx.tools.register({
    name: 'set_session_model',
    description: 'Change the model an existing worker session uses from its next step on (session-level; the host default model is not changed). Use only when the user asked for it. Requires user approval unless the session has full access.',
    parameters: objectSchema({
      session_id: { type: 'string', description: 'Worker session id from list_sessions.' },
      provider: { type: 'string', description: 'Provider id from list_models.' },
      model: { type: 'string', description: 'Model id from list_models.' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort supported by that model.' },
    }, ['session_id', 'provider', 'model']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card(`Set model: ${args?.model ?? ''}`.trim(), 'other', args?.session_id),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['session_id', 'provider', 'model', 'reasoning_effort']);
      return rt.setSessionModel({
        sessionId: str(args, 'session_id', { required: true, max: 200 }),
        model: parseModelArgs(args, { required: true }),
        leader,
      }, exec.signal);
    }),
  });

  ctx.tools.register({
    name: 'cancel_task',
    description: 'Stop the worker session that is running a task (cancels its current turn). Use only when the user asks to stop. Requires user approval unless the session has full access.',
    parameters: objectSchema({ task_id: { type: 'string', description: 'Task id to stop.' } }, ['task_id']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card(`Cancel task ${args?.task_id ?? ''}`.trim(), 'other'),
    execute: (args, exec) => run(exec, async (rt, leader) => {
      onlyKeys(args, ['task_id']);
      return rt.cancel({ taskId: str(args, 'task_id', { required: true, max: 32 }), leader });
    }),
  });

  ctx.tools.register({
    name: 'read_memory',
    description: `Read your memory: the ${MEMORY_FILE} file in this session's working directory. It holds what you chose to remember across conversations (user preferences, which workspace or session handles what, standing decisions). A missing file reads as empty. Read-only.`,
    parameters: objectSchema({}),
    output: { schema: OPEN_OBJECT, render },
    presentCall: () => card('Read memory', 'read', MEMORY_FILE),
    execute: (args, exec) => runLocal(exec, async () => {
      onlyKeys(args ?? {}, []);
      return readMemory(await sessionCwd(ctx, exec));
    }),
  });

  ctx.tools.register({
    name: 'write_memory',
    description: `Save to your memory, the ${MEMORY_FILE} file in this session's working directory. mode "append" (default) adds content as a new paragraph at the end; mode "replace" rewrites the whole file, so read_memory first and keep what is still true. Store durable facts only: user preferences, workspace and session roles, decisions the user made. Do not store task progress, reports, or secrets. Limit: ${MEMORY_MAX_CHARS} characters.`,
    parameters: objectSchema({
      content: { type: 'string', description: 'Markdown to append, or the complete new file for replace (an empty string clears it).' },
      mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) or replace.' },
    }, ['content']),
    output: { schema: OPEN_OBJECT, render },
    presentCall: args => card(args?.mode === 'replace' ? 'Rewrite memory' : 'Add to memory', 'edit', args?.content),
    execute: (args, exec) => runLocal(exec, async () => {
      onlyKeys(args, ['content', 'mode']);
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      return writeMemory(await sessionCwd(ctx, exec), { content: args.content, mode: args.mode ?? 'append' });
    }),
  });
}
