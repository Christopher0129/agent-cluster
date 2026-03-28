import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureWorkspaceDirectory, resolveWorkspacePath } from "../workspace/fs.mjs";

const DEFAULT_INSTALL_DIR = "bot-connectors";
const DEFAULT_INSTALL_TIMEOUT_MS = 420000;
const OUTPUT_CHAR_LIMIT = 24000;

const BOT_PLUGIN_PRESETS = Object.freeze([
  {
    id: "qq_guild",
    label: "QQ 频道 Bot",
    channel: "QQ",
    source: "社区 SDK",
    ecosystem: "npm",
    description: "QQ 官方频道消息桥接预设。安装后会生成可直接转发到 Agent 集群的连接器脚本。",
    docsUrl: "https://github.com/zhinjs/qq-official-bot",
    installCommand: "npm install qq-official-bot",
    tags: ["QQ", "频道", "Gateway"],
    fields: [
      {
        envName: "QQ_BOT_APP_ID",
        label: "App ID",
        type: "text",
        required: true,
        placeholder: "填写 QQ 官方机器人 App ID",
        description: "QQ 开放平台里创建机器人后获得的 App ID。"
      },
      {
        envName: "QQ_BOT_SECRET",
        label: "App Secret",
        type: "password",
        required: true,
        placeholder: "填写 QQ 官方机器人 Secret",
        description: "用于连接 QQ 官方 Bot Gateway 的密钥。"
      },
      {
        envName: "QQ_BOT_SANDBOX",
        label: "沙箱模式",
        type: "toggle",
        defaultValue: "0",
        trueValue: "1",
        falseValue: "0",
        description: "调试阶段建议开启，正式运行时通常关闭。"
      }
    ],
    envHints: [
      "QQ_BOT_APP_ID=你的机器人 AppId",
      "QQ_BOT_SECRET=你的机器人 Secret",
      "QQ_BOT_SANDBOX=0"
    ]
  },
  {
    id: "wechaty",
    label: "微信 Bot",
    channel: "微信",
    source: "官方文档",
    ecosystem: "npm",
    description: "Wechaty 连接器预设。收到消息后会把任务转发给 Agent 集群，并把进度与结果回复到原会话。",
    docsUrl: "https://wechaty.js.org/docs/howto/installation/",
    installCommand: "npm install wechaty",
    tags: ["微信", "Wechaty", "Message"],
    fields: [
      {
        envName: "WECHATY_PUPPET",
        label: "Puppet 类型",
        type: "text",
        placeholder: "例如 wechaty-puppet-service",
        description: "留空则使用 Wechaty 默认 Puppet。"
      },
      {
        envName: "WECHATY_PUPPET_SERVICE_TOKEN",
        label: "Puppet Token",
        type: "password",
        placeholder: "填写对应 Puppet Service Token",
        description: "仅在使用 wechaty-puppet-service 等远程 Puppet 时需要。"
      },
      {
        envName: "WECHATY_BOT_NAME",
        label: "Bot 名称",
        type: "text",
        defaultValue: "agent-cluster-wechaty",
        placeholder: "agent-cluster-wechaty",
        description: "用于本地运行时区分实例名称。"
      }
    ],
    envHints: [
      "WECHATY_PUPPET=可选，例如 wechaty-puppet-service",
      "WECHATY_PUPPET_SERVICE_TOKEN=对应 Puppet Token",
      "WECHATY_BOT_NAME=agent-cluster-wechaty"
    ]
  },
  {
    id: "dingtalk",
    label: "钉钉 Bot",
    channel: "钉钉",
    source: "官方文档",
    ecosystem: "npm",
    description: "钉钉 Stream Bot 预设。连接器会监听钉钉消息事件，并把执行过程回推到当前会话。",
    docsUrl: "https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/build-bot/",
    installCommand: "npm install dingtalk-stream",
    tags: ["钉钉", "Stream", "Event"],
    fields: [
      {
        envName: "DINGTALK_CLIENT_ID",
        label: "Client ID",
        type: "text",
        required: true,
        placeholder: "填写钉钉应用的 Client ID",
        description: "钉钉 Stream Bot 应用凭证中的 Client ID。"
      },
      {
        envName: "DINGTALK_CLIENT_SECRET",
        label: "Client Secret",
        type: "password",
        required: true,
        placeholder: "填写钉钉应用的 Client Secret",
        description: "钉钉 Stream Bot 应用凭证中的 Client Secret。"
      }
    ],
    envHints: [
      "DINGTALK_CLIENT_ID=你的 Client ID",
      "DINGTALK_CLIENT_SECRET=你的 Client Secret"
    ]
  },
  {
    id: "feishu",
    label: "飞书 Bot",
    channel: "飞书",
    source: "官方仓库",
    ecosystem: "npm",
    description: "飞书长连接 Bot 预设。连接器会接收飞书 IM 消息，并把任务结果回复到对应聊天。",
    docsUrl: "https://github.com/larksuite/oapi-sdk-nodejs",
    installCommand: "npm install @larksuiteoapi/node-sdk",
    tags: ["飞书", "LongConn", "IM"],
    fields: [
      {
        envName: "FEISHU_APP_ID",
        label: "App ID",
        type: "text",
        required: true,
        placeholder: "填写飞书应用的 App ID",
        description: "飞书开放平台应用凭证中的 App ID。"
      },
      {
        envName: "FEISHU_APP_SECRET",
        label: "App Secret",
        type: "password",
        required: true,
        placeholder: "填写飞书应用的 App Secret",
        description: "飞书开放平台应用凭证中的 App Secret。"
      }
    ],
    envHints: [
      "FEISHU_APP_ID=你的 App ID",
      "FEISHU_APP_SECRET=你的 App Secret"
    ]
  }
]);

function normalizeInstallDir(value, fallback = DEFAULT_INSTALL_DIR) {
  const normalized = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || fallback;
}

function trimCommandOutput(stdout, stderr) {
  const joined = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (!joined) {
    return "";
  }

  return joined.length > OUTPUT_CHAR_LIMIT ? `${joined.slice(0, OUTPUT_CHAR_LIMIT)}\n... [output truncated]` : joined;
}

function sanitizePackageName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "agent-cluster-bot";
}

function getPresetById(presetId) {
  return BOT_PLUGIN_PRESETS.find((preset) => preset.id === String(presetId || "").trim()) || null;
}

function buildShellCommand(commandText) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandText]
    };
  }

  return {
    command: "sh",
    args: ["-lc", commandText]
  };
}

function buildManifestPayload({ preset, installDir, targetRelativeDir, commandText, commandOutput }) {
  return {
    id: preset.id,
    label: preset.label,
    channel: preset.channel,
    source: preset.source,
    ecosystem: preset.ecosystem,
    description: preset.description,
    docsUrl: preset.docsUrl,
    installDir,
    targetRelativeDir,
    installCommand: commandText,
    installedAt: new Date().toISOString(),
    outputPreview: commandOutput,
    envHints: preset.envHints || []
  };
}

async function ensureNodePackage(targetDir, packageName, label) {
  const packageJsonPath = join(targetDir, "package.json");
  if (existsSync(packageJsonPath)) {
    return packageJsonPath;
  }

  const packageJson = {
    name: sanitizePackageName(packageName),
    version: "0.1.0",
    private: true,
    description: `${label} connector scaffold generated by Agent Cluster Workbench`,
    type: "module"
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return packageJsonPath;
}

function renderSharedBridgeHelpers() {
  return [
    `const SERVER_URL = String(process.env.AGENT_CLUSTER_SERVER_URL || "").replace(/\\/+$/, "");`,
    `const BOT_ID = String(process.env.AGENT_CLUSTER_BOT_ID || "bot").trim() || "bot";`,
    `const COMMAND_PREFIX = String(process.env.AGENT_CLUSTER_COMMAND_PREFIX || "/agent").trim();`,
    `const PROGRESS_UPDATES = process.env.AGENT_CLUSTER_PROGRESS_UPDATES !== "0";`,
    `const POLL_INTERVAL_MS = Math.max(1200, Number(process.env.AGENT_CLUSTER_POLL_INTERVAL_MS || 2500));`,
    ``,
    `function ensureServerUrl() {`,
    `  if (!SERVER_URL) {`,
    `    throw new Error("AGENT_CLUSTER_SERVER_URL is required.");`,
    `  }`,
    `}`,
    ``,
    `function sleep(ms) {`,
    `  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));`,
    `}`,
    ``,
    `function trimReply(text, maxLength = 1200) {`,
    `  const normalized = String(text || "").trim();`,
    `  return normalized.length > maxLength ? \`\${normalized.slice(0, maxLength)}…\` : normalized;`,
    `}`,
    ``,
    `function normalizeText(value) {`,
    `  return String(value || "").replace(/\\r/g, "").trim();`,
    `}`,
    ``,
    `function extractTaskText(rawText) {`,
    `  const normalized = normalizeText(rawText);`,
    `  if (!normalized) {`,
    `    return "";`,
    `  }`,
    `  if (!COMMAND_PREFIX) {`,
    `    return normalized;`,
    `  }`,
    `  if (!normalized.toLowerCase().startsWith(COMMAND_PREFIX.toLowerCase())) {`,
    `    return "";`,
    `  }`,
    `  return normalizeText(normalized.slice(COMMAND_PREFIX.length));`,
    `}`,
    ``,
    `async function postJson(path, body) {`,
    `  ensureServerUrl();`,
    `  const response = await fetch(\`\${SERVER_URL}\${path}\`, {`,
    `    method: "POST",`,
    `    headers: { "Content-Type": "application/json" },`,
    `    body: JSON.stringify(body || {})`,
    `  });`,
    `  const payload = await response.json();`,
    `  if (!response.ok || payload.ok === false) {`,
    `    throw new Error(payload.error || \`HTTP \${response.status}\`);`,
    `  }`,
    `  return payload;`,
    `}`,
    ``,
    `async function getJson(path) {`,
    `  ensureServerUrl();`,
    `  const response = await fetch(\`\${SERVER_URL}\${path}\`);`,
    `  const payload = await response.json();`,
    `  if (!response.ok || payload.ok === false) {`,
    `    throw new Error(payload.error || \`HTTP \${response.status}\`);`,
    `  }`,
    `  return payload;`,
    `}`,
    ``,
    `async function submitClusterTask(payload) {`,
    `  return postJson("/api/bot/incoming", {`,
    `    botId: BOT_ID,`,
    `    ...payload`,
    `  });`,
    `}`,
    ``,
    `async function fetchOperationSnapshot(operationId, afterSeq = 0) {`,
    `  const query = new URLSearchParams();`,
    `  if (afterSeq > 0) {`,
    `    query.set("afterSeq", String(afterSeq));`,
    `  }`,
    `  return getJson(\`/api/operations/\${encodeURIComponent(operationId)}/snapshot?\${query.toString()}\`);`,
    `}`,
    ``,
    `function shouldForwardProgressEvent(event) {`,
    `  return [`,
    `    "planning_start",`,
    `    "planning_done",`,
    `    "planning_retry",`,
    `    "worker_retry",`,
    `    "leader_delegate_start",`,
    `    "leader_delegate_done",`,
    `    "leader_synthesis_start",`,
    `    "leader_synthesis_retry",`,
    `    "subagent_retry",`,
    `    "synthesis_start",`,
    `    "synthesis_retry"`,
    `  ].includes(event.stage);`,
    `}`,
    ``,
    `function describeProgressEvent(event) {`,
    `  switch (event.stage) {`,
    `    case "planning_start":`,
    `      return "主控开始规划任务。";`,
    `    case "planning_done":`,
    `      return \`主控完成规划，已拆分 \${event.taskCount || 0} 个任务。\`;`,
    `    case "planning_retry":`,
    `      return \`\${event.modelLabel || "主控"} 正在重试规划，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "worker_retry":`,
    `      return \`\${event.agentLabel || event.modelLabel || "工作模型"} 正在重试，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "leader_delegate_start":`,
    `      return \`\${event.agentLabel || "组长"} 正在分配下属任务。\`;`,
    `    case "leader_delegate_done":`,
    `      return event.detail || \`\${event.agentLabel || "组长"} 已完成任务分配。\`;`,
    `    case "leader_synthesis_start":`,
    `      return \`\${event.agentLabel || "组长"} 正在汇总下属结果。\`;`,
    `    case "leader_synthesis_retry":`,
    `      return \`\${event.agentLabel || "组长"} 正在重试汇总，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "subagent_retry":`,
    `      return \`\${event.agentLabel || "下属 Agent"} 正在重试，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "synthesis_start":`,
    `      return "主控开始汇总各组结果。";`,
    `    case "synthesis_retry":`,
    `      return \`\${event.modelLabel || "主控"} 正在重试最终汇总，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    default:`,
    `      return "";`,
    `  }`,
    `}`,
    ``,
    `async function followOperation(operationId, sendReply) {`,
    `  let afterSeq = 0;`,
    `  let lastProgressMessage = "";`,
    `  for (;;) {`,
    `    const snapshot = await fetchOperationSnapshot(operationId, afterSeq);`,
    `    const events = Array.isArray(snapshot.events) ? snapshot.events : [];`,
    `    for (const event of events) {`,
    `      afterSeq = Math.max(afterSeq, Number(event.seq) || 0);`,
    `      if (event.stage === "cluster_done") {`,
    `        const finalAnswer = trimReply(event.finalAnswer || event.detail || "任务已完成。", 1800);`,
    `        await sendReply(\`任务完成。\\n\\n\${finalAnswer}\`);`,
    `        return;`,
    `      }`,
    `      if (event.stage === "cluster_failed") {`,
    `        await sendReply(trimReply(\`任务执行失败：\${event.detail || "未知错误"}\`, 1800));`,
    `        return;`,
    `      }`,
    `      if (event.stage === "cluster_cancelled") {`,
    `        await sendReply(trimReply(\`任务已终止：\${event.detail || "已取消"}\`, 1800));`,
    `        return;`,
    `      }`,
    `      if (PROGRESS_UPDATES && shouldForwardProgressEvent(event)) {`,
    `        const progressMessage = describeProgressEvent(event);`,
    `        if (progressMessage && progressMessage !== lastProgressMessage) {`,
    `          lastProgressMessage = progressMessage;`,
    `          await sendReply(trimReply(progressMessage, 700));`,
    `        }`,
    `      }`,
    `    }`,
    `    if (snapshot.finished) {`,
    `      return;`,
    `    }`,
    `    await sleep(POLL_INTERVAL_MS);`,
    `  }`,
    `}`,
    ``,
    `async function dispatchClusterTask(payload, sendReply) {`,
    `  const taskText = extractTaskText(payload.text);`,
    `  if (!taskText) {`,
    `    return false;`,
    `  }`,
    `  await sendReply(trimReply(\`已接收任务，开始转发给 Agent 集群：\${taskText}\`, 500));`,
    `  const submission = await submitClusterTask({`,
    `    ...payload,`,
    `    text: taskText`,
    `  });`,
    `  await sendReply(\`任务已受理，编号：\${submission.operationId}\`);`,
    `  await followOperation(submission.operationId, sendReply);`,
    `  return true;`,
    `}`
  ].join("\n");
}

function renderWechatyRunner() {
  return [
    `import { WechatyBuilder } from "wechaty";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `const bot = WechatyBuilder.build({`,
    `  name: process.env.WECHATY_BOT_NAME || "agent-cluster-wechaty",`,
    `  puppet: process.env.WECHATY_PUPPET || undefined,`,
    `  puppetToken: process.env.WECHATY_PUPPET_SERVICE_TOKEN || process.env.WECHATY_PUPPET_TOKEN || undefined`,
    `});`,
    ``,
    `bot.on("scan", (qrcode) => {`,
    `  console.log("Wechaty QRCode:", qrcode);`,
    `});`,
    ``,
    `bot.on("login", (user) => {`,
    `  console.log("Wechaty logged in:", user?.name?.() || user?.id || "unknown");`,
    `});`,
    ``,
    `bot.on("message", async (message) => {`,
    `  try {`,
    `    if (message.self()) {`,
    `      return;`,
    `    }`,
    `    const text = await message.text();`,
    `    if (!extractTaskText(text)) {`,
    `      return;`,
    `    }`,
    `    const talker = message.talker();`,
    `    const room = message.room();`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: talker?.id || "",`,
    `      senderName: talker?.name?.() || "",`,
    `      chatId: room?.id || talker?.id || "",`,
    `      channelId: room?.id || "",`,
    `      raw: {`,
    `        type: message.type?.() || ""`,
    `      }`,
    `    }, async (replyText) => {`,
    `      await message.say(replyText);`,
    `    });`,
    `  } catch (error) {`,
    `    console.error("Wechaty bridge failed:", error);`,
    `    await message.say(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `});`,
    ``,
    `await bot.start();`,
    `console.log("Wechaty bridge started.");`
  ].join("\n");
}

function renderFeishuRunner() {
  return [
    `import * as lark from "@larksuiteoapi/node-sdk";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `function extractFeishuText(content) {`,
    `  try {`,
    `    const parsed = JSON.parse(content || "{}");`,
    `    return normalizeText(parsed.text || parsed.content || "");`,
    `  } catch {`,
    `    return normalizeText(content);`,
    `  }`,
    `}`,
    ``,
    `const appId = requiredEnv("FEISHU_APP_ID");`,
    `const appSecret = requiredEnv("FEISHU_APP_SECRET");`,
    `const client = new lark.Client({ appId, appSecret });`,
    `const eventDispatcher = new lark.EventDispatcher({}).register({`,
    `  "im.message.receive_v1": async (data) => {`,
    `    const event = data?.event || data || {};`,
    `    const message = event.message || {};`,
    `    const sender = event.sender || {};`,
    `    const text = extractFeishuText(message.content);`,
    `    if (!extractTaskText(text)) {`,
    `      return;`,
    `    }`,
    `    const sendReply = async (replyText) => {`,
    `      await client.im.message.create({`,
    `        params: { receive_id_type: "chat_id" },`,
    `        data: {`,
    `          receive_id: message.chat_id,`,
    `          msg_type: "text",`,
    `          content: JSON.stringify({ text: replyText })`,
    `        }`,
    `      });`,
    `    };`,
    `    try {`,
    `      await dispatchClusterTask({`,
    `        text,`,
    `        senderId: sender.sender_id?.open_id || "",`,
    `        senderName: "",`,
    `        chatId: message.chat_id || "",`,
    `        channelId: message.chat_id || "",`,
    `        raw: event`,
    `      }, sendReply);`,
    `    } catch (error) {`,
    `      console.error("Feishu bridge failed:", error);`,
    `      await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `    }`,
    `  }`,
    `});`,
    ``,
    `const wsClient = new lark.ws.Client({`,
    `  appId,`,
    `  appSecret,`,
    `  eventDispatcher`,
    `});`,
    ``,
    `wsClient.start();`,
    `console.log("Feishu bridge started.");`
  ].join("\n");
}

function renderDingtalkRunner() {
  return [
    `import * as dingtalk from "dingtalk-stream";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `function extractDingtalkText(message) {`,
    `  return normalizeText(message?.text?.content || message?.content?.text || message?.content || "");`,
    `}`,
    ``,
    `async function sendDingtalkReply(sessionWebhook, accessToken, text) {`,
    `  await fetch(sessionWebhook, {`,
    `    method: "POST",`,
    `    headers: {`,
    `      "Content-Type": "application/json",`,
    `      "x-acs-dingtalk-access-token": accessToken`,
    `    },`,
    `    body: JSON.stringify({`,
    `      msgtype: "text",`,
    `      text: { content: text }`,
    `    })`,
    `  });`,
    `}`,
    ``,
    `const credential = new dingtalk.Credential(requiredEnv("DINGTALK_CLIENT_ID"), requiredEnv("DINGTALK_CLIENT_SECRET"));`,
    `const client = new dingtalk.StreamClient(credential);`,
    ``,
    `client.registerCallbackHandler("chatbot.message", async (event) => {`,
    `  const message = event?.data || event || {};`,
    `  const text = extractDingtalkText(message);`,
    `  if (!extractTaskText(text)) {`,
    `    return dingtalk.AckMessage.OK;`,
    `  }`,
    `  const accessToken = await client.getAccessToken();`,
    `  const sessionWebhook = message.sessionWebhook || message.conversation?.sessionWebhook;`,
    `  const sendReply = async (replyText) => {`,
    `    if (!sessionWebhook) {`,
    `      return;`,
    `    }`,
    `    await sendDingtalkReply(sessionWebhook, accessToken, replyText);`,
    `  };`,
    `  try {`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: message.senderStaffId || "",`,
    `      senderName: message.senderNick || "",`,
    `      chatId: message.conversationId || "",`,
    `      channelId: message.conversationId || "",`,
    `      raw: message`,
    `    }, sendReply);`,
    `  } catch (error) {`,
    `    console.error("Dingtalk bridge failed:", error);`,
    `    await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `  return dingtalk.AckMessage.OK;`,
    `});`,
    ``,
    `await client.start();`,
    `console.log("Dingtalk bridge started.");`
  ].join("\n");
}

function renderQqRunner() {
  return [
    `import { createClient } from "qq-official-bot";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `const client = createClient({`,
    `  appid: requiredEnv("QQ_BOT_APP_ID"),`,
    `  secret: requiredEnv("QQ_BOT_SECRET"),`,
    `  sandbox: String(process.env.QQ_BOT_SANDBOX || "0") === "1"`,
    `});`,
    ``,
    `async function handleQqMessage(message) {`,
    `  const text = normalizeText(message?.content || "");`,
    `  if (!extractTaskText(text)) {`,
    `    return;`,
    `  }`,
    `  const sendReply = async (replyText) => {`,
    `    if (typeof message.reply === "function") {`,
    `      await message.reply(replyText);`,
    `      return;`,
    `    }`,
    `    if (client.api?.postMessage && message.channel_id) {`,
    `      await client.api.postMessage(message.channel_id, { content: replyText });`,
    `    }`,
    `  };`,
    `  try {`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: message.author?.id || "",`,
    `      senderName: message.author?.username || "",`,
    `      chatId: message.channel_id || "",`,
    `      channelId: message.channel_id || "",`,
    `      raw: message`,
    `    }, sendReply);`,
    `  } catch (error) {`,
    `    console.error("QQ bridge failed:", error);`,
    `    await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `}`,
    ``,
    `client.on("ready", () => {`,
    `  console.log("QQ bridge started.");`,
    `});`,
    `client.on("message", handleQqMessage);`,
    `client.on("atMessage", handleQqMessage);`,
    `await client.start();`
  ].join("\n");
}

function renderConnectorRunner(preset) {
  switch (preset.id) {
    case "wechaty":
      return renderWechatyRunner();
    case "feishu":
      return renderFeishuRunner();
    case "dingtalk":
      return renderDingtalkRunner();
    case "qq_guild":
      return renderQqRunner();
    default:
      throw new Error(`Unsupported connector preset "${preset.id}".`);
  }
}

async function writeConnectorScaffold(targetDir, preset) {
  const connectorPath = join(targetDir, "connector-runner.mjs");
  const envExamplePath = join(targetDir, ".env.example");
  const envText = (preset.envHints || []).join("\n");

  await writeFile(connectorPath, `${renderConnectorRunner(preset)}\n`, "utf8");
  await writeFile(envExamplePath, `${envText}\n`, "utf8");

  return {
    connectorPath,
    envExamplePath
  };
}

async function writeInstallArtifacts(targetDir, manifestPayload) {
  const manifestPath = join(targetDir, ".agent-cluster-bot-plugin.json");
  const readmePath = join(targetDir, "AGENT_CLUSTER_BOT_README.md");

  const readme = [
    `# ${manifestPayload.label}`,
    "",
    `- 渠道：${manifestPayload.channel}`,
    `- 来源：${manifestPayload.source}`,
    `- 文档：${manifestPayload.docsUrl}`,
    `- 安装时间：${manifestPayload.installedAt}`,
    "",
    "## 安装命令",
    "",
    "```bash",
    manifestPayload.installCommand,
    "```",
    "",
    "## 连接器说明",
    "",
    "已自动生成：",
    "- `connector-runner.mjs`：实际连接聊天平台并转发到 Agent 集群的脚本",
    "- `.env.example`：该平台需要填写的环境变量模板",
    "- `.agent-cluster-bot-plugin.json`：安装清单",
    "",
    "## 运行方式",
    "",
    "1. 在图形界面的 Bot 配置里安装并保存该预设。",
    "2. 把 `.env.example` 里的变量填到对应预设的“环境变量”输入框。",
    "3. 在界面里点击“启动全部 Bot”或启动单个预设。",
    "4. 在聊天里用命令前缀触发，例如 `/agent 请分析当前代码仓库`。",
    "",
    "## 环境变量模板",
    "",
    "```env",
    ...(manifestPayload.envHints || []),
    "```",
    "",
    "## 说明",
    "",
    manifestPayload.description,
    ""
  ].join("\n");

  await writeFile(manifestPath, `${JSON.stringify(manifestPayload, null, 2)}\n`, "utf8");
  await writeFile(readmePath, `${readme}\n`, "utf8");

  return {
    manifestPath,
    readmePath
  };
}

async function runShellCommand(commandText, { cwd, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS } = {}) {
  const { command, args } = buildShellCommand(commandText);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false"
      }
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const normalizedTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_INSTALL_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1200).unref();
    }, normalizedTimeout);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = trimCommandOutput(stdout, stderr);

      if (timedOut) {
        reject(new Error(`Command timed out after ${normalizedTimeout} ms: ${commandText}${output ? `\n${output}` : ""}`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `Command failed${code != null ? ` with exit code ${code}` : signal ? ` with signal ${signal}` : ""}: ${commandText}${output ? `\n${output}` : ""}`
          )
        );
        return;
      }

      resolve({
        code,
        signal,
        output
      });
    });
  });
}

async function prepareInstallTarget(workspaceDir, installDir, leafDir) {
  const workspaceRoot = await ensureWorkspaceDirectory(workspaceDir);
  const normalizedInstallDir = normalizeInstallDir(installDir);
  const target = resolveWorkspacePath(workspaceRoot, `${normalizedInstallDir}/${leafDir}`);
  await mkdir(target.absolutePath, { recursive: true });

  return {
    workspaceRoot,
    installDir: normalizedInstallDir,
    targetDir: target.absolutePath,
    targetRelativeDir: target.relativePath
  };
}

export function listBotPluginPresets() {
  return BOT_PLUGIN_PRESETS.map((preset) => ({
    ...preset,
    defaultInstallDir: DEFAULT_INSTALL_DIR
  }));
}

export async function installBotPluginPreset({
  workspaceDir,
  installDir = DEFAULT_INSTALL_DIR,
  presetId,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS
}) {
  const preset = getPresetById(presetId);
  if (!preset) {
    throw new Error(`Unknown bot preset "${presetId}".`);
  }

  const target = await prepareInstallTarget(workspaceDir, installDir, preset.id);
  if (preset.ecosystem === "npm") {
    await ensureNodePackage(target.targetDir, `${preset.id}-connector`, preset.label);
  }

  const commandText = preset.installCommand;
  const result = await runShellCommand(commandText, {
    cwd: target.targetDir,
    timeoutMs
  });

  const manifestPayload = buildManifestPayload({
    preset,
    installDir: target.installDir,
    targetRelativeDir: target.targetRelativeDir,
    commandText,
    commandOutput: result.output
  });
  const scaffold = await writeConnectorScaffold(target.targetDir, preset);
  const artifacts = await writeInstallArtifacts(target.targetDir, manifestPayload);

  return {
    preset: {
      id: preset.id,
      label: preset.label,
      docsUrl: preset.docsUrl
    },
    command: commandText,
    output: result.output,
    installDir: target.installDir,
    targetDir: target.targetDir,
    targetRelativeDir: target.targetRelativeDir,
    manifestPath: artifacts.manifestPath,
    readmePath: artifacts.readmePath,
    connectorPath: scaffold.connectorPath,
    envExamplePath: scaffold.envExamplePath
  };
}

export async function installBotCustomCommand({
  workspaceDir,
  installDir = DEFAULT_INSTALL_DIR,
  commandText,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS
}) {
  const normalizedCommand = String(commandText || "").trim();
  if (!normalizedCommand) {
    throw new Error("Custom bot install command is required.");
  }

  const preset = {
    id: "custom",
    label: "自定义 Bot 命令",
    channel: "Custom",
    source: "用户自定义",
    ecosystem: "shell",
    description: "通过图形界面的自定义命令执行安装。此目录不会自动生成平台连接器脚本。",
    docsUrl: "",
    installCommand: normalizedCommand,
    envHints: []
  };

  const target = await prepareInstallTarget(workspaceDir, installDir, "custom");
  if (/^(npm|pnpm|yarn)(\s|$)/i.test(normalizedCommand)) {
    await ensureNodePackage(target.targetDir, "custom-bot-connector", preset.label);
  }

  const result = await runShellCommand(normalizedCommand, {
    cwd: target.targetDir,
    timeoutMs
  });

  const manifestPayload = buildManifestPayload({
    preset,
    installDir: target.installDir,
    targetRelativeDir: target.targetRelativeDir,
    commandText: normalizedCommand,
    commandOutput: result.output
  });
  const artifacts = await writeInstallArtifacts(target.targetDir, manifestPayload);

  return {
    command: normalizedCommand,
    output: result.output,
    installDir: target.installDir,
    targetDir: target.targetDir,
    targetRelativeDir: target.targetRelativeDir,
    manifestPath: artifacts.manifestPath,
    readmePath: artifacts.readmePath
  };
}
