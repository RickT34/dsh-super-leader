// Browser half of dsh-super-leader: the settings form on the plugin's page
// (Plugins → dsh-super-leader). Plain module, no build step.
window.__ModuleLoader__.load({
  id: 'dsh-super-leader',
  factory: function (require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const PKG = 'dsh-super-leader';
    const NS = 'superLeader';
    const ENTRY_ID = 'super-leader';
    const FIELDS = ['workspaceRoots', 'workerPreset', 'fullAccessPresets', 'writeTools', 'allowTools', 'reportMaxChars'];

    const en = {
      summary: 'Leader preset: clarify, dispatch, and relay. Configure roots, approvals, and tools here.',
      intro: 'Changes apply to Leader sessions without a restart.',
      loading: 'Loading…',
      notServed: 'The super-leader plugin is not running, so its settings cannot be edited now.',
      readOnly: 'This deployment stores settings read-only.',
      loadFailed: 'Could not load options: ',
      roots: 'Workspace roots',
      rootsHint: 'create_workspace may only create directories under these paths. One absolute path per line; ~ means your home directory.',
      worker: 'Preset for new worker sessions',
      workerHint: 'Used when dispatch_task creates a session. It cannot be the Leader preset.',
      hostDefault: 'Host default',
      fullAccess: 'Skip approval under these permission presets',
      fullAccessHint: 'When the Leader session uses one of these access modes, write actions run without an approval card.',
      writeTools: 'Actions that need approval',
      writeToolsHint: 'Unchecked actions run without asking, in every access mode.',
      allowTools: 'Extra tools the Leader may use',
      allowToolsHint: 'Tools registered by other plugins are hidden from Leader sessions unless checked here.',
      filter: 'Filter tools',
      noTools: 'No other tools are registered.',
      otherTools: 'Other tool names (comma separated, for tools not loaded right now)',
      reportMax: 'Report length limit (characters)',
      reportMaxHint: 'Longer worker reports are shortened before they reach the Leader. Minimum 200.',
      overridden: 'Changed',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      unsaved: 'Unsaved changes',
      saved: 'Saved.',
      saveFailed: 'Save failed: ',
      rejected: 'The host did not accept these values.',
      badNumber: 'Enter a whole number of at least 200.',
      badRoots: 'Enter at least one absolute path (or ~/...).',
      tool_create_workspace: 'Create workspace',
      tool_dispatch_task: 'Dispatch task',
      tool_cancel_task: 'Cancel task',
    };
    const zh = {
      summary: 'Leader 预设：澄清需求、派发任务、转达结果。在这里配置根目录、审批和可用工具。',
      intro: '修改后对 Leader 会话立即生效，不需要重启。',
      loading: '加载中…',
      notServed: 'super-leader 插件当前没有运行，暂时无法修改设置。',
      readOnly: '本部署的设置为只读。',
      loadFailed: '读取选项失败：',
      roots: '工作区根目录',
      rootsHint: 'create_workspace 只能在这些目录下创建工作区。每行一个绝对路径，~ 表示你的主目录。',
      worker: '新建下属会话使用的预设',
      workerHint: 'dispatch_task 新建会话时使用，不能是 Leader 预设。',
      hostDefault: '主机默认',
      fullAccess: '这些权限预设下免审批',
      fullAccessHint: 'Leader 会话的访问模式是其中之一时，写操作不再弹出审批卡片。',
      writeTools: '需要审批的操作',
      writeToolsHint: '未勾选的操作在任何访问模式下都直接执行。',
      allowTools: 'Leader 额外可用的工具',
      allowToolsHint: '其他插件注册的工具默认对 Leader 会话隐藏，勾选后放行。',
      filter: '筛选工具',
      noTools: '没有其他插件注册的工具。',
      otherTools: '其他工具名（逗号分隔，用于当前未加载的工具）',
      reportMax: '回报长度上限（字符）',
      reportMaxHint: '超过上限的下属回报会先截断再发给 Leader。最小 200。',
      overridden: '已修改',
      reset: '恢复默认',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      unsaved: '有未保存的修改',
      saved: '已保存。',
      saveFailed: '保存失败：',
      rejected: '主机没有接受这些值。',
      badNumber: '请输入不小于 200 的整数。',
      badRoots: '请至少填写一个绝对路径（或 ~/...）。',
      tool_create_workspace: '新建工作区',
      tool_dispatch_task: '派发任务',
      tool_cancel_task: '停止任务',
    };

    function useStore(subscribe, read) {
      return React.useSyncExternalStore(subscribe, read, read);
    }
    function langOf(ctx) {
      const active = String(ctx.locale.getSnapshot?.().active ?? 'en');
      return active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }
    function makeT(ctx) {
      const dict = langOf(ctx) === 'zh' ? zh : en;
      return key => dict[key] ?? en[key] ?? key;
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

    const CSS = `
.sl-form{display:flex;flex-direction:column;gap:16px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:760px}
.sl-intro{margin:0;color:var(--dsw-alias-label-secondary)}
.sl-field{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}
.sl-head{display:flex;align-items:center;gap:8px}
.sl-label{font-weight:600}
.sl-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.sl-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.sl-grow{flex:1}
.sl-input,.sl-select,.sl-textarea{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 9px;outline:none;min-width:0}
.sl-input:focus,.sl-select:focus,.sl-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.sl-bad{border-color:var(--dsw-alias-state-error-primary)}
.sl-textarea{min-height:64px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.sl-checks{display:flex;flex-wrap:wrap;gap:6px 16px}
.sl-checks label{display:flex;align-items:center;gap:6px;cursor:pointer}
.sl-tools{max-height:220px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 14px;padding:6px 2px}
.sl-tools label{display:flex;align-items:center;gap:6px;cursor:pointer;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;min-width:0}
.sl-tools label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl-btn{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.sl-btn:disabled{opacity:.45;cursor:default}
.sl-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.sl-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:2px 6px;font-size:12px}
.sl-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.sl-msg{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.sl-msg.err{color:var(--dsw-alias-state-error-primary)}
.sl-msg.ok{color:var(--dsw-alias-state-success-primary)}
.sl-err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12.5px}
`;

    function Field({ t, label, hint, changed, onReset, disabled, error, children }) {
      return h('div', { className: 'sl-field' },
        h('div', { className: 'sl-head' },
          h('span', { className: 'sl-label' }, label),
          changed ? h('span', { className: 'sl-badge' }, t('overridden')) : null,
          h('span', { className: 'sl-grow' }),
          changed ? h('button', { type: 'button', className: 'sl-btn ghost', disabled, onClick: onReset }, t('reset')) : null),
        hint ? h('p', { className: 'sl-hint' }, hint) : null,
        children,
        error ? h('p', { className: 'sl-err' }, error) : null);
    }

    function Checks({ items, value, onChange, disabled }) {
      const set = new Set(value);
      return h('div', { className: 'sl-checks' }, items.map(item => h('label', { key: item.id },
        h('input', {
          type: 'checkbox', checked: set.has(item.id), disabled,
          onChange: event => {
            const next = new Set(set);
            if (event.target.checked) next.add(item.id); else next.delete(item.id);
            onChange(items.map(i => i.id).filter(id => next.has(id)).concat([...next].filter(id => !items.some(i => i.id === id))));
          },
        }),
        h('span', null, item.name))));
    }

    function splitList(text, pattern) {
      return text.split(pattern).map(part => part.trim()).filter(Boolean);
    }

    function ToolPicker({ t, tools, value, onChange, disabled }) {
      const [filter, setFilter] = React.useState('');
      const set = new Set(value);
      const shown = tools.filter(name => name.toLowerCase().includes(filter.trim().toLowerCase()));
      const others = value.filter(name => !tools.includes(name));
      const toggle = (name, on) => {
        const next = new Set(set);
        if (on) next.add(name); else next.delete(name);
        onChange([...next].sort());
      };
      return h(React.Fragment, null,
        tools.length === 0 ? h('p', { className: 'sl-hint' }, t('noTools')) : h(React.Fragment, null,
          h('input', { className: 'sl-input', placeholder: t('filter'), value: filter, onChange: event => setFilter(event.target.value) }),
          h('div', { className: 'sl-tools' }, shown.map(name => h('label', { key: name, title: name },
            h('input', { type: 'checkbox', checked: set.has(name), disabled, onChange: event => toggle(name, event.target.checked) }),
            h('span', null, name))))),
        h('span', { className: 'sl-hint' }, t('otherTools')),
        h(OtherTools, { value: others, disabled, onChange: list => onChange([...value.filter(name => tools.includes(name)), ...list].sort()) }));
    }

    // Free-text list that keeps the user's typing until it loses focus.
    function OtherTools({ value, onChange, disabled }) {
      const [text, setText] = React.useState(value.join(', '));
      const joined = value.join(', ');
      React.useEffect(() => { setText(current => (same(splitList(current, /[,\s]+/), value) ? current : joined)); }, [joined]);
      return h('input', {
        className: 'sl-input', value: text, disabled,
        onChange: event => setText(event.target.value),
        onBlur: () => onChange(splitList(text, /[,\s]+/)),
      });
    }

    async function loadOptions() {
      const response = await fetch(new URL('api/super-leader/options', document.baseURI), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function pick(source, key) {
      return source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
    }

    function SettingsPage({ ctx, form }) {
      useStore(cb => ctx.locale.subscribe(cb), () => ctx.locale.getSnapshot?.().revision ?? langOf(ctx));
      const t = makeT(ctx);
      const snap = useStore(cb => form.subscribe(cb), () => form.getSnapshot());
      const [options, setOptions] = React.useState(undefined);
      const [optionsError, setOptionsError] = React.useState('');
      const [draft, setDraft] = React.useState({});
      const [resets, setResets] = React.useState([]);
      const [rootsText, setRootsText] = React.useState(undefined);
      const [message, setMessage] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);

      React.useEffect(() => {
        let live = true;
        loadOptions().then(value => { if (live) setOptions(value); }, error => { if (live) setOptionsError(String(error?.message ?? error)); });
        return () => { live = false; };
      }, [snap.revision]);

      if (snap.status === 'loading') return h('p', { className: 'sl-msg' }, t('loading'));
      if (snap.status !== 'ready' || snap.value === undefined) return h('p', { className: 'sl-msg' }, t('notServed'));

      const saved = snap.value;
      const base = snap.base ?? {};
      const user = snap.user ?? {};
      const current = key => (Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : saved[key]);
      const writable = snap.writable && !saving;
      const changedFor = key => (resets.includes(key) ? false : pick(user, key) !== undefined || Object.prototype.hasOwnProperty.call(draft, key) && !same(draft[key], pick(base, key)));
      const edit = (key, value) => {
        setMessage(undefined);
        setResets(list => list.filter(item => item !== key));
        setDraft(prev => ({ ...prev, [key]: value }));
      };
      const reset = key => {
        setMessage(undefined);
        setResets(list => (list.includes(key) ? list : [...list, key]));
        setDraft(prev => ({ ...prev, [key]: clone(pick(base, key)) }));
        if (key === 'workspaceRoots') setRootsText(undefined);
      };

      const roots = rootsText ?? (current('workspaceRoots') ?? []).join('\n');
      const rootsList = splitList(roots, /\n+/);
      const rootsError = rootsList.length === 0 || rootsList.some(path => !(path.startsWith('/') || path === '~' || path.startsWith('~/'))) ? t('badRoots') : '';
      const reportValue = current('reportMaxChars');
      const reportError = !Number.isInteger(reportValue) || reportValue < 200 ? t('badNumber') : '';

      const dirtyKeys = FIELDS.filter(key => resets.includes(key) || (Object.prototype.hasOwnProperty.call(draft, key) && !same(draft[key], saved[key])));
      const dirty = dirtyKeys.length > 0;

      const save = async () => {
        if (rootsError || reportError) return;
        setSaving(true);
        setMessage(undefined);
        try {
          const ops = dirtyKeys.map(key => {
            const value = current(key);
            return resets.includes(key) || (pick(user, key) === undefined && same(value, pick(base, key)))
              ? { op: 'unset', path: [key] }
              : { op: 'set', path: [key], value };
          });
          const ok = await form.mutate(ops, snap.revision);
          if (!ok) throw new Error(t('rejected'));
          setDraft({});
          setResets([]);
          setRootsText(undefined);
          setMessage({ ok: true, text: t('saved') });
        } catch (error) {
          setMessage({ ok: false, text: t('saveFailed') + String(error?.message ?? error) });
        } finally {
          setSaving(false);
        }
      };
      const discard = () => { setDraft({}); setResets([]); setRootsText(undefined); setMessage(undefined); };

      const leaderId = options?.presetId ?? 'leader';
      const workerChoices = (options?.agentPresets ?? []).filter(row => row.id !== leaderId);
      const workerValue = current('workerPreset') ?? '';
      if (workerValue && !workerChoices.some(row => row.id === workerValue)) workerChoices.push({ id: workerValue, name: workerValue });
      const permissionChoices = options?.permissionPresets ?? (current('fullAccessPresets') ?? []).map(id => ({ id, name: id }));
      const writeChoices = (options?.leaderTools ?? ['create_workspace', 'dispatch_task', 'cancel_task']).map(id => ({ id, name: `${t(`tool_${id}`)} (${id})` }));
      const globalTools = options?.globalTools ?? [];

      return h('div', { className: 'sl-form' },
        h('style', null, CSS),
        h('p', { className: 'sl-intro' }, t('intro')),
        !snap.writable ? h('p', { className: 'sl-msg' }, t('readOnly')) : null,
        optionsError ? h('p', { className: 'sl-msg err' }, t('loadFailed') + optionsError) : null,
        dirty || message ? h('div', { className: 'sl-bar' },
          h('span', { className: `sl-msg sl-grow${message ? (message.ok ? ' ok' : ' err') : ''}` }, message ? message.text : t('unsaved')),
          dirty ? h('button', { type: 'button', className: 'sl-btn', disabled: saving, onClick: discard }, t('discard')) : null,
          dirty ? h('button', { type: 'button', className: 'sl-btn primary', disabled: !writable || Boolean(rootsError || reportError), onClick: save }, saving ? t('saving') : t('save')) : null) : null,

        h(Field, { t, label: t('roots'), hint: t('rootsHint'), changed: changedFor('workspaceRoots'), onReset: () => reset('workspaceRoots'), disabled: !writable, error: rootsError },
          h('textarea', {
            className: `sl-textarea${rootsError ? ' sl-bad' : ''}`, value: roots, disabled: !writable,
            onChange: event => { setRootsText(event.target.value); edit('workspaceRoots', splitList(event.target.value, /\n+/)); },
          })),

        h(Field, { t, label: t('worker'), hint: t('workerHint'), changed: changedFor('workerPreset'), onReset: () => reset('workerPreset'), disabled: !writable },
          h('select', { className: 'sl-select', value: workerValue, disabled: !writable, onChange: event => edit('workerPreset', event.target.value) },
            h('option', { value: '' }, options?.defaultAgentPreset ? `${t('hostDefault')} (${options.defaultAgentPreset})` : t('hostDefault')),
            workerChoices.map(row => h('option', { key: row.id, value: row.id }, row.name === row.id ? row.id : `${row.name} (${row.id})`)))),

        h(Field, { t, label: t('fullAccess'), hint: t('fullAccessHint'), changed: changedFor('fullAccessPresets'), onReset: () => reset('fullAccessPresets'), disabled: !writable },
          h(Checks, { items: permissionChoices, value: current('fullAccessPresets') ?? [], disabled: !writable, onChange: value => edit('fullAccessPresets', value) })),

        h(Field, { t, label: t('writeTools'), hint: t('writeToolsHint'), changed: changedFor('writeTools'), onReset: () => reset('writeTools'), disabled: !writable },
          h(Checks, { items: writeChoices, value: current('writeTools') ?? [], disabled: !writable, onChange: value => edit('writeTools', value) })),

        h(Field, { t, label: t('allowTools'), hint: t('allowToolsHint'), changed: changedFor('allowTools'), onReset: () => reset('allowTools'), disabled: !writable },
          h(ToolPicker, { t, tools: globalTools, value: current('allowTools') ?? [], disabled: !writable, onChange: value => edit('allowTools', value) })),

        h(Field, { t, label: t('reportMax'), hint: t('reportMaxHint'), changed: changedFor('reportMaxChars'), onReset: () => reset('reportMaxChars'), disabled: !writable, error: reportError },
          h('input', {
            className: `sl-input${reportError ? ' sl-bad' : ''}`, type: 'number', min: 200, step: 100, style: { maxWidth: 160 },
            value: Number.isFinite(reportValue) ? String(reportValue) : '', disabled: !writable,
            onChange: event => edit('reportMaxChars', event.target.value === '' ? NaN : Number(event.target.value)),
          })));
    }

    function Card({ ctx, form, view }) {
      useStore(cb => ctx.locale.subscribe(cb), () => ctx.locale.getSnapshot?.().revision ?? langOf(ctx));
      if (view === 'summary') return makeT(ctx)('summary');
      return h(SettingsPage, { ctx, form });
    }

    const inject = ['slots', 'locale', 'configForms'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'super-leader: dictionaries');
      const form = ctx.configForms.get(ENTRY_ID);
      const View = props => h(Card, { ctx, form, view: props?.view });
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PKG, locale: NS }, View)), 'super-leader: settings on the plugin page');
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${PKG}#${ENTRY_ID}`, locale: NS }, View)), 'super-leader: settings on the row page');
    }

    return { inject, apply };
  },
});
