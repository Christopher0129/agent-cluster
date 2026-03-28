# Agent Cluster Workbench

一个零依赖的多模型 Agent 集群原型，现在已经带图形化配置界面。

你可以在同一个页面里完成这些事情：

- 填写 API Key
- 配置模型列表
- 选择主控模型
- 设置并发数和端口
- 直接运行多模型集群分析

## 当前支持的模型接入方式

- `openai-responses`
  适合 OpenAI 的 `gpt-5.4`、`gpt-5.3-codex` 等模型
- `openai-chat`
  适合 OpenAI-compatible 的接口，例如 Kimi 一类服务

## 架构

1. 主控模型先生成结构化任务计划
2. 调度器按依赖关系并发执行子任务
3. 工作模型返回结构化结果
4. 主控模型把结果综合成最终答复

这个原型采用“代码调度 + 模型规划”的混合编排方式，便于同时接 OpenAI 和其它兼容 provider。参考：

- Responses API: https://platform.openai.com/docs/api-reference/responses/create?api-mode=responses
- GPT-5.4 model page: https://developers.openai.com/api/docs/models/gpt-5.4
- Multi-agent orchestration: https://openai.github.io/openai-agents-js/guides/multi-agent/

## 快速启动

```powershell
node src/server.mjs
```

或：

```powershell
& "C:\Program Files\nodejs\npm.cmd" start
```

默认地址：

```text
http://127.0.0.1:4040
```

## 打包为 Windows EXE

当前仓库已经带好打包脚本，直接执行：

```powershell
node scripts/build-win-exe.mjs
```

或：

```powershell
.\build-win-exe.ps1
```

产物位置：

```text
agent-cluster/dist/AgentClusterWorkbench.exe
```

运行这个 exe 后会：

- 在本机启动服务
- 默认打开浏览器到本地工作台
- 把 GUI 保存的配置写到 exe 同目录下的 `runtime.settings.json`

如果你只想启动服务、不自动打开浏览器，可以这样运行：

```powershell
.\AgentClusterWorkbench.exe --no-open
```

## 图形界面配置

页面打开后，左侧是配置区，右侧是运行区。

你不再需要手改 `.env` 或 `cluster.config.json`。页面保存后会把配置写到：

```text
agent-cluster/runtime.settings.json
```

保存内容包括：

- 端口
- 最大并发
- 主控模型
- 模型列表
- API Key

模型卡片里现在也可以直接填写该模型对应的 `API Key`，保存后会自动写入本地设置文件并在下次打开时回填。

说明：

- `cluster.config.json` 仍然保留，作为默认模板
- `runtime.settings.json` 是 GUI 保存的实际运行配置
- 如果你改了端口，保存后需要重启服务

## 模型配置字段

每个模型卡片支持这些核心字段：

- `id`
- `label`
- `provider`
- `model`
- `baseUrl`
- `apiKeyEnv`
- `authStyle`
- `apiKeyHeader`
- `reasoningEffort`
- `temperature`
- `specialties`

## 当前能力边界

- 现在是单轮编排，不包含持续会话记忆
- 还没有接入真实工具链，例如网页搜索、代码执行、数据库读写
- 更适合分析、评审、方案设计、对比类任务
- 还不等同于完整自治 Agent 平台

## 建议的下一步

如果你准备继续做成正式产品，下一阶段建议加：

1. 任务 Trace 和调用链可视化
2. 工作模型的工具调用层
3. 会话级记忆、成本统计、重试与熔断策略
