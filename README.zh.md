# dsh-super-leader

[English](README.md) | 中文

DeepSeek Harness 的 **Leader（领导）** Agent 预设。Leader 会话不自己干活：它先和你把需求讨论清楚，再选择或新建合适的工作区和会话，把任务交给下属会话，最后把下属的回报转达给你。

- **先问清楚。** 派活前，Leader 会检查目标、范围、交付物、验收标准和目标工作区。有不清楚的地方就用 `ask_user_question` 提问，给出可以一键选择的选项。
- **只有调度工具。** Leader 会话只能看到本插件的工具和 `ask_user_question`。其他插件注册的全局工具（MCP、记忆、IM 等）默认隐藏，可以按需放行。
- **写操作需要审批。** 新建工作区、派发任务、停止任务时会弹出审批卡片，卡片上是完整的任务简报。会话的访问模式为 **Full access（完全权限）** 时直接执行，不再审批。
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
| `list_sessions` | 否 | 列出会话、所在工作区、是否运行中、最近一次请求的首行、最近一次 Leader 任务 |
| `read_session` | 否 | 查看会话实际做了什么：最近的请求和回复、更早的请求列表、待办清单、改过的文件、Leader 派给它的任务 |
| `task_status` | 否 | 查看已派发的任务和回报 |
| `create_workspace` | 是 | 在允许的根目录下新建目录（可选 `git clone`、`git init`、写 `AGENTS.md`），并登记为工作区 |
| `dispatch_task` | 是 | 把任务简报发给已有会话，或在指定工作区新建会话再发 |
| `cancel_task` | 是 | 停止下属会话当前的轮次 |

“是否审批：是”表示调用会等你点 **Allow once（批准一次）**，除非 Leader 会话的权限预设在 `fullAccessPresets` 里（默认是 `danger-full-access`，界面上显示为 **Full access**）。

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
| `allowTools` | `[]` | Leader 会话仍可使用的全局工具 |
| `writeTools` | `create_workspace`、`dispatch_task`、`cancel_task` | 需要审批的工具 |
| `fullAccessPresets` | `[danger-full-access]` | 免审批的权限预设 |
| `workspaceRoots` | `[~/Work]` | 新建工作区允许的父目录 |
| `workerPreset` | 主机默认 | 新建下属会话的预设，不能是 Leader 预设 |
| `reportMaxChars` | `4000` | 回报长度上限 |
| `ledgerFile` | `$DSH_HOME/super-leader/ledger.json` | 任务台账位置（只能改文件，需要重启） |

## 工作原理

- 插件声明了 `leader` 预设（Leader 工具、`ask_user_question`、时间上下文、上下文压缩）和一个主机插件。
- 每个 Leader 会话里，主机插件会屏蔽所有不在 `allowTools` 里的全局工具；之后有新的全局工具出现，也会继续屏蔽。
- `tools/pre-execute` 钩子把写类工具变成审批请求，完全权限的会话除外。之所以要自己判断：DSH 的完全权限使用 `never` 审批策略，它会直接拒绝所有需要审批的操作。
- `read_session` 从会话的事件日志生成摘要（通过 DSH 的 `sessionQuery` 服务），反映的是下属实际做了什么，而不只是标题。
- `dispatch_task` 把任务记入台账，需要时新建下属会话，然后发送任务简报，并在末尾附上回报格式。下属这一轮结束后，这一轮最后一条助手回复会作为 agent 消息转达给 Leader。
- Leader 不能把任务派给自己，也不能派给其他 Leader 会话。

更多细节见 [DESIGN.md](DESIGN.md)。

## 已知限制

- 下属在一轮中途提问或等待审批时，Leader 要等这一轮结束才会收到通知。
- DSH 重启时正在运行的任务，在台账里会一直停在 `running`。
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
