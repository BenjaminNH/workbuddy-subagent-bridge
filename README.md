# WorkBuddy Subagent Bridge

WorkBuddy Subagent Bridge 是一个本地 MCP 桥接器，让主 Agent 通过 MCP 调用 WorkBuddy 执行任务。

主 Agent 负责理解目标、拆解任务、审批权限和验收结果；WorkBuddy 负责具体执行。任务完成后，主 Agent 可以读取报告，并继续向同一会话发送修改意见。

> 本项目是独立的社区工具，与 WorkBuddy 官方没有隶属关系。

## 适用场景

- 让主 Agent 把编码、文件修改或诊断任务交给 WorkBuddy。
- 管理多个独立的 WorkBuddy 任务，并分别查询状态和报告。
- 在 WorkBuddy 请求修改文件或执行操作时，由主 Agent 审批权限。
- 让同一 WorkBuddy 会话持续接收反馈，完成“分派—执行—验收—修订”流程。

当前公开版本为 `0.1.0`，已在 Windows 上完成真实验证。

## 安装

### 前置条件

- Windows
- Node.js 20 或更高版本
- 已安装并登录 WorkBuddy / CodeBuddy

当前验证环境：WorkBuddy 5.5.6、CodeBuddy CLI 2.137.1、Node.js 22.22.3。

### 交由 Agent 安装

复制下面的 Prompt 发送给 Agent 即可：

~~~text
安装并配置 WorkBuddy Subagent Bridge。

项目仓库：https://github.com/BenjaminNH/workbuddy-subagent-bridge
先阅读并执行仓库中的 docs/agent-install.md，完成后返回安装和验证结果。
~~~

### 从 npm 安装

~~~powershell
npm install -g workbuddy-subagent-bridge
workbuddy-subagent doctor
~~~

`doctor` 会检查 Node.js、npm、WorkBuddy、CodeBuddy CLI、ACP 连接和模型目录。开始使用前，请确认关键检查项均为 `ok`。

### 从本地源码安装

~~~powershell
npm install
npm run build
npm pack
npm install -g .\workbuddy-subagent-bridge-0.1.0.tgz
workbuddy-subagent doctor
~~~

## 配置 MCP

生成 Codex 配置文件：

~~~powershell
workbuddy-subagent init --client codex --output .\workbuddy-mcp.json
~~~

`init` 只生成配置文件，不会自动修改 Codex 的全局配置。请将生成的 `workbuddy-subagent-bridge` 条目加入 Codex 的 MCP 配置，然后重启 Codex。

如果目标文件已存在，`init` 默认拒绝覆盖；确认需要替换时，显式添加 `--force`。

## 基本使用

配置完成后，主 Agent 可以创建任务：

~~~text
请分析当前项目，实现指定功能，并在完成后报告修改内容和测试结果。
~~~

典型流程：

1. 使用 `workbuddy_session_start` 创建任务。
2. 使用 `workbuddy_session_status` 查询任务状态和待处理权限请求。
3. 使用 `workbuddy_session_report` 读取最终报告。
4. 使用 `workbuddy_session_send` 向同一会话发送反馈或修改要求。
5. 完成后使用 `workbuddy_session_close` 关闭本地会话进程。

一个 MCP Bridge 可以管理多个独立任务。每个任务都有自己的 `taskId`、WorkBuddy session、工作目录、权限模式和报告。

## 权限模式

权限模式在创建任务时指定，默认是 `plan`。主 Agent 应根据任务范围选择模式。

| 模式 | 说明 |
| --- | --- |
| `plan` | 只读分析和规划，默认模式 |
| `default` | 需要执行受限操作时逐项请求权限 |
| `acceptEdits` | 自动接受文件编辑，其他操作仍受限制 |
| `auto` | 由 WorkBuddy 自动判断风险 |
| `dontAsk` | 无法交互时拒绝需要询问的操作 |
| `delegate` | 由主 Agent 管理权限请求 |
| `bypassPermissions` | 跳过权限提示，风险较高 |
| `fullAccess` | 跳过全部权限检查，包括危险命令，风险极高 |

`bypassPermissions` 和 `fullAccess` 不会被默认使用，也不会被后续 `session_send` 自动提升。主 Agent 应在使用前确认工作目录和任务范围。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `workbuddy_session_start` | 创建 WorkBuddy 任务 |
| `workbuddy_session_send` | 向同一会话发送后续反馈 |
| `workbuddy_session_status` | 查询任务状态和权限请求 |
| `workbuddy_session_report` | 读取当前任务的最终报告 |
| `workbuddy_session_permission_reply` | 回复权限请求 |
| `workbuddy_session_cancel` | 取消任务 |
| `workbuddy_session_close` | 关闭本地会话进程 |
| `workbuddy_status` | 列出任务及其状态 |
| `workbuddy_models` | 查询模型目录、来源和更新时间 |
| `workbuddy_doctor` | 检查本机运行环境 |

## 安全边界和当前限制

- 工作目录必须由调用方明确提供，Bridge 不自动创建 worktree 或合并 diff。
- 默认使用 `plan`，高风险权限必须在任务级别显式指定。
- 日志只记录基础生命周期信息，不记录 prompt、结果正文、文件内容或凭据。
- ACP 是多轮任务的主路径；CLI 只用于一次性任务或 ACP 启动前失败的兼容场景。
- ACP prompt 已提交但结果不确定时，不会自动切换 CLI 重放。
- `completed` 和 `cancelled` 是任务状态标签；如果 WorkBuddy 仍支持加载 session，可以继续发送反馈。
- 报告保存在当前 Bridge 进程内。Bridge 进程重启后的无缝任务恢复不属于当前 MVP 的保证范围。
- 当前版本不提供远程公网 Agent 服务、A2A、多账号池、多供应商调度、自动 worktree、GUI 自动化或 OpenAI/Anthropic API 兼容层。

## 开发与验证

~~~powershell
npm install
npm test
npm run typecheck
npm run build
npm run doctor
~~~

## 问题反馈

提交问题时，请附带：

- WorkBuddy 和 CodeBuddy CLI 版本
- `workbuddy-subagent doctor` 输出
- 最小复现步骤
- 使用的权限模式
- 相关任务状态和原始错误字符串

## 许可证

本项目采用 [MIT License](LICENSE)。
