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
| Leader 预设 `leader` | `cordis.patch.yml` | persona + AGENTS.md 指令 + 时间上下文 + 上下文压缩 + `ask_user_question` + Leader 工具 |

## 只用我们提供的工具

预设只决定"挂哪些插件"。其他插件注册在全局的工具（记忆、MCP、IM 等）仍然对所有会话可见。因此 Host 插件在 Leader 会话的 Agent 创建时（`agent/created`），以及会话改选为 Leader 预设时（`agent-preset/selected`），对该 Agent 的作用域调用：

```js
agent.ctx.tools.restrict({ deny: <所有全局工具 − allowTools> })
```

之后有新的全局工具注册（例如 MCP 晚到），会在 `tools/change` 时追加 deny。预设内注册的工具（Leader 工具、`ask_user_question`）不是全局工具，不受影响。

`allowTools` 可配置，用来显式放行全局工具，默认空列表，不按插件或工具名预置豁免。设置变化重建限制时要防同步 `tools/change` 重入，避免残留旧 deny 层导致工具重新放行后仍不可见。

## 外部记忆系统配置

本插件不绑定任何记忆系统。用户在 profile 中启用自己的记忆插件，再通过通用 `allowTools` 设置手动开放其工具。Web 设置页直接展示当前注册的全局工具，也可输入尚未加载的工具名；记忆工具与其他外部工具使用同一过滤逻辑，没有专用开关、硬编码名单或锁定勾选。

记忆系统自行管理实例、数据、存储范围、权限和上下文协议；Leader 不注册代理记忆工具、不调用内部管理接口、不复制记忆协议，也不在 preset 中重复挂载其主机服务。若外部写工具需要经过 Leader 审批，用户可把工具名加入 `writeTools`；原插件的权限仍然有效。

README 中以 Mnemon 的 `mnemon_runtime_memory`、`mnemon_document_search`、`mnemon_recall` 举例，实际工具选择由用户决定。工具放行不等于 Source Route 获授权：例如 Mnemon recall 仍需活动可搜索的 Memory Space 和本轮 View 的路由/ReadGrant；原插件未提供时，Leader 不能通过白名单绕过。

## 工具

| 工具 | 类型 | 说明 |
|---|---|---|
| `list_workspaces` | 读 | 列出已登记工作区：id、标题、路径、会话数、用途说明 |
| `list_sessions` | 读 | 列出会话：id、标题、所在工作区、是否运行中、最近更新时间、最近任务 |
| `read_session` | 读 | 从会话事件日志生成摘要：最近几轮的请求与回复、更早请求的首行、压缩摘要、待办清单、写过的文件、本 Leader 派给它的任务 |
| `task_status` | 读 | 查看本 Leader 派发过的任务及回报 |
| `create_workspace` | 写 | 在允许的根目录下新建目录（可选 `git clone` / `git init` / 写 `AGENTS.md`），并登记为工作区 |
| `dispatch_task` | 写 | 派发任务：发给已有会话，或在指定工作区新建会话再发 |
| `list_models` | 读 | 列出 `llm` 服务能路由的服务商和模型，附推理强度和主机默认模型 |
| `set_session_model` | 写 | 改已有下属会话的模型（会话级，不改主机默认） |
| `cancel_task` | 写 | 停止下属会话当前正在执行的轮次 |
| `read_memory` | 读 | 读取会话工作目录下的 `MEMORY.md`，不存在时返回空内容 |
| `write_memory` | 写（免审批） | 追加或整体重写 `MEMORY.md`，原子写入（临时文件 + rename），上限 32,000 字符 |

记忆工具在 `src/memory.js`，不依赖宿主插件：工作目录取自 `workingDirectory` 服务（`agent-instructions` 已依赖它），缺失时退回会话头的 `cwd`。它只写 Leader 自己目录下的这一个文件，所以默认不在 `writeTools` 候选里。人格提示第 10 条要求对话开始时读一次，只存偏好、工作区/会话分工和用户决定，不存任务进度、回报和密钥。

## 审批规则

需要审批的工具集合 = `writeTools`（未保存时用默认值）∪ `ADDED_WRITE_TOOLS`。

- `ORIGINAL_WRITE_TOOLS` = `create_workspace`、`dispatch_task`、`cancel_task`，是最初设计时的写工具，老用户自己保存的 `writeTools` 列表就是从这几个里选的。
- `ADDED_WRITE_TOOLS` = `set_session_model`，是之后新增的写工具。老用户保存的列表里没有它；如果只按保存的列表判断，改模型会绕过审批。所以它总是并入，保存的列表本身不被改写，用户对原有三个工具的取舍也保留。
- 代价：通过 `writeTools` 无法取消 `set_session_model` 的审批，设置页上它的勾选框锁定为勾选。完全权限下仍然免审批。

写类工具在执行前经过 `tools/pre-execute` 闸门：

- Leader 会话的权限预设属于 `fullAccessPresets`（默认 `danger-full-access`，即"完全权限"）时：直接执行。
- 其他情况：返回 `ask`，弹出审批卡片；用户"批准一次"才执行，拒绝则模型收到拒绝原因。

为什么不能直接用 DSH 默认审批：完全权限的审批策略是 `never`，在 DSH 中意味着"需要审批的操作一律拒绝"，与需求相反。所以由本插件自己判断。

`reason` 与 `displayReason` 使用同一次目标查询，承担不同的展示职责：

- `reason` 保留原英文前缀 `Leader action "dispatch_task" requires approval`，后接单行摘要「工作区：名称（完整路径）；会话：标题（完整 id）/新建会话；状态：空闲/排队 (queue)/注入当前轮次 (steer)」。`set_session_model` 同样附会话和工作区摘要。标题最多 64 字符，换行、制表和控制字符压成空格；不包含 brief。查询失败时沿用原英文说明。
- 这是给只读取 `reason` 的客户端（如 dsh-im 的微信审批）用的；微信可能把换行显示成 `\n`，因此摘要不依赖换行。`reason` 会被 DSH 写进 `approval/asked`，所以只放紧凑目标，不重复保存整份任务简报。
- `displayReason` 的中英内容保持原样，Web 仍显示下面的多行详情和完整 brief。
- 审批响应继续按 `approvalId`（及会话/调用关联）匹配。DSH 日志的 `approval/asked` / `approval/decided` 共享同一个 id；dsh-im 的 `HarnessApprovalQueue.submitByApprovalId()` 查 id，不比较 reason，摘要不参与授权判断。

审批卡片（`displayReason`）先写目标，再写简报原文：

- `dispatch_task`：第一行是类型标签【继续已有会话】/【新建会话】和任务标题；随后是「工作区：名称（路径）」、「会话：标题（session id）」或「会话：新建会话」；已有会话还有「状态」行：空闲 / 正在运行且排队（queue）/ 正在运行且注入当前轮次（steer）；指定了模型时有「模型」行。工作区或会话找不到时，卡片直接写明派发会失败。
- `set_session_model`：目标会话的标题和 id、所在工作区、当前模型和新模型。
- 这些信息在审批闸门里异步查出（工作区登记表、会话日志里的标题、Agent 运行状态），查询失败时退回只含参数的简单文本。
- 审批卡片换行（保留，有意依赖 DSH 内部实现）：
  - 问题：DSH 的审批卡片把 `displayReason` 渲染成卡片标题，标题元素的样式没有 `white-space`，文本里的换行会被合并成一段。DSH 没有提供让插件给审批卡片加正文、加结构或改样式的接口（`conversation.approval.detail` 槽位是单例，已被聊天插件用来显示 bash 命令）。
  - 做法：浏览器端插件（`client/client.js`）在页面加载时向 `document.head` 插入一个 `<style data-super-leader="approval">`，内容是 `[data-approval-key] [class*="_headline"]{white-space:pre-line}`；插件卸载时移除。
  - 依赖：`data-approval-key` 是审批卡片根元素上的属性；`_headline` 匹配 `@deepseek-ai/dsh-client-ui-approval` 的 CSS Module 生成的标题类名，在 DSH 0.2.2-rc.1 中是 `mna1RW_headline`。前缀 `mna1RW_` 是构建时生成的哈希，所以用 `class*="_headline"` 匹配后缀。这两个都是 DSH 内部实现，不是公开接口，DSH 升级时可能改变。
  - 影响范围：作用于所有审批卡片的标题，不只是 Leader 的。其他插件的审批文本通常是一行，没有换行，显示不变；如果其他插件的审批文本本身带换行，现在也会按行显示。
  - 回退：类名或属性改了，选择器就不再命中，卡片退回成一段文字显示。目标、会话、状态这些信息仍在标题开头，顺序不变，只是不分行；审批功能本身不受影响，不会报错。
  - 检查方法：DSH 升级后发起一次 `dispatch_task` 审批，看卡片是否分行；不分行时在浏览器开发者工具里查看审批卡片标题的类名，按新类名更新选择器。
- `workspace_id` 接受工作区 id 或唯一的工作区标题；`list_sessions`、`dispatch_task` 和审批卡片用同一个解析函数。

## 派发与回报

1. `dispatch_task` 生成任务 ID（如 `T-3f9a`），写入台账。
2. 新会话：`sessionController.create({ workspaceId, agentPreset: workerPreset })`，再用任务标题重命名。
3. 通过 `sessionController.prompt` 把"任务简报 + 回报要求"作为用户消息投递（`queue` 或 `steer`）。
4. Host 插件监听下属会话事件：
   - 看到带本任务 `requestId` 的 `user/message` 时，记下当时所在的轮次号；
   - 该轮次的 `turn/end` 到达时，取这一轮最后一条助手消息的文字作为回报（截断到 `reportMaxChars`）。
5. 回报以 `[Leader report]` 开头，作为 agent 间转发消息（`source.kind = agent-message`，`form = relay`，与 DSH 子代理消息同形）`followup` 给 Leader 会话。界面上显示为 “Task message received”，不会冒充用户发言。Leader 空闲时被唤醒；忙时排队到当前轮次之后。

轮次结束原因映射：`completed→completed`、`aborted→cancelled`、`error→failed`、`blocked→blocked`。

## 启动与恢复对账

插件启动、`sessionQuery` 服务恢复时扫描 `queued` / `running`；每次 `task_status` 也重试对账。并发请求合并成一次扫描。判断以任务消费时的轮次为单位，不能用「worker 现在忙不忙」替代：worker 可能正在做更晚的任务。

- 日志有该轮 `turn/end`：按 completed / aborted / error / blocked / interrupted 恢复真实终态，并记录原结束时间。日志里还在的最终助手回复可以恢复为 `reportSource: recovered-from-log`，不是伪造一份新报告。
- 原轮次仍在跑：重新挂接该轮跟踪，保留 running。同一轮可以跟踪多条任务，每条收尾一次。
- 未消费的请求仍在持久 inbox：保持 queued、恢复 requestId 跟踪。折叠 `agent/inbox/spliced` 的 next-turn / next-step，并识别先于 user/message 的 claim，避免漏掉 pre-step 失败。
- 无结束记录且原轮已不在跑，或请求既没消费也不在 inbox，或明确返回 `SESSION_QUERY_SESSION_NOT_FOUND`：标 `interrupted`，`report_state: lost`；不推断工作完成，也不把未知结束时间伪装成当前时间。
- 暂时读不到日志：不强行收终态，保留状态和 `reconciliation_error`；下次查询或插件恢复时重试。
- 本进程仍在异步投递的任务暂不对账，防止正常的 prompt admission 窗口被误判为请求丢失。异步读日志之后若会话已经加载，要同步重读 live 日志和轮次状态后再安装跟踪。

`task_status` 总是返回 `report_state`、`report_missing`，对账过的记录附 `reconciled.at/reason` 和解释 `note`。状态 completed 只说明该执行轮次正常结束，不代表人工验收通过。报告状态：pending（未结束）、delivered（已送给 Leader）、undelivered（现场捕获但未投递成功）、recovered（当时投递丢失，后来从日志恢复文本）、lost（没有可恢复的报告）。后面三种均 `report_missing: true`，列表模式也可见，不能只展示 completed。

对账不会重新执行任务、唤醒旧 worker 或自动补发报告。中断任务的部分文件可能仍在，需要用户另行决定是否继续；恢复的报告可通过 task_status 主动读取。这样避免自动重放造成重复改动、重复 IM 通知。

## 续派任务

- Leader 续用已有会话前先调用 `read_session`，简报只写下一步：新需求、变化、用户的决定、完成标准，不重述项目。
- 已经收到过 Leader 任务的会话，续派时只附一行回报格式提示，不再附完整的回报模板。
- `list_sessions` 每行附带最近一次请求的首行，作为路由线索。

## 模型

- 读取：会话已加载时用 `agent.model.current()`；否则从事件日志推算，规则与 DSH 的 `modelSelection` 投影相同：`model/selection` 记录待生效的选择，之后的 `request/header` 记录实际使用的模型。
- 校验：与 DSH 模型选择器相同，服务商必须存在、模型在 `llm.listModels()` 里，并通过 `llm.resolveCallConfig()`（会拒绝该模型不支持的推理强度）。
- 写入：`agent.model.select()`，写入 `model/selection` 事件。没有用 `sessionController.selectModel()`，因为它还会把选择保存为主机默认模型。
- `dispatch_task` 指定模型时：新会话在 `create` 之后、发送简报之前写入；已有会话若正在运行则拒绝，避免改到它当前这一轮。
- 不能改自己（Leader）或其他 Leader 会话的模型。

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

除 `presetId` 和 `ledgerFile` 外，其余字段都声明为 volatile，由浏览器端插件（`client/client.js`）在插件页的 `plugins.bundle.config` 槽位渲染设置表单，通过 DSH 的 `configForms` 写回 profile 补丁，运行中直接生效。`allowTools` 变化时，主机插件撤销并重建 Leader 会话的工具屏蔽；每一步开始前也会重新检查。表单的下拉和勾选项来自 `GET /api/super-leader/options`（Agent 预设、权限预设、当前全局工具）。

| 字段 | 默认 | 含义 |
|---|---|---|
| `presetId` | `leader` | Leader 预设 id |
| `allowTools` | `[]` | Leader 额外可用的全局工具 |
| `writeTools` | `create_workspace, dispatch_task, cancel_task, set_session_model` | 需要审批的工具；实际生效的是保存的列表与 `set_session_model` 的并集 |
| `fullAccessPresets` | `[danger-full-access]` | 视为完全权限、免审批的权限预设 |
| `workspaceRoots` | `[~/Work]` | 允许新建工作区的根目录 |
| `workerPreset` | 空（主机默认） | 新建下属会话使用的预设 |
| `reportMaxChars` | `4000` | 回报截断长度 |

## 已知限制（第一版）

- 下属在一轮中向用户提问或等待审批时，Leader 不会收到通知，只在该轮结束时收到回报。
- 日志暂时不可读时，对账会保留开放状态并暴露 `reconciliation_error`，需要等存储恢复；中断的任务不会自动重跑。
- 其他插件的系统提示片段可能仍提到被隐藏的工具。
