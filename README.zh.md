# dsh-super-leader

[English](README.md) | 中文

DeepSeek Harness 的 **Leader（领导）** Agent 预设。Leader 会话不自己干活：它先和你把需求讨论清楚，再选择或新建合适的工作区和会话，把任务交给下属会话，最后把下属的回报转达给你。

- **先问清楚。** 派活前，Leader 会检查目标、范围、交付物、验收标准和目标工作区。有不清楚的地方就用 `ask_user_question` 提问，给出可以一键选择的选项。
- **只有调度工具。** Leader 会话默认使用本插件工具和 `ask_user_question`。其他插件注册的全局工具只有显式加入 `allowTools` 才会开放。
- **写操作需要审批。** 新建工作区、派发任务、更改会话模型、停止任务时会弹出审批卡片。派发任务的卡片开头先写明目标：是继续已有会话还是新建会话、工作区名称和路径、会话标题和 id；目标会话正在运行时，还会写明任务是排队还是注入当前轮次。下面是完整的任务简报。会话的访问模式为 **Full access（完全权限）** 时直接执行，不再审批。
- **了解每个会话做过什么。** 续用已有会话前，Leader 会先读它最近的请求、回复、待办清单和改过的文件，续派的任务只需要说明新增的需求。
- **自动回报。** 下属会话完成一轮后，它的最终回复会自动发回 Leader。Leader 整理后告诉你，并把其中的待决问题转成问题问你。

![Leader 澄清需求](assets/clarify.png)

## 安装

需要 DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`。

```sh
dsh plugin --profile web add dsh-super-leader
```

也可以从 GitHub 安装最新代码：`dsh plugin --profile web add github:RickT34/dsh-super-leader`。

重启 `dsh web`。点 **New Session**，在工作区选择器旁边的模式菜单里选 **Leader**。预设只能在会话还没有内容时选择，所以要新建一个会话来用。

## 工具

| 工具 | 是否审批 | 作用 |
|---|---|---|
| `list_workspaces` | 否 | 列出已登记的工作区和用途说明 |
| `list_sessions` | 否 | 列出会话、所在工作区、是否运行中、使用的模型、最近一次请求的首行、最近一次 Leader 任务 |
| `read_session` | 否 | 查看会话实际做了什么：最近的请求和回复、更早的请求列表、待办清单、改过的文件、Leader 派给它的任务 |
| `list_models` | 否 | 列出可用的服务商和模型、每个模型支持的推理强度，以及主机默认模型 |
| `task_status` | 否 | 查看已派发的任务和回报 |
| `create_workspace` | 是 | 在允许的根目录下新建目录（可选 `git clone`、`git init`、写 `AGENTS.md`），并登记为工作区 |
| `dispatch_task` | 是 | 把任务简报发给已有会话，或在指定工作区新建会话再发；可指定使用的模型 |
| `cancel_task` | 是 | 停止下属会话当前的轮次 |
| `set_session_model` | 是 | 更改已有下属会话使用的模型 |

“是否审批：是”表示调用会等你点 **Allow once（批准一次）**，除非 Leader 会话的权限预设在 `fullAccessPresets` 里（默认是 `danger-full-access`，界面上显示为 **Full access**）。哪些工具需要审批由 `writeTools` 决定。如果你在旧版本里保存过自己的列表，这个列表会保留，同时总会加上 `set_session_model`，所以除了完全权限之外，改模型都要审批。设置页上它的勾选框始终勾选，不能取消。

## 配置

在 Web 界面打开 **Plugins → Super Leader**，插件页上就是设置表单。修改后对 Leader 会话立即生效，已经打开的会话也一样，不需要重启。

表单修改的是 profile 的 `cordis.patch.yml` 里 `super-leader` 这一项，所以也可以直接编辑这个文件：

```yaml
- id: super-leader
  config:
    workspaceRoots:            # create_workspace 只能在这些目录下创建
      - ~/Work
    allowTools: []             # Leader 仍可使用的全局工具，例如 dsh_im_return_file
    fullAccessPresets:         # 这些权限预设下写操作免审批
      - danger-full-access
    workerPreset: standard     # 新建下属会话使用的预设；留空则用主机默认
    reportMaxChars: 4000       # 转达回报的最大长度
```

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `presetId` | `leader` | 视为 Leader 的预设 id（只能改文件，需要重启） |
| `allowTools` | `[]` | Leader 额外可用的全局工具 |
| `writeTools` | `create_workspace`、`dispatch_task`、`cancel_task`、`set_session_model` | 需要审批的工具。`set_session_model` 总会被加入，即使保存的列表里没有它 |
| `fullAccessPresets` | `[danger-full-access]` | 免审批的权限预设 |
| `workspaceRoots` | `[~/Work]` | 新建工作区允许的父目录 |
| `workerPreset` | 主机默认 | 新建下属会话的预设，不能是 Leader 预设 |
| `reportMaxChars` | `4000` | 回报长度上限 |
| `ledgerFile` | `$DSH_HOME/super-leader/ledger.json` | 任务台账位置（只能改文件，需要重启） |

## 使用自己的记忆插件

在 DSH profile 中启用你选择的记忆插件，然后打开 **插件 → Super Leader → Leader 额外可用的工具**，手动勾选希望 Leader 使用的工具并保存。工具尚未加载时，可以在额外工具名输入框里填写其准确的注册名称。任何注册全局 DSH 工具的记忆插件都可按此方式配置；Leader 不选择记忆系统，也不自动放行记忆工具。

也可以在 profile 补丁的 `allowTools` 中填写工具名。例如，使用 Mnemon 并希望开放热记忆写入、文档搜索和 Memory Spaces 召回时：

```yaml
- id: super-leader
  config:
    allowTools:
      - mnemon_runtime_memory
      - mnemon_document_search
      - mnemon_recall
```

请合并到你已有的工具列表中，保留其他已放行工具。这只是配置示例，不是依赖或必选工具集；使用其他记忆插件时换成它提供的工具名，不需要的能力可以不加。若还希望记忆写工具经过 Leader 审批门，可把准确工具名加入 `writeTools`，并保留原有条目。

开放工具只改变 Leader 的工具可见性。存储、范围、写入权限、上下文快照和协议提示由记忆插件负责，需要时在该插件中开启；Leader 不额外加载一份记忆协议。主机级记忆服务不应在每个 Leader 预设里重复挂载。

以 Mnemon 为例，热记忆、Documents 和 Memory Spaces 是不同层。`mnemon_recall` 需要活动且可搜索的 Memory Space，以及当前 View 提供的 recall 路由；只放行工具不会创建路由。没有配置相应空间时，可以使用原生热记忆快照和文档搜索，或在 Mnemon 中配置并启用 Memory Space。标准预设也遵守相同条件。

## 工作原理

- 插件声明了 `leader` 预设（Leader 工具、`ask_user_question`、`AGENTS.md`/`CLAUDE.md` 指令、时间上下文、上下文压缩）和一个主机插件。指令的加载方式和 standard 预设相同：`$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md`，以及会话所在工作区里的文件。
- 每个 Leader 会话里，主机插件会屏蔽所有不在 `allowTools` 里的全局工具；之后有新的全局工具出现，也会继续屏蔽。
- `tools/pre-execute` 钩子把写类工具变成审批请求，完全权限的会话除外。之所以要自己判断：DSH 的完全权限使用 `never` 审批策略，它会直接拒绝所有需要审批的操作。
- `read_session` 从会话的事件日志生成摘要（通过 DSH 的 `sessionQuery` 服务），反映的是下属实际做了什么，而不只是标题。
- `dispatch_task` 把任务记入台账，需要时新建下属会话，然后发送任务简报，并在末尾附上回报格式。下属这一轮结束后，这一轮最后一条助手回复会作为 agent 消息转达给 Leader。
- Leader 不能把任务派给自己，也不能派给其他 Leader 会话。
- 模型：`list_sessions` 和 `read_session` 显示会话下一步会用的模型（会话已加载时读运行中的 Agent，否则从存储的日志推算）。`set_session_model` 和 `dispatch_task` 的 `provider`/`model`/`reasoning_effort` 参数写入会话级的模型选择，与模型选择器写的是同一种 `model/selection` 事件。区别是它们不改主机默认模型。对正在运行的会话改模型，会从它的下一步开始生效，所以 `dispatch_task` 不允许给运行中的会话指定模型。

更多细节见 [DESIGN.md](DESIGN.md)。

## 任务状态恢复

插件启动或恢复时，以及调用 `task_status` 时，会把台账与 worker 的实际轮次日志对账。已结束的轮次恢复真实终态；仍在执行原轮次或请求还在持久 inbox 的任务继续跟踪。没有结束记录且已不在跑、请求被移除、或明确找不到会话的任务标为 `interrupted`。暂时读不到日志则保留开放状态，显示 `reconciliation_error`，以后重试。

`task_status` 的单条和列表输出都显示 `report_state` 与 `report_missing`。当时未送达、后来从日志恢复的报告标为 `recovered`；没有可恢复的最终报告标为 `lost`，均明确标记原投递丢失，并附对账时间和说明。不会重跑任务，也不会自动补发旧报告；可通过 `task_status` 读取恢复文本，再决定中断任务是否需要继续。

## 与 IM 插件联动（dsh-im）

Leader 可以配合 [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im) 在聊天软件里使用：把聊天绑定到 Leader 会话（例如用 dsh-im 的 `/session <ID>`），或者选择新对话的预设为Leader。，就能在聊天里讨论需求、派发任务。本节按 dsh-im 5.10.0 的行为描述。

**IM 审批里的目标摘要。** dsh-im 读取审批的 `reason`。它保留原英文审批说明，后接一行目标摘要：工作区名称和路径、会话标题和 id（或「新建会话」）、空闲 / 排队 / 注入状态。摘要不含任务简报，也不会把 brief 复制进审批日志。Web 卡片的本地化 `displayReason` 保持不变；同意/拒绝仍按审批 id 匹配，不按这段文字匹配。

**为什么要开 `deliverModelAnswers`。** 你在聊天里发消息时，Leader 的回复沿聊天自己的回复链发回去，不需要任何设置。下属的回报不一样：它由本插件以 agent 消息的形式发给 Leader，所以 Leader 转达回报的那一轮不是聊天发起的。dsh-im 默认不投递这类轮次的回答，不开这个开关，转达的回报只会出现在 Web 界面里。

**在哪里开。** 设置 → IM机器人 → 通用设置 → 投递，在「会话同步」里勾选「投递模型回答」，再点「保存投递设置」。它保存在 `<dshHome>/integrations/dsh-im/delivery-sync-settings.json` 的 `deliverySync.deliverModelAnswers`。

**还会顺带推送什么。** 这个开关是全局的，作用于所有机器人和所有会话，不只是 Leader 会话。对每个当前绑定了聊天的会话，只要某一轮不是由这个聊天发起、并且成功结束，dsh-im 就把这一轮的最终回答（最后一次工具调用之后的文字）发到该聊天。包括：

- Leader 收到下属回报后的回复，这是开这个开关的目的；
- 你在 Web 界面里给这个会话发消息后得到的回答；
- 定时任务、问题答复回执、`subagent-settled` 等内部通知触发的轮次的回答。

不会推送的：由聊天自己发起的轮次（已经在聊天里回复过）；被取消或出错的轮次；工具过程、图片、文件、审批卡片。没有绑定聊天的会话不推送，例如 Leader 新建的下属会话。另一个开关「镜像 Web 中输入的消息」（`mirrorUserInput`）与此无关，可以保持关闭。

如果 Leader 在处理回报时向你提问或需要审批，聊天里能否收到取决于 dsh-im 自己的提问和审批同步：只在私聊中、并且要在投递目标上开启会话同步才有。否则需要到 Web 界面里回答；回答之前这一轮不会结束，回复也不会推送。

## 已知限制

- 下属在一轮中途提问或等待审批时，Leader 要等这一轮结束才会收到通知。
- 中断任务不会自动恢复执行；日志不可读时要等待存储恢复后才能完成对账。
- 其他插件的系统提示片段可能仍会提到 Leader 看不到的工具。

## 开发

```sh
git clone https://github.com/RickT34/dsh-super-leader.git
cd dsh-super-leader
mkdir -p node_modules/@deepseek-ai
ln -s "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery" node_modules/@deepseek-ai/schemastery
npm test
dsh plugin --profile web add "$(pwd)"
```

## 许可证

[MIT](LICENSE)
