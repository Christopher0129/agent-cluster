# Agent Cluster Workbench

一个零依赖、面向本地运行的多模型 agent 集群工作台。它提供图形化配置界面、任务编排、工作区工具调用，以及会话级运行时观测能力。

## 当前能力

- 多模型集群编排：主控模型负责规划，工作模型按阶段执行，最终由主控汇总。
- 图形化工作台：在浏览器中维护模型、共享密钥、方案、阶段并发、Bot 配置和工作区。
- Task Trace / 调用链可视化：前端可展示 span 树、父子调用链、provider 调用、工具调用、耗时、token 和成本估算。
- 工作模型工具调用层：工作模型可通过结构化工具动作执行 `list_files`、`read_files`、`write_files`、`run_command`、`recall_memory`、`remember`。
- 会话级运行时：支持会话记忆、provider 调用统计、token 统计、成本估算、重试记录与熔断状态追踪。
- 工作结果增强：每个 worker 结果面板会显示工具调用、记忆读写、验证状态、命令执行和生成文件。

## 运行要求

- Node.js 20+
- Windows / PowerShell 已验证

## 快速启动

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

默认地址：

```text
http://127.0.0.1:4040
```

## 测试

```powershell
npm test
```

只跑 smoke：

```powershell
npm run test:smoke
```

只跑 `node:test` 单元测试：

```powershell
npm run test:unit
```

只做语法检查：

```powershell
npm run check
```

## 打包 Windows EXE

```powershell
npm run build:win-exe
```

或：

```powershell
node scripts/build-win-exe.mjs
```

默认会把 `cluster.config.blank.json` 作为内置基础配置打入 EXE，避免误把本机私有 `cluster.config.json` 一起打包。
如果你确实需要指定自定义基础配置，可以显式设置：

```powershell
$env:AGENT_CLUSTER_BASE_CONFIG = "cluster.config.json"
npm run build:win-exe
```

## 配置说明

- 图形界面保存的运行配置默认落在 `runtime.settings.json`。
- 仓库中的 `cluster.config.blank.json` 可作为静态模板。
- `cluster.config.json` 更适合作为本机私有配置，不建议提交。
- 工作区默认目录为 `workspace/`。
- Bot 安装目录默认是 `bot-connectors/`。

## 成本估算配置

会话成本统计是配置驱动的。若想在 Session Stats 面板里看到美元成本，需要在模型配置中补充 `pricing`：

```json
{
  "id": "gpt54_controller",
  "label": "GPT-5.4 Controller",
  "provider": "openai-responses",
  "model": "gpt-5.4",
  "pricing": {
    "inputPer1kUsd": 0.003,
    "outputPer1kUsd": 0.015
  }
}
```

也支持按百万 token 配置：

```json
{
  "pricing": {
    "inputPer1mUsd": 3,
    "outputPer1mUsd": 15
  }
}
```

## 会话运行时输出

一次任务运行结束后，后端会返回 `session` 快照，前端会展示：

- provider 调用次数、失败次数、重试次数
- 工具调用次数
- 会话记忆读写次数与最近记忆
- token 总量
- 按模型汇总的调用统计
- 熔断器状态
- 基于 `pricing` 的成本估算

## Task Trace / 调用链

Trace 面板会将运行过程表示为 span 树，常见节点包括：

- 集群总操作
- 规划阶段
- worker 任务执行
- provider 调用
- 工具调用
- 记忆读取 / 写入
- 组长委派与汇总

这可以帮助你快速定位：

- 某个 worker 是否卡在规划、工具调用还是 provider 返回
- 哪个模型重试最多
- 哪条调用链最耗时
- 某次失败是否触发了熔断

## 隐私与 Git 卫生

仓库已新增 `.gitignore`，默认忽略这些高风险本地数据：

- `.env` 与其他本地环境变量文件
- `runtime.settings.json`
- `cluster.config.json`
- `workspace/`
- `dist/workspace/`
- `bot-connectors/`
- 日志、临时目录和本地打包产物

注意：`.gitignore` 只能阻止新的未跟踪文件进入版本库。
如果某些敏感文件已经被 Git 跟踪，还需要手动执行：

```powershell
git rm --cached <path>
```

## 项目结构

```text
src/
  cluster/      编排、规划、汇总
  providers/    模型 provider 实现
  session/      会话运行时、trace、记忆、熔断、成本
  static/       前端界面与可视化
  workspace/    工作区文件与命令工具层
test/           测试
scripts/        构建脚本
```

## 适合的场景

- 多模型并行分析
- 带工作区读写的本地自动化任务
- 需要追踪调用链、成本和重试行为的 agent 实验
- 需要会话记忆与工具层的原型验证
