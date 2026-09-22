# WorkBuddy Subagent Bridge

WorkBuddy Subagent Bridge 是一个本地 MCP 服务，用于连接 Codex 等主 Agent 与 WorkBuddy。主 Agent 负责任务拆解、权限审批和结果验收，WorkBuddy 负责具体执行。

Bridge 支持在同一会话中反复发送任务和反馈，使主 Agent 可以按照“分派、执行、验收、修订”的流程管理 WorkBuddy。

> 本项目为独立的社区工具，与 WorkBuddy 官方没有隶属关系。

## 项目特性

- 通过 MCP stdio 接入主 Agent。
- 通过 WorkBuddy ACP 管理有状态的多轮会话。
- 支持任务状态查询、最终报告和同一会话的后续反馈。
- 支持 WorkBuddy 权限请求的查看与回复。
- 支持 ACP 启动失败时的 CLI 一次性任务 fallback。
- 提供模型目录和本机环境诊断。
- 默认记录基础生命周期日志，不记录 prompt、结果正文、文件内容或凭据。

## 安装与配置

### 前置条件

- Windows（当前已完成真实验证；macOS 和 Linux 尚未进行本机验收）。
- Node.js 20 或更高版本。
- 已安装并完成登录的 WorkBuddy / CodeBuddy。

当前版本在以下环境中完成验证：

- WorkBuddy 5.5.6
- CodeBuddy CLI 2.137.1
- Node.js 22.22.3

### 交由 Agent 安装

如果希望由主 Agent 代为完成安装、诊断和 MCP 配置，请将 [Agent 安装指引](docs/agent-install.md) 的路径或链接交给它，并要求严格按照指引执行。该指引明确了安装范围、权限边界、配置覆盖规则和完成报告要求。

Agent 安装流程不会自动发布 npm 包、创建 GitHub Release 或修改未指定的全局配置。涉及真实文件编辑或高风险权限模式时，仍应由主 Agent 根据任务范围进行判断。

可以直接复制下面的 Prompt 发送给 Agent：

~~~text
请帮我安装并配置 WorkBuddy Subagent Bridge。

请先阅读并严格执行本项目的 docs/agent-install.md。该文件包含完整的安装步骤、执行边界、权限要求、验收条件和故障处理规则。

如果当前工作目录中找不到该文件，请先向我索要项目仓库链接或文件内容。完成后请按照指引返回安装和验证报告；不要自行扩大操作范围。
~~~

### 从 npm 安装

正式发布后，可通过以下命令安装：

~~~powershell
npm install -g workbuddy-subagent-bridge
workbuddy-subagent doctor
~~~

doctor 会检查 Node.js、npm、WorkBuddy 安装目录、WorkBuddy 数据目录、CodeBuddy CLI、ACP stdio 连接和模型目录。开始使用前，应确认关键检查项均为 ok。

### 从本地 tarball 安装

发布前可以使用本地 tarball 验证安装结果：

~~~powershell
npm pack
npm install -g .\workbuddy-subagent-bridge-0.1.0.tgz
workbuddy-subagent doctor
~~~

### 配置 Codex

使用 init 生成 MCP 配置：

~~~powershell
workbuddy-subagent init --client codex --output .\workbuddy-mcp.json
~~~

init 只生成配置文件，不会自动修改 Codex 的全局配置。请将生成文件中的 workbuddy-subagent-bridge 条目加入 Codex 的 MCP 配置，然后重新启动 Codex。

配置结构如下：

~~~json
{
  "mcpServers": {
    "workbuddy-subagent-bridge": {
      "command": "node",
      "args": ["<安装目录>/dist/index.js"]
    }
  }
}
~~~

如果目标文件已经存在，init 默认拒绝覆盖。确认需要替换时，显式添加 --force 参数。

## 基本使用

完成 MCP 配置后，主 Agent 可以将需要执行的具体工作分派给 WorkBuddy。例如：

~~~text
请先分析当前项目，实现指定功能，并在完成后报告修改内容和测试结果。
~~~

标准任务流程如下：

1. 创建 WorkBuddy 任务。
2. 查询任务状态，等待任务报告。
3. 查看执行结果并进行验收。
4. 通过同一会话发送修订意见。
5. 遇到权限请求时，审查请求内容并作出批准或拒绝决定。

ACP 任务默认立即返回 taskId，主 Agent 通过 status 主动查询任务进度。需要等待首轮报告时，可以在 session_start 中设置 waitForCompletion=true。

## 权限策略

权限模式在创建任务时指定，不在安装阶段授予。Bridge 透传当前 WorkBuddy 版本提供的权限选项，并在返回值中标注高风险模式。

| 模式 | 适用场景 |
| --- | --- |
| plan | 默认模式，用于方案分析、审查和只读诊断 |
| default | 每次需要权限时，由主 Agent 逐项审批 |
| acceptEdits | 自动接受文件编辑，其他外部副作用仍受控制 |
| auto | 由 WorkBuddy 自动判断操作风险 |
| dontAsk | 无法交互时，拒绝需要询问的操作 |
| bypassPermissions | 允许子 Agent 自主编辑、运行测试和执行命令，风险较高 |
| fullAccess | 跳过全部权限检查，包括危险命令，风险极高 |
| delegate | 由主 Agent 管理权限请求 |

bypassPermissions 和 fullAccess 均不会作为默认值，也不会被后续 session_send 隐式提升。使用高风险模式前，应确认任务范围和工作目录。

## MCP 工具

Bridge 提供以下 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| workbuddy_session_start | 创建 WorkBuddy 任务 |
| workbuddy_session_send | 向同一会话发送后续任务或反馈 |
| workbuddy_session_status | 查询任务状态和待处理权限请求 |
| workbuddy_session_report | 读取当前 prompt 的最终报告 |
| workbuddy_session_permission_reply | 回复 ACP 权限请求 |
| workbuddy_session_cancel | 取消任务 |
| workbuddy_session_close | 关闭本地会话进程并标记任务完成 |
| workbuddy_status | 列出任务及其生命周期状态 |
| workbuddy_models | 查询模型目录、来源和更新时间 |
| workbuddy_doctor | 检查本机运行环境 |

## 安全边界

- 默认使用 plan 模式，避免意外修改文件或执行命令。
- 工作目录必须由调用方明确提供，Bridge 不自动创建 worktree。
- 日志记录任务、会话、模型、权限模式和状态，不记录 prompt、结果正文、文件内容或凭据。
- 权限请求保留 WorkBuddy 返回的原始选项，Bridge 不擅自改写为固定的允许或拒绝语义。
- 只有在 ACP 尚未提交 prompt 且启动失败时，auto backend 才允许切换到 CLI。
- 已提交但结果不确定的任务不会自动重放。
- 报告保存在当前 Bridge 进程内。Bridge 进程重启后的无缝任务恢复不属于当前 MVP 的保证范围。

## 实现说明

Bridge 是一个本地 MCP stdio Server。对于 ACP 任务，它会启动独立的 CodeBuddy ACP stdio 子进程，并将 MCP 请求转换为 WorkBuddy session 操作。

ACP 是多轮任务的主路径，负责会话、状态、权限请求、报告和反馈。CLI 是一次性兼容路径，适用于 ACP 启动前失败或需要 CLI 特有参数的任务。

同一任务的 session_send 会串行执行。completed 和 cancelled 是任务状态标签，不会主动删除 WorkBuddy session；如果 WorkBuddy 仍然支持 session/load，主 Agent 可以继续发送反馈。当前 CodeBuddy 2.137.1 对标准 session/cancel 返回 Method not found，Bridge 会关闭该任务的本地 ACP 子进程作为兼容处理，并保留 session 元数据。

## 模型与兼容性

模型目录以 WorkBuddy ACP session/new 返回值为准，并附带来源和抓取时间。当前本地验证在未指定 modelId 时优先尝试 hy4-preview，再尝试 deepseek-v4.1-flash。正式调用建议由用户或上层 Agent 显式选择模型。

当前版本不包含以下能力：

- GUI 内部 Gateway 复用、HTTP/SSE transport
- A2A 或远程公网 Agent 服务
- 多账号池和多供应商统一调度
- 自动 worktree、分支隔离和 diff 合并
- OpenAI 或 Anthropic API 兼容层
- GUI 自动化

## 开发与验证

~~~powershell
npm install
npm test
npm run typecheck
npm run build
npm run doctor
~~~

发布前检查 npm 包内容：

~~~powershell
npm publish --dry-run
~~~

本机真实验证报告保存在 docs/_local/，该目录默认不进入公开提交。

## 发布流程

版本发布采用 Git tag 触发 GitHub Actions。推荐流程为：

1. 更新 package.json 版本号。
2. 提交代码并创建对应的 v*.*.* tag。
3. GitHub Actions 执行测试、类型检查和构建。
4. 验证通过后发布 npm 包。
5. npm 发布成功后创建 GitHub Release。

npm Trusted Publishing 使用 GitHub Actions 的 OIDC 身份，不需要在仓库中保存长期有效的 npm token。正式发布前，需要在 npm 和 GitHub 中配置对应的包名、仓库和 workflow。

## 问题反馈

提交问题时，请附带以下信息：

- WorkBuddy 和 CodeBuddy CLI 版本
- workbuddy-subagent doctor 输出
- 最小复现步骤
- 使用的权限模式
- 相关任务状态和原始错误字符串

## 许可证

本项目采用 [MIT License](LICENSE)。完整许可证文本见 [LICENSE](LICENSE) 文件。
