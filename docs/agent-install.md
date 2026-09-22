# WorkBuddy Subagent Bridge：Agent 安装指引

本文面向负责配置本地开发环境的 Agent。用户可以将本文路径或 GitHub 链接交给 Agent，并要求 Agent 按照本文完成安装、诊断和 MCP 配置。

## 执行边界

Agent 仅在用户明确指定的工作目录内执行安装和配置操作。除非用户另行授权，不得进行以下操作：

- 发布 npm 包、创建 GitHub Release 或推送代码；
- 修改用户未指定的全局配置；
- 删除现有配置、项目文件或用户数据；
- 使用 `bypassPermissions` 或 `fullAccess` 代替正常的权限判断；
- 将用户的账号密码、npm token 或其他凭据写入文件或发送给第三方。

安装前，应先向用户说明将要执行的命令；遇到已有文件时，先备份或请求用户确认，不得静默覆盖。

## 安装流程

### 1. 检查前置条件

确认以下条件：

- 操作系统为 Windows（当前版本已在 Windows 上完成验收）；
- Node.js 版本为 20 或更高；
- npm 可用；
- WorkBuddy / CodeBuddy 已安装并完成登录。

执行：

~~~powershell
node --version
npm --version
~~~

### 2. 安装 Bridge

如果用户要求安装已发布版本：

~~~powershell
npm install --global workbuddy-subagent-bridge
~~~

如果项目尚未发布，或用户要求使用本地源码，则在项目目录执行：

~~~powershell
npm install
npm run build
npm pack
npm install --global .\workbuddy-subagent-bridge-<version>.tgz
~~~

`<version>` 应以实际生成的 tarball 文件名为准，不得自行猜测。

### 3. 运行诊断

安装后执行：

~~~powershell
workbuddy-subagent doctor
~~~

只有在 Node.js、npm、WorkBuddy、CodeBuddy CLI、ACP 和模型目录等关键项目均检查通过后，才继续配置 MCP。若诊断失败，应把完整输出交给主 Agent 和用户，不要通过修改 PATH 或删除配置来掩盖问题。

### 4. 生成 MCP 配置

在用户指定的临时目录或项目目录生成配置：

~~~powershell
workbuddy-subagent init --client codex --output .\workbuddy-mcp.json
~~~

如果目标文件已存在，先读取并比较内容。只有用户明确同意覆盖时，才能使用 `--force`。

`init` 只生成配置文件，不会自动修改 Codex 的全局配置。Agent 应向用户展示生成的配置，并由用户决定将 `workbuddy-subagent-bridge` 条目加入哪个 MCP 配置文件。修改前应保留原文件备份。

### 5. 验证 MCP 连接

完成配置后，重新启动 MCP 客户端，并验证：

1. 能发现 `workbuddy-subagent-bridge`；
2. 能调用 `workbuddy_doctor`；
3. 能调用 `workbuddy_models`；
4. 能创建一个最小的只读 `plan` 任务；
5. 能查询任务状态并读取最终报告。

验证任务不得修改项目文件。只有用户明确要求进行真实编辑测试时，才可以使用 `default`、`acceptEdits`、`bypassPermissions` 或 `fullAccess` 等更高权限模式。

## 权限处理原则

权限由主 Agent 负责判断。子 Agent 发起权限请求时，执行 Agent 应先向主 Agent 返回请求的原始内容，由主 Agent 决定批准、拒绝或是否需要用户进一步确认。

- `plan`：默认验证模式，适合只读检查；
- `default`：逐项处理权限请求；
- `acceptEdits`：允许文件编辑，但不等于允许所有外部副作用；
- `bypassPermissions`：仅用于用户明确授权的受控测试；
- `fullAccess`：高风险模式，必须明确告知用户可能执行危险操作。

安装流程本身不需要提高 WorkBuddy 任务权限。

## 故障处理

Agent 遇到问题时，按以下顺序处理：

1. 保存完整命令、退出码和原始错误字符串；
2. 重新运行 `workbuddy-subagent doctor`；
3. 检查 Node.js、WorkBuddy / CodeBuddy CLI 和当前 PATH；
4. 检查 MCP 配置中的命令路径和参数；
5. 将结果报告给用户，请用户决定下一步。

不要自动重试可能产生真实副作用的任务，也不要在任务结果不确定时盲目重放 prompt。

## 完成报告

安装完成后，Agent 应向用户报告：

- 安装来源和版本；
- `doctor` 的关键结果；
- MCP 配置文件路径；
- 是否重启了 MCP 客户端；
- 验证任务的状态和报告；
- 仍需用户手动完成的步骤。

