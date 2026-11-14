// Host-plane half of dsh-super-leader: ledger, tool restriction for Leader
// sessions, the approval gate, workspace creation, dispatch, and report-back.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_FULL_ACCESS, DEFAULT_PRESET_ID, DEFAULT_WRITE_TOOLS, Ledger, LeaderError,
  leaderReport, newTaskId, planWorkspaceDirectory, resolveRoot, statusForTurnEnd,
  textOf, truncate, workerBrief,
} from './core.js';
import { runtime } from './runtime.js';

const run = promisify(execFile);

export const name = 'super-leader';
export const inject = ['agents', 'sessions', 'tools'];

export const Config = z.object({
  presetId: z.string().default(DEFAULT_PRESET_ID).description('Agent preset id treated as the Leader.'),
  allowTools: z.array(z.string()).default([]).description('Global tools (from other plugins) a Leader session may still use, e.g. dsh_im_return_file.'),
  writeTools: z.array(z.string()).default(DEFAULT_WRITE_TOOLS).description('Leader tools that require approval unless the session has full access.'),
  fullAccessPresets: z.array(z.string()).default(DEFAULT_FULL_ACCESS).description('Permission presets under which write tools run without approval.'),
  workspaceRoots: z.array(z.string()).default(['~/Work']).description('Directories under which create_workspace may create projects.'),
  workerPreset: z.string().description('Agent preset for newly created worker sessions; empty uses the host default.'),
  reportMaxChars: z.number().min(200).default(4000).description('Maximum characters of a worker report relayed to the Leader.'),
  ledgerFile: z.string().description('Ledger path; defaults to $DSH_HOME/super-leader/ledger.json.'),
});

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function presetOf(ctx, agent) {
  return ctx.get('agentPresets')?.composedPreset(agent.ctx);
}

export function apply(ctx, config) {
  const presetId = config.presetId ?? DEFAULT_PRESET_ID;
  const allowTools = new Set(config.allowTools ?? []);
  const writeTools = new Set(config.writeTools ?? DEFAULT_WRITE_TOOLS);
  const fullAccess = new Set(config.fullAccessPresets ?? DEFAULT_FULL_ACCESS);
  const reportMax = config.reportMaxChars ?? 4000;
  const ledger = new Ledger(config.ledgerFile || join(dshHome(), 'super-leader', 'ledger.json'));
  const ready = ledger.load();
  const isLeader = agent => agent !== undefined && presetOf(ctx, agent) === presetId;

  // ── tool restriction ─────────────────────────────────────────────────────
  // Every global tool not in allowTools is denied for Leader agents. Tools the
  // preset itself mounts are scoped registrations and stay visible.
  // Candidates come from the global view (no scope): exactly the names
  // `tools.restrict` accepts, minus nothing the preset registers itself.
  const restricted = new Map(); // agent -> Set of denied names
  function denyGlobals(agent) {
    if (!isLeader(agent)) return;
    let denied = restricted.get(agent);
    if (denied === undefined) { denied = new Set(); restricted.set(agent, denied); }
    const globals = [...ctx.tools.view(undefined).visible.keys()];
    const fresh = globals.filter(name => !allowTools.has(name) && !denied.has(name) && name !== 'run_code');
    if (fresh.length === 0) return;
    // Mark first: restrict() emits tools/change synchronously, which re-enters here.
    for (const name of fresh) denied.add(name);
    try {
      agent.ctx.tools.restrict({ deny: fresh });
    } catch (error) {
      for (const name of fresh) denied.delete(name);
      ctx.logger.warn(`super-leader: could not restrict tools for ${agent.id}: ${error?.message ?? error}`);
    }
  }

  ctx.on('agent/created', ({ agent }) => { denyGlobals(agent); });
  ctx.on('agent-preset/selected', sessionId => {
    const agent = ctx.agents.get(sessionId);
    if (agent !== undefined) queueMicrotask(() => denyGlobals(agent));
  });
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.roots()) if (isLeader(agent)) denyGlobals(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => { restricted.delete(agent); });

  // ── approval gate ────────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent;
    if (agent === undefined || !writeTools.has(exec.name) || !isLeader(agent)) return next();
    const permission = ctx.get('permissionPresets')?.current(agent.session);
    if (permission !== undefined && fullAccess.has(permission)) return next();
    const downstream = await next();
    if (downstream.kind !== 'allow') return downstream;
    return {
      kind: 'ask',
      reason: `Leader action "${exec.name}" requires approval`,
      displayReason: displayReasonFor(exec),
    };
  }, { prepend: true });

  // ── report-back ──────────────────────────────────────────────────────────
  // requestId -> taskId for prompts in flight; sessionId -> { taskId, turn }
  const pendingByRequest = new Map();
  const activeTurn = new Map();

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const rpcId = event.data?.source?.rpcId;
      const taskId = rpcId === undefined ? undefined : pendingByRequest.get(rpcId);
      if (taskId === undefined) return;
      pendingByRequest.delete(rpcId);
      const turn = ctx.agents.turnBoundaryOf(session).lastTurn;
      activeTurn.set(session.id, { taskId, turn });
      void ledger.updateTask(taskId, { status: 'running', startedAt: new Date(event.time).toISOString(), turn });
      return;
    }
    if (event.type !== 'turn/end') return;
    const active = activeTurn.get(session.id);
    if (active === undefined || event.data?.turn !== active.turn) return;
    activeTurn.delete(session.id);
    void finishTask(session, active.taskId, event).catch(error => {
      ctx.logger.warn(`super-leader: reporting task ${active.taskId} failed: ${error?.message ?? error}`);
    });
  });

  async function finishTask(session, taskId, event) {
    const status = statusForTurnEnd(event.data?.reason?.kind);
    let report = '';
    for (const candidate of [...session.snapshotEvents()].reverse()) {
      if (candidate.seq >= event.seq) continue;
      if (candidate.type === 'turn/start') break;
      if (candidate.type === 'assistant/message') {
        report = textOf(candidate.data?.message?.content);
        if (report) break;
      }
    }
    if (status === 'failed' && event.data?.reason?.error?.message) {
      report = `${report}\n\nError: ${event.data.reason.error.message}`.trim();
    }
    report = truncate(report, reportMax);
    const task = await ledger.updateTask(taskId, { status, report, finishedAt: new Date(event.time).toISOString() });
    if (task === undefined) return;
    await notifyLeader(task, status, report);
  }

  // Deliver the report as an agent-to-agent relay message (the same source
  // shape DSH subagents use), so the UI shows it as an agent trigger rather
  // than as something the user typed. Queued: it wakes an idle Leader and
  // waits for a busy one to finish its turn.
  async function notifyLeader(task, status, report) {
    const controller = ctx.get('sessionController');
    if (controller === undefined) return;
    try {
      const resolved = await ctx.agents.withoutInitiator(() => controller.resolveAgent(task.leaderSessionId));
      if ('error' in resolved) throw resolved.error;
      const leader = resolved.agent;
      leader.followup(relayMessage(task.sessionId, leaderReport({ task, status, report })));
      await ctx.sessions.flush(leader.session);
      await ledger.updateTask(task.id, { reportedAt: new Date().toISOString() });
    } catch (error) {
      ctx.logger.warn(`super-leader: could not deliver report for ${task.id} to ${task.leaderSessionId}: ${error?.message ?? error}`);
    }
  }

  // ── service used by the tools ────────────────────────────────────────────
  const service = {
    async listWorkspaces() {
      await ready;
      const registry = requireService('workspaceRegistry');
      return {
        workspaces: registry.list().map(ws => ({
          id: ws.id,
          title: ws.title,
          path: ws.path,
          sessions: ws.sessionIds.length,
          purpose: ledger.workspaceNote(ws.path)?.purpose ?? null,
        })),
      };
    },

    async listSessions({ workspaceId, query, limit, leader }, signal) {
      await ready;
      const controller = requireService('sessionController');
      const registry = ctx.get('workspaceRegistry');
      const archived = new Set(registry?.archivedSessionIds ?? []);
      const byPath = new Map();
      const bySession = new Map();
      for (const ws of registry?.list() ?? []) {
        byPath.set(ws.path, ws);
        for (const id of ws.sessionIds) bySession.set(id, ws);
      }
      let filterIds;
      if (workspaceId !== undefined) {
        const ws = registry?.get(workspaceId);
        if (ws === undefined) throw new LeaderError('workspace_not_found', `Unknown workspace ${workspaceId}; call list_workspaces.`);
        filterIds = new Set(ws.sessionIds);
      }
      const latest = new Map();
      for (const task of ledger.tasks()) {
        const prev = latest.get(task.sessionId);
        if (prev === undefined || prev.createdAt < task.createdAt) latest.set(task.sessionId, task);
      }
      const { items } = await controller.list({}, signal ?? new AbortController().signal);
      const needle = query?.toLowerCase();
      const rows = [];
      for (const item of items) {
        if (item.parentSessionId !== undefined || item.origin === 'subagent' || item.blank) continue;
        if (archived.has(item.sessionId) || item.sessionId === leader.id) continue;
        if (filterIds !== undefined && !filterIds.has(item.sessionId)) continue;
        const ws = bySession.get(item.sessionId) ?? (item.cwd ? byPath.get(item.cwd) : undefined);
        const title = item.projections?.values?.title ?? null;
        const preset = item.projections?.values?.agentPreset ?? null;
        if (needle && !(`${title ?? ''} ${item.cwd ?? ''}`.toLowerCase().includes(needle))) continue;
        const task = latest.get(item.sessionId);
        rows.push({
          id: item.sessionId,
          title,
          workspace_id: ws?.id ?? null,
          workspace: ws?.title ?? null,
          cwd: item.cwd ?? null,
          running: item.running,
          updated: new Date(item.updatedAt).toISOString(),
          ...(preset === presetId ? { leader: true } : {}),
          ...(task ? { last_task: { id: task.id, title: task.title, status: task.status } } : {}),
        });
        if (rows.length >= limit) break;
      }
      return { sessions: rows, truncated: rows.length >= limit };
    },

    async taskStatus({ taskId, includeReport, leader }) {
      await ready;
      const view = (task, full) => ({
        id: task.id, title: task.title, status: task.status,
        session_id: task.sessionId, workspace: task.workspacePath ?? null,
        created: task.createdAt, finished: task.finishedAt ?? null,
        ...(full ? { brief: task.brief, report: task.report ?? null } : {}),
      });
      if (taskId !== undefined) {
        const task = ledger.task(taskId);
        if (task === undefined) throw new LeaderError('task_not_found', `Unknown task ${taskId}.`);
        const agent = ctx.agents.get(task.sessionId);
        return { task: { ...view(task, true), worker_running: agent?.status === 'running' } };
      }
      const tasks = ledger.tasks().filter(task => task.leaderSessionId === leader.id)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30);
      return { tasks: tasks.map(task => view(task, includeReport)) };
    },

    async createWorkspace(input, signal) {
      await ready;
      const registry = requireService('workspaceRegistry');
      const root = resolveRoot(config.workspaceRoots ?? ['~/Work'], input.root);
      await mkdir(root, { recursive: true });
      const plan = await planWorkspaceDirectory({
        root, name: input.name, registerExisting: input.registerExisting,
        isRegistered: async path => (await registry.resolveByPath(path)) !== undefined,
      });
      if (plan.action === 'exists-registered') {
        const ws = await registry.resolveByPath(plan.path);
        await ledger.setWorkspaceNote(ws.path, { purpose: input.purpose });
        return { created: false, workspace: { id: ws.id, title: ws.title, path: ws.path }, note: 'The directory was already a workspace; its purpose note was updated.' };
      }
      const steps = [];
      if (plan.action === 'create') {
        if (input.gitCloneUrl !== undefined) {
          if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(input.gitCloneUrl)) throw new LeaderError('invalid_url', 'git_clone_url must be an https, ssh, or git@ URL.');
          await run('git', ['clone', '--', input.gitCloneUrl, plan.path], { signal, timeout: 600000 });
          steps.push('cloned');
        } else {
          await mkdir(plan.path, { recursive: false });
          steps.push('created directory');
          if (input.gitInit) { await run('git', ['init'], { cwd: plan.path, signal, timeout: 60000 }); steps.push('git init'); }
        }
      }
      if (input.writeAgentsMd) {
        const file = join(plan.path, 'AGENTS.md');
        const exists = await access(file).then(() => true, () => false);
        if (!exists) {
          await writeFile(file, `# ${input.title ?? input.name}\n\n${input.purpose.trim()}\n`, { flag: 'wx' });
          steps.push('wrote AGENTS.md');
        }
      }
      const ws = await registry.create(plan.path, input.title ?? input.name);
      await ledger.setWorkspaceNote(ws.path, { purpose: input.purpose });
      return { created: plan.action === 'create', workspace: { id: ws.id, title: ws.title, path: ws.path }, steps };
    },

    async dispatch({ leader, title, brief, sessionId, workspaceId, mode }, signal) {
      await ready;
      const controller = requireService('sessionController');
      const registry = ctx.get('workspaceRegistry');
      let targetId = sessionId;
      let workspace;
      let created = false;
      if (sessionId !== undefined) {
        if (sessionId === leader.id) throw new LeaderError('self_target', 'A Leader cannot dispatch to itself.');
        if (registry?.archivedSessionIds.includes(sessionId)) throw new LeaderError('archived', `Session ${sessionId} is archived.`);
        const resolved = await controller.resolveAgent(sessionId);
        if ('error' in resolved) throw new LeaderError('session_not_found', `Session ${sessionId} cannot be opened: ${resolved.error?.message ?? resolved.error}`);
        if (isLeader(resolved.agent)) throw new LeaderError('leader_target', 'Tasks cannot be dispatched to another Leader session.');
        workspace = registry?.list().find(ws => ws.sessionIds.includes(sessionId));
      } else {
        workspace = registry?.get(workspaceId);
        if (workspace === undefined) throw new LeaderError('workspace_not_found', `Unknown workspace ${workspaceId}; call list_workspaces.`);
        const workerPreset = config.workerPreset || undefined;
        const defaultPreset = ctx.get('agentPresets')?.defaultId;
        if ((workerPreset ?? defaultPreset) === presetId) {
          throw new LeaderError('worker_is_leader', `Worker sessions would use the Leader preset. Set super-leader.workerPreset to another preset.`);
        }
        const result = await ctx.agents.withoutInitiator(() => controller.create({
          workspaceId,
          ...(workerPreset ? { agentPreset: workerPreset } : {}),
        }));
        targetId = result.sessionId;
        created = true;
      }
      const taskId = newTaskId(ledger.taskIds());
      const requestId = `super-leader-${taskId}-${randomUUID()}`;
      const now = new Date().toISOString();
      await ledger.putTask({
        id: taskId, title, brief, status: 'queued', sessionId: targetId,
        leaderSessionId: leader.id, workspacePath: workspace?.path ?? null,
        createdAt: now, updatedAt: now, requestId,
      });
      pendingByRequest.set(requestId, taskId);
      try {
        await ctx.agents.withoutInitiator(() => controller.prompt({
          requestId, sessionId: targetId, mode,
          content: [{ type: 'text', text: workerBrief({ taskId, title, brief, leaderSessionId: leader.id }) }],
        }, signal ?? new AbortController().signal));
      } catch (error) {
        pendingByRequest.delete(requestId);
        await ledger.updateTask(taskId, { status: 'failed', report: `Delivery failed: ${error?.message ?? error}` });
        throw new LeaderError('delivery_failed', `Could not deliver the task to ${targetId}: ${error?.message ?? error}`);
      }
      if (created) {
        try { await controller.rename({ sessionId: targetId, title: `${taskId} ${title}`.slice(0, 120) }); } catch { /* title is cosmetic */ }
      }
      return {
        task_id: taskId, session_id: targetId, created_session: created,
        workspace: workspace ? { id: workspace.id, title: workspace.title, path: workspace.path } : null,
        note: 'The worker is running. You will receive a "[Leader report]" message when its turn ends. Tell the user the task was dispatched; do not poll.',
      };
    },

    async cancel({ taskId, leader }) {
      await ready;
      const task = ledger.task(taskId);
      if (task === undefined) throw new LeaderError('task_not_found', `Unknown task ${taskId}.`);
      if (task.leaderSessionId !== leader.id) throw new LeaderError('not_owner', `Task ${taskId} belongs to another Leader session.`);
      const agent = ctx.agents.get(task.sessionId);
      if (agent === undefined || agent.status !== 'running') {
        return { cancelled: false, status: task.status, note: 'The worker is not running.' };
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      return { cancelled: true, task_id: taskId, session_id: task.sessionId };
    },
  };

  function requireService(name) {
    const value = ctx.get(name);
    if (value === undefined) throw new LeaderError('unavailable', `The "${name}" service is not available in this profile.`);
    return value;
  }

  ctx.effect(() => {
    runtime.current = service;
    return () => { if (runtime.current === service) runtime.current = undefined; };
  }, 'super-leader runtime');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A user-role relay message, shaped like DSH's own agent-to-agent messages. */
function relayMessage(senderSessionId, text) {
  return deepFreeze({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  });
}

function displayReasonFor(exec) {
  const args = exec.arguments ?? {};
  switch (exec.name) {
    case 'dispatch_task': {
      const target = args.session_id ? `会话 ${args.session_id}` : `工作区 ${args.workspace_id} 中的新会话`;
      const targetEn = args.session_id ? `session ${args.session_id}` : `a new session in workspace ${args.workspace_id}`;
      return {
        en: `Leader wants to dispatch "${args.title}" to ${targetEn}.\n\n${args.brief ?? ''}`,
        'zh-cn': `Leader 要把任务「${args.title}」派发给${target}。\n\n${args.brief ?? ''}`,
      };
    }
    case 'create_workspace':
      return {
        en: `Leader wants to create workspace "${args.name}"${args.git_clone_url ? ` by cloning ${args.git_clone_url}` : ''}.\nPurpose: ${args.purpose ?? ''}`,
        'zh-cn': `Leader 要创建工作区「${args.name}」${args.git_clone_url ? `（克隆 ${args.git_clone_url}）` : ''}。\n用途：${args.purpose ?? ''}`,
      };
    case 'cancel_task':
      return { en: `Leader wants to stop task ${args.task_id}.`, 'zh-cn': `Leader 要停止任务 ${args.task_id}。` };
    default:
      return { en: `Leader wants to run ${exec.name}.`, 'zh-cn': `Leader 要执行 ${exec.name}。` };
  }
}
