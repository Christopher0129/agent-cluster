# Agent Cluster Workbench

Agent Cluster Workbench 是一个本地优先的多模型 agent 集群控制台，用于编排主控与工作模型流程、可视化任务 Trace 和调用链、管理工作区工具调用，并追踪会话记忆、重试、熔断和成本估算。

## 署名

- 作者：想画世界送给你

## 开源许可

- 许可证：`GPL-2.0-only`
- 完整文本见：[LICENSE](./LICENSE)

## 功能

- 任务 Trace 与调用链可视化
- 工作模型工具调用层
- 会话级记忆、Token 与成本统计、重试与熔断
- 基于方案的多模型路由与分阶段执行
- 中文 / English 运行时语言切换
- 工作区缓存清理与更严格的任务作用域限制

## 运行要求

- Node.js 20+
- 推荐在 Windows / PowerShell 下运行打包流程

## 快速开始

```powershell
npm install
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

## 验证

```powershell
npm test
```

仅跑 smoke：

```powershell
npm run test:smoke
```

仅跑单元测试：

```powershell
npm run test:unit
```

仅做语法检查：

```powershell
npm run check
```

## 打包 Windows EXE

```powershell
npm run build:win-exe
```

默认情况下，EXE 内置的是 `cluster.config.blank.json`，不会直接打入你的本地 `cluster.config.json` 或 `runtime.settings.json`。

如果你在打包前显式覆盖基础配置，EXE 可能会带入你的自定义配置内容：

```powershell
$env:AGENT_CLUSTER_BASE_CONFIG = "cluster.config.json"
npm run build:win-exe
```

## 隐私与 Git 安全

仓库已忽略以下本地敏感文件和产物：

- `.env` 及本地环境变量变体
- `cluster.config.json`
- `runtime.settings.json`
- `dist/runtime.settings.json`
- 本地加密密钥文件
- 工作区缓存和 Bot 连接器目录
- `dist/*.exe` 这类打包二进制

注意：

- `runtime.settings.json` 虽然以加密形式存储密钥，但仍然不应提交到仓库。
- `.gitignore` 只对未跟踪文件生效。如果敏感文件已经被 Git 跟踪，需要先从索引移除：

```powershell
git rm --cached cluster.config.json dist/runtime.settings.json dist/AgentClusterWorkbench.exe
```

## 项目结构

```text
src/
  cluster/      编排、路由、汇总
  http/         HTTP 路由
  providers/    模型 provider 适配层
  session/      会话运行时、Trace、记忆、统计
  static/       前端模块与可视化
  system/       桌面与运行时集成
  workspace/    工作区文件与命令工具
scripts/        构建脚本
test/           smoke 与单元测试
```
