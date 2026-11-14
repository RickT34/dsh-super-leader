# dsh-super-leader 设计文档

## 目标

在 DSH 里提供一个 **Leader（领导）Agent 预设**。用户新建会话时选择 Leader 预设，这个会话就只负责：

1. 和用户讨论清楚需求（主动、积极地提问）；
2. 选择或新建合适的工作区与会话；
3. 把任务简报派发给下属会话；
4. 收到下属的完成回报后整理给用户。

Leader 不读代码、不改文件，只使用本插件提供的少量工具。

第一版不包含 IM 集成。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| Host 插件 `dsh-super-leader` | 主机平面，`src/host.js` | 任务台账、审批闸门、Leader 工具白名单、下属完成回报 |
| 工具插件 `dsh-super-leader/tools` | 只挂在 Leader 预设内，`src/tools.js` | 注册 Leader 工具 |
| Leader 预设 `leader` | `cordis.patch.yml` | persona + 时间上下文 + 上下文压缩 + `ask_user_question` + Leader 工具 |

## 只用我们提供的工具

预设只决定"挂哪些插件"。其他插件注册在全局的工具（mnemon、MCP、IM 等）仍然对所有会话可见。因此 Host 插件在 Leader 会话的 Agent 创建时（`agent/created`），以及会话改选为 Leader 预设时（`agent-preset/selected`），对该 Agent 的作用域调用：

```js
agent.ctx.tools.restrict({ deny: <所有全局工具 − allowTools> })
```

之后有新的全局工具注册（例如 MCP 晚到），会在 `tools/change` 时追加 deny。预设内注册的工具（Leader 工具、`ask_user_question`）不是全局工具，不受影响。

`allowTools` 可配置，用来放行个别全局工具。

## 工具

| 工具 | 类型 | 说明 |
|---|---|---|
| `list_workspaces` | 读 | 列出已登记工作区：id、标题、路径、会话数、用途说明 |
| `list_sessions` | 读 | 列出会话：id、标题、所在工作区、是否运行中、最近更新时间、最近任务 |
| `read_session` | 读 | 从会话事件日志生成摘要：最近几轮的请求与回复、更早请求的首行、压缩摘要、待办清单、写过的文件、本 Leader 派给它的任务 |
| `task_status` | 读 | 查看本 Leader 派发过的任务及回报 |
| `create_workspace` | 写 | 在允许的根目录下新建目录（可选 `git clone` / `git init` / 写 `AGENTS.md`），并登记为工作区 |
| `dispatch_task` | 写 | 派发任务：发给已有会话，或在指定工作区新建会话再发 |
| `cancel_task` | 写 | 停止下属会话当前正在执行的轮次 |

## 审批规则

写类工具在执行前经过 `tools/pre-execute` 闸门：

- Leader 会话的权限预设属于 `fullAccessPresets`（默认 `danger-full-access`，即"完全权限"）时：直接执行。
- 其他情况：返回 `ask`，弹出审批卡片；用户"批准一次"才执行，拒绝则模型收到拒绝原因。

为什么不能直接用 DSH 默认审批：完全权限的审批策略是 `never`，在 DSH 中意味着"需要审批的操作一律拒绝"，与需求相反。所以由本插件自己判断。

审批卡片的标题写明目标；展开内容就是下属会收到的任务简报原文。

## 派发与回报

1. `dispatch_task` 生成任务 ID（如 `T-3f9a`），写入台账。
2. 新会话：`sessionController.create({ workspaceId, agentPreset: workerPreset })`，再用任务标题重命名。
3. 通过 `sessionController.prompt` 把"任务简报 + 回报要求"作为用户消息投递（`queue` 或 `steer`）。
4. Host 插件监听下属会话事件：
   - 看到带本任务 `requestId` 的 `user/message` 时，记下当时所在的轮次号；
   - 该轮次的 `turn/end` 到达时，取这一轮最后一条助手消息的文字作为回报（截断到 `reportMaxChars`）。
5. 回报以 `[Leader report]` 开头，作为 agent 间转发消息（`source.kind = agent-message`，`form = relay`，与 DSH 子代理消息同形）`followup` 给 Leader 会话。界面上显示为 “Task message received”，不会冒充用户发言。Leader 空闲时被唤醒；忙时排队到当前轮次之后。

轮次结束原因映射：`completed→completed`、`aborted→cancelled`、`error→failed`、`blocked→blocked`。

## 续派任务

- Leader 续用已有会话前先调用 `read_session`，简报只写下一步：新需求、变化、用户的决定、完成标准，不重述项目。
- 已经收到过 Leader 任务的会话，续派时只附一行回报格式提示，不再附完整的回报模板。
- `list_sessions` 每行附带最近一次请求的首行，作为路由线索。

## 防止递归

- 不允许把任务派给 Leader 预设的会话，也不允许派给自己。
- `workerPreset` 不能是 Leader 预设；未配置时如果主机默认预设就是 Leader，也拒绝。

## 新建工作区的安全边界

- 只能在 `workspaceRoots`（默认 `~/Work`）下创建；目录名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
- 目录已存在：已登记就直接返回该工作区；未登记且非空则报错，除非传 `register_existing: true`。
- 不提供删除或归档工作区的能力。

## 台账

`$DSH_HOME/super-leader/ledger.json`（原子写入）：

```json
{ "version": 1, "tasks": { "T-3f9a": { ... } }, "workspaces": { "/abs/path": { "purpose": "..." } } }
```

## 配置（Host 插件 `super-leader` 行）

| 字段 | 默认 | 含义 |
|---|---|---|
| `presetId` | `leader` | Leader 预设 id |
| `allowTools` | `[]` | Leader 额外可用的全局工具 |
| `writeTools` | `create_workspace, dispatch_task, cancel_task` | 需要审批的工具 |
| `fullAccessPresets` | `[danger-full-access]` | 视为完全权限、免审批的权限预设 |
| `workspaceRoots` | `[~/Work]` | 允许新建工作区的根目录 |
| `workerPreset` | 空（主机默认） | 新建下属会话使用的预设 |
| `reportMaxChars` | `4000` | 回报截断长度 |

## 已知限制（第一版）

- 下属在一轮中向用户提问或等待审批时，Leader 不会收到通知，只在该轮结束时收到回报。
- DSH 重启时正在运行的任务，状态会停在 `running`，需要用户或 Leader 用 `task_status` / `list_sessions` 自行判断。
- 其他插件的系统提示片段可能仍提到被隐藏的工具。
