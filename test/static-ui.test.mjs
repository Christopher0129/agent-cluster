import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSeaAssets,
  collectStaticAssets,
  escapeNonAsciiForJs,
  parseImportClause,
  transformModuleSource,
  patchPeSubsystemBuffer
} from "../scripts/build-win-exe.mjs";
import { createAppState } from "../src/static/app-state.js";
import { buildAgentLayout } from "../src/static/agent-graph-layout.js";
import { getRunStateTextForEvent } from "../src/static/cluster-run-ui.js";
import { formatModelTestRetryStatus } from "../src/static/model-connectivity-service.js";
import { buildChatEntryFromEvent } from "../src/static/multi-agent-ui.js";
import { describeOperationEvent } from "../src/static/operation-events.js";
import { mergeSecretEntries } from "../src/static/secrets-ui.js";
import { normalizeStringList, renderList } from "../src/static/ui-core.js";

test("getRunStateTextForEvent maps cluster lifecycle stages", () => {
  const translate = (key, values = {}) => `${key}:${JSON.stringify(values)}`;

  assert.equal(
    getRunStateTextForEvent({ stage: "planning_start" }, translate),
    "run.state.planning:{}"
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "phase_start", phase: "research" }, translate),
    "run.state.research:{}"
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "phase_start", phase: "implementation" }, translate),
    "run.state.implementation:{}"
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "worker_retry", attempt: 2, maxRetries: 4 }, translate),
    'run.state.retrying:{"attempt":2,"maxRetries":4}'
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "worker_fallback" }, translate),
    "run.state.fallback:{}"
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "controller_fallback" }, translate),
    "run.state.controllerFallback:{}"
  );
  assert.equal(
    getRunStateTextForEvent({ stage: "cluster_done" }, translate),
    "run.state.done:{}"
  );
  assert.equal(getRunStateTextForEvent({ stage: "unknown_stage" }, translate), "");
});

test("describeOperationEvent localizes workspace tool blocked events instead of exposing raw English detail", () => {
  const blockedCommandText = describeOperationEvent(
    {
      stage: "workspace_tool_blocked",
      agentLabel: "Validator Agent",
      detail: "Blocked run_command because workspace commands are out of scope for this task."
    },
    {
      formatDelay: (value) => String((value ?? 0) + " ms")
    }
  );
  const blockedWriteText = describeOperationEvent(
    {
      stage: "workspace_tool_blocked",
      agentLabel: "Validator Agent",
      detail: "Blocked write_files because workspace writes are out of scope for this task."
    },
    {
      formatDelay: (value) => String((value ?? 0) + " ms")
    }
  );

  assert.match(blockedCommandText, /当前任务不允许执行工作区命令/);
  assert.doesNotMatch(blockedCommandText, /Blocked run_command/);
  assert.match(blockedWriteText, /当前任务不允许写入工作区文件/);
  assert.doesNotMatch(blockedWriteText, /Blocked write_files/);
});

test("describeOperationEvent localizes workspace web search states", () => {
  const searchedText = describeOperationEvent({
    stage: "workspace_web_search",
    agentLabel: "调研 Agent",
    detail: "2026-04-03 A-share market statistics"
  });
  const blockedText = describeOperationEvent({
    stage: "workspace_tool_blocked",
    agentLabel: "调研 Agent",
    toolAction: "web_search",
    detail: "Blocked web_search because web search is not enabled for this model."
  });

  assert.match(searchedText, /网页搜索/);
  assert.doesNotMatch(blockedText, /Blocked web_search/);
  assert.match(blockedText, /当前任务不允许网页搜索/);
});

test("describeOperationEvent renders workspace JSON repair as a completed auto-fix", () => {
  const repairText = describeOperationEvent({
    stage: "workspace_json_repair",
    agentLabel: "调研下属03 · kimi code"
  });

  assert.match(repairText, /自动修复|鑷姩淇/);
  assert.doesNotMatch(repairText, /正在修复/);
});

test("describeOperationEvent localizes worker fallback events", () => {
  const fallbackText = describeOperationEvent({
    stage: "worker_fallback",
    agentLabel: "Research Leader ? kimi2.5",
    previousWorkerLabel: "Research Leader ? kimi2.5",
    fallbackWorkerLabel: "Research Leader ? gpt-5.4"
  });

  assert.match(fallbackText, /已从/);
  assert.match(fallbackText, /切换到/);
  assert.match(fallbackText, /provider 故障/);
});

test("describeOperationEvent localizes controller fallback events", () => {
  const fallbackText = describeOperationEvent({
    stage: "controller_fallback",
    agentLabel: "Controller Agent ? gpt-5.4-mini",
    previousControllerLabel: "Controller Agent ? gpt-5.4",
    fallbackControllerLabel: "Controller Agent ? gpt-5.4-mini"
  });

  assert.match(fallbackText, /已从/);
  assert.match(fallbackText, /切换到/);
  assert.match(fallbackText, /provider 故障/);
});

test("describeOperationEvent localizes phase labels in Chinese mode", () => {
  const phaseText = describeOperationEvent({
    stage: "phase_start",
    phase: "handoff"
  });

  assert.match(phaseText, /交付/);
});
test("index.html preserves critical control ids for app bindings", async () => {
  const html = await readFile(new URL("../src/static/index.html", import.meta.url), "utf8");
  const requiredIds = [
    "saveButton",
    "languageSelect",
    "reloadButton",
    "exitAppButton",
    "schemeSelect",
    "schemeNameInput",
    "addSchemeButton",
    "removeSchemeButton",
    "addSecretButton",
    "batchAddButton",
    "addModelButton",
    "batchRoleSelect",
    "batchThinkingInput",
    "multiAgentEnabledInput",
    "multiAgentModeSelect",
    "multiAgentSpeakerStrategySelect",
    "multiAgentChatroom",
    "runButton",
    "cancelButton",
    "consoleNav",
    "agentVizStage",
    "schemeConnectivityRetestButton",
    "clearWorkspaceCacheButton",
    "subagentRetryFallbackThresholdInput"
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }

  assert.match(html, /data-model-role/);
  assert.match(html, /data-model-thinking/);
});

test("index.html defaults the run viewport chrome to Chinese labels", async () => {
  const html = await readFile(new URL("../src/static/index.html", import.meta.url), "utf8");

  assert.match(html, /&#23454;&#26102;/);
  assert.match(html, /&#20219;&#21153; Trace/);
  assert.match(html, /&#20250;&#35805;&#32479;&#35745;/);
  assert.match(html, /&#20195;&#29702;&#38598;&#32676;/);
});

test("index.html defaults hidden templates and chips to Chinese labels", async () => {
  const html = await readFile(new URL("../src/static/index.html", import.meta.url), "utf8");

  assert.match(html, />集群</);
  assert.match(html, />方案</);
  assert.match(html, />阶段</);
  assert.match(html, />框架</);
  assert.match(html, /data-panel-kicker="工作区"/);
  assert.match(html, />仅工作</);
  assert.match(html, />仅主控</);
  assert.match(html, />主控 \+ 工作</);
});

test("locale-ui ships repaired Chinese workspace and navigation strings", async () => {
  const localeUi = await readFile(new URL("../src/static/locale-ui.js", import.meta.url), "utf8");

  assert.match(localeUi, /正在读取工作区/);
  assert.match(localeUi, /工作区目录/);
  assert.match(localeUi, /集群设置/);
  assert.doesNotMatch(localeUi, /姝ｅ湪璇诲彇宸ヤ綔鍖|闆嗙兢璁剧疆/);
});

test("app.js wires cluster run bootstrap explicitly", async () => {
  const appJs = await readFile(new URL("../src/static/app.js", import.meta.url), "utf8");

  assert.match(appJs, /import \{ startApp \} from "\.\/app-bootstrap\.js";/);
  assert.match(appJs, /startApp\(\);/);
  assert.doesNotMatch(appJs, /createClusterRunUi/);
});

test("sea main relaunches the packaged app hidden on Windows unless show-console is requested", async () => {
  const seaMain = await readFile(new URL("../src/sea-main.mjs", import.meta.url), "utf8");

  assert.match(seaMain, /const HIDDEN_LAUNCH_ARG = "--sea-hidden-launch";/);
  assert.match(seaMain, /const SHOW_CONSOLE_ARG = "--show-console";/);
  assert.match(seaMain, /windowsHide: true/);
  assert.match(seaMain, /process\.exit\(0\);/);
});

test("app.js wires settings bootstrap explicitly", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");
  const multiAgentBlockMatch = bootstrapJs.match(/multiAgentUi = createMultiAgentUi\(\{([\s\S]*?)\n  \}\);/);

  assert.match(bootstrapJs, /import \{ createSettingsUi \} from "\.\/settings-ui\.js";/);
  assert.match(bootstrapJs, /import \{ createLocaleUi \} from "\.\/locale-ui\.js";/);
  assert.match(bootstrapJs, /import \{ createMultiAgentUi \} from "\.\/multi-agent-ui\.js";/);
  assert.match(bootstrapJs, /settingsUi = createSettingsUi\(/);
  assert.match(bootstrapJs, /batchRoleSelect: elements\.batchRoleSelect/);
  assert.match(bootstrapJs, /const bindingSteps = \[/);
  assert.match(bootstrapJs, /settingsUi\.loadSettings\(\)/);
  assert.ok(multiAgentBlockMatch, "createMultiAgentUi block should exist");
  assert.doesNotMatch(
    multiAgentBlockMatch[1],
    /translate:\s*\(\.\.\.args\)\s*=>\s*localeUi\.t\(\.\.\.args\)/
  );
});
test("app bootstrap binds all interactive module event handlers", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");

  assert.match(bootstrapJs, /localeUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /shellUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /secretsUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /agentVizUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /clusterRunUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /settingsUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /modelsSchemesUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /workspaceUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /botUi\.bindEvents\(\)/);
  assert.match(bootstrapJs, /multiAgentUi\.bindEvents\(\)/);
});

test("app bootstrap refreshes locale-sensitive modules on language changes", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");

  assert.match(bootstrapJs, /runConsoleUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /connectivityUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /clusterRunUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /settingsUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /agentVizUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /workspaceUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /modelsSchemesUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /botUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /multiAgentUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /getLocale:\s*\(\)\s*=>\s*localeUi\.getLocale\(\)/);
});

test("agent viz UI ships localized empty-state and inspector strings", async () => {
  const agentVizJs = await readFile(new URL("../src/static/agent-viz-ui.js", import.meta.url), "utf8");

  assert.match(agentVizJs, /等待集群启动/);
  assert.match(agentVizJs, /公开推理与轨迹/);
  assert.match(agentVizJs, /refreshLocale/);
});

test("run console UI wraps all run-result panels in collapsible details panels", async () => {
  const runConsoleUiJs = await readFile(new URL("../src/static/run-console-ui.js", import.meta.url), "utf8");
  const styleCss = await readFile(new URL("../src/static/style.css", import.meta.url), "utf8");

  assert.match(runConsoleUiJs, /panelId: "liveStatusPanel"/);
  assert.match(runConsoleUiJs, /panelId: "taskPlanPanel"/);
  assert.match(runConsoleUiJs, /panelId: "workerResultsPanel"/);
  assert.match(runConsoleUiJs, /panelId: "finalSynthesisPanel"/);
  assert.match(runConsoleUiJs, /panelId: "taskTracePanel"/);
  assert.match(runConsoleUiJs, /panelId: "sessionStatsPanel"/);
  assert.match(runConsoleUiJs, /fold-summary-indicator/);
  assert.match(styleCss, /\.fold-summary-indicator/);
  assert.match(styleCss, /\.trace-fold-panel \.fold-summary-indicator/);
});

test("models and schemes UI exposes explicit model-role routing controls", async () => {
  const uiJs = await readFile(new URL("../src/static/models-schemes-ui.js", import.meta.url), "utf8");

  assert.match(uiJs, /const MODEL_ROLE_OPTIONS = \[/);
  assert.match(uiJs, /function populateModelRoleSelect\(/);
  assert.match(uiJs, /function modelCanActAsController\(/);
  assert.match(uiJs, /controller\.noneEligible/);
  assert.match(uiJs, /data-model-role/);
  assert.match(uiJs, /batchRoleSelect/);
});

test("models and schemes UI localizes model card field labels on render", async () => {
  const uiJs = await readFile(new URL("../src/static/models-schemes-ui.js", import.meta.url), "utf8");

  assert.match(uiJs, /function localizeModelCard\(/);
  assert.match(uiJs, /field\.provider/);
  assert.match(uiJs, /field\.thinking/);
  assert.match(uiJs, /button\.testConnection/);
});

test("cluster run live feed uses operation-event localization directly", async () => {
  const runUiJs = await readFile(new URL("../src/static/cluster-run-ui.js", import.meta.url), "utf8");

  assert.match(runUiJs, /describeOperationEventMessage\(event, \{ formatDelay \}\)/);
  assert.doesNotMatch(runUiJs, /describeOperationEventMessage\(event, \{ formatDelay, translate \}\)/);
});

test("cluster run UI finalizes local cancellation immediately and syncs backend cancel asynchronously", async () => {
  const runUiJs = await readFile(new URL("../src/static/cluster-run-ui.js", import.meta.url), "utf8");

  assert.match(runUiJs, /const CANCEL_REQUEST_TIMEOUT_MS = 4000;/);
  assert.match(runUiJs, /locale:\s*typeof getLocale === "function" \? getLocale\(\) : resolveRuntimeLocale\(\)/);
  assert.match(runUiJs, /void finalizeRemoteCancellation\(operationId\);/);
  assert.match(runUiJs, /finishOperation\(\{ closeDelayMs: 0 \}\);/);
  assert.match(runUiJs, /run\.cancel\.renderRemote/);
  assert.match(runUiJs, /run\.cancel\.renderRemoteSettled/);
  assert.match(runUiJs, /setSaveStatus\?\.\(translate\("run\.cancel\.renderRemoteFailed"\), "warning"\);/);
  assert.match(runUiJs, /onOperationEvent = null/);
  assert.match(runUiJs, /onOperationStart = null/);
  assert.match(runUiJs, /onOperationFinish = null/);
  assert.match(runUiJs, /onOperationEvent\?\.\(event, currentOperationId\)/);
  assert.match(runUiJs, /onOperationStart\?\.\(operationId\)/);
  assert.match(runUiJs, /onOperationFinish\?\.\(finishedOperationId\)/);
});

test("multi-agent chatroom prioritizes participant count and filters non-conversation events", async () => {
  const multiAgentUiJs = await readFile(new URL("../src/static/multi-agent-ui.js", import.meta.url), "utf8");
  const styleCss = await readFile(new URL("../src/static/style.css", import.meta.url), "utf8");

  assert.match(multiAgentUiJs, /const CONVERSATIONAL_STAGE_SET = new Set\(\[/);
  assert.match(multiAgentUiJs, /"leader_delegate_done"/);
  assert.match(multiAgentUiJs, /if \(!isConversationalStage\(stage\)\) \{\s*return null;\s*\}/);
  assert.match(multiAgentUiJs, /multiAgentChatSummary\.hidden = true;/);
  assert.match(multiAgentUiJs, /participants: state\.session\.participantCount \|\| 0/);
  assert.match(styleCss, /\.multi-agent-chat-summary\[hidden\]/);
  assert.match(styleCss, /\.agent-viz-lower \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/s);
});

test("buildChatEntryFromEvent renders subagent assignment and acknowledgement as dialogue", () => {
  const settings = {
    includeSystemMessages: true,
    summarizeLongMessages: true
  };
  const created = buildChatEntryFromEvent(
    {
      stage: "subagent_created",
      timestamp: "2026-04-05T10:00:00.000Z",
      parentAgentLabel: "Research Leader",
      agentLabel: "Research Child 01",
      taskTitle: "Collect policy updates",
      content: "Review the newest policy notes and return concise bullets."
    },
    settings
  );
  const started = buildChatEntryFromEvent(
    {
      stage: "subagent_start",
      timestamp: "2026-04-05T10:00:01.000Z",
      parentAgentLabel: "Research Leader",
      agentLabel: "Research Child 01",
      taskTitle: "Collect policy updates",
      content: "Review the newest policy notes and return concise bullets."
    },
    settings
  );

  assert.equal(created?.speakerLabel, "Research Leader");
  assert.equal(created?.targetLabel, "Research Child 01");
  assert.match(created?.content || "", /请接手/);
  assert.equal(started?.speakerLabel, "Research Child 01");
  assert.equal(started?.targetLabel, "Research Leader");
  assert.match(started?.content || "", /已接单/);
});

test("orchestrator publishes richer chat content for collaboration events", async () => {
  const orchestratorJs = await readFile(new URL("../src/cluster/orchestrator.mjs", import.meta.url), "utf8");

  assert.match(orchestratorJs, /content:\s*agentTask\.instructions \|\| agentTask\.title \|\| ""/);
  assert.match(orchestratorJs, /summary:\s*result\.output\.summary \|\| ""/);
  assert.match(orchestratorJs, /targetAgentLabel:\s*agent\.parentAgentLabel \|\| ""/);
  assert.match(
    orchestratorJs,
    /content:\s*(?:subtask|entry\.subtask)\.instructions \|\| (?:subtask|entry\.subtask)\.title \|\| ""/
  );
});

test("buildAgentLayout expands subordinate radius for crowded child branches", () => {
  const controller = {
    id: "controller",
    kind: "controller",
    label: "Controller",
    status: "delegating"
  };
  const leader = {
    id: "leader:research_leader",
    kind: "leader",
    label: "Research Leader",
    phase: "research",
    status: "running"
  };
  const compactLayout = buildAgentLayout(
    [
      controller,
      leader,
      {
        id: "leader:research_leader::child_01",
        kind: "subordinate",
        label: "Child 01",
        parentId: leader.id,
        phase: "research",
        status: "running"
      }
    ],
    {
      controllerId: controller.id
    }
  );
  const crowdedLayout = buildAgentLayout(
    [
      controller,
      leader,
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `leader:research_leader::child_${String(index + 1).padStart(2, "0")}`,
        kind: "subordinate",
        label: `Child ${String(index + 1).padStart(2, "0")}`,
        parentId: leader.id,
        phase: "research",
        status: "running"
      }))
    ],
    {
      controllerId: controller.id
    }
  );

  const compactOrbit = Math.max(
    ...compactLayout.nodes
      .filter((node) => node.agent.kind === "subordinate")
      .map((node) => node.orbitRadius)
  );
  const crowdedOrbit = Math.max(
    ...crowdedLayout.nodes
      .filter((node) => node.agent.kind === "subordinate")
      .map((node) => node.orbitRadius)
  );

  assert.equal(crowdedLayout.nodes.filter((node) => node.agent.kind === "subordinate").length, 12);
  assert.equal(crowdedOrbit > compactOrbit, true);
  assert.equal(crowdedLayout.groups[0].bandOuterRadius > compactLayout.groups[0].bandOuterRadius, true);
});

test("SEA asset collection includes modular static files", async () => {
  const staticAssets = await collectStaticAssets();
  const seaAssets = await buildSeaAssets();

  assert.equal(
    staticAssets["static/app.js"]?.endsWith("src\\static\\app.js") ||
      staticAssets["static/app.js"]?.endsWith("src/static/app.js"),
    true
  );
  assert.equal(
    staticAssets["static/app-bootstrap.js"]?.endsWith("src\\static\\app-bootstrap.js") ||
      staticAssets["static/app-bootstrap.js"]?.endsWith("src/static/app-bootstrap.js"),
    true
  );
  assert.equal(
    staticAssets["static/settings-ui.js"]?.endsWith("src\\static\\settings-ui.js") ||
      staticAssets["static/settings-ui.js"]?.endsWith("src/static/settings-ui.js"),
    true
  );
  assert.equal(
    staticAssets["static/secrets-ui.js"]?.endsWith("src\\static\\secrets-ui.js") ||
      staticAssets["static/secrets-ui.js"]?.endsWith("src/static/secrets-ui.js"),
    true
  );
  assert.equal(seaAssets["cluster.config.json"] != null, true);
  assert.equal(seaAssets["static/app-bootstrap.js"] != null, true);
});

test("patchPeSubsystemBuffer flips Windows executables to the GUI subsystem", () => {
  const buffer = Buffer.alloc(256, 0);
  const peHeaderOffset = 0x80;
  const optionalHeaderOffset = peHeaderOffset + 4 + 20;
  const subsystemOffset = optionalHeaderOffset + 68;

  buffer.writeUInt32LE(peHeaderOffset, 0x3c);
  buffer.write("PE\u0000\u0000", peHeaderOffset, "binary");
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  buffer.writeUInt16LE(3, subsystemOffset);

  patchPeSubsystemBuffer(buffer);

  assert.equal(buffer.readUInt16LE(subsystemOffset), 2);
});

test("SEA import transformer supports mixed default and named imports", () => {
  const transformed = transformModuleSource(
    'import process, { argv, execPath } from "node:process";\nexport function readRuntime() {\n  return [typeof process, argv.length, execPath.length];\n}\n',
    fileURLToPath(new URL("../src/sea-main.mjs", import.meta.url)),
    new Set()
  );

  assert.match(transformed, /const __importedModule1 = require\("node:process"\);/);
  assert.match(transformed, /const process = __importedModule1;/);
  assert.match(transformed, /const \{ argv, execPath \} = __importedModule1;/);
  assert.doesNotMatch(transformed, /const process, \{ argv, execPath \}/);
  assert.doesNotThrow(() => new Function("require", "module", "exports", transformed));
});

test("parseImportClause supports default plus namespace imports", () => {
  const parsed = parseImportClause(
    "runtime, * as processModule",
    'require("node:process")',
    "__importedModule9"
  );

  assert.match(parsed, /const __importedModule9 = require\("node:process"\);/);
  assert.match(parsed, /const runtime = __importedModule9;/);
  assert.match(parsed, /const processModule = __importedModule9;/);
});

test("SEA bundle transformer escapes non-ASCII source safely", () => {
  const escaped = escapeNonAsciiForJs('const text = "用户请求终止任务。";\n');

  assert.equal(/[^\x00-\x7f]/.test(escaped), false);
  assert.match(escaped, /\\u7528\\u6237/);
  assert.doesNotThrow(() => new Function(escaped));
});

test("ui-core shared helpers normalize text lists and render escaped list output", () => {
  assert.deepEqual(normalizeStringList("alpha, beta\nalpha\ngamma"), ["alpha", "beta", "gamma"]);
  assert.match(renderList([], "Empty list."), /Empty list\./);
  assert.match(renderList(["<tag>"]), /&lt;tag&gt;/);
});

test("secret merging keeps the latest value per secret name", () => {
  assert.deepEqual(
    mergeSecretEntries(
      [
        { name: "OPENAI_API_KEY", value: "old" },
        { name: "", value: "ignored" }
      ],
      [
        { name: "OPENAI_API_KEY", value: "new" },
        { name: "AZURE_OPENAI_KEY", value: "azure" }
      ]
    ),
    [
      { name: "OPENAI_API_KEY", value: "new" },
      { name: "AZURE_OPENAI_KEY", value: "azure" }
    ]
  );
});

test("app state factory returns fresh state containers", () => {
  const left = createAppState();
  const right = createAppState();

  assert.notEqual(left.knownModelConfigs, right.knownModelConfigs);
  assert.notEqual(left.schemeUiState.connectivityBySchemeId, right.schemeUiState.connectivityBySchemeId);
  assert.notEqual(left.botUiState.enabledPresetIds, right.botUiState.enabledPresetIds);
  assert.notEqual(left.multiAgentUiState, right.multiAgentUiState);
  assert.equal(left.traceUiState.session, null);
});

test("formatModelTestRetryStatus includes retry counters and delay", () => {
  const text = formatModelTestRetryStatus({
    attempt: 2,
    maxRetries: 4,
    nextDelayMs: 1500
  });

  assert.match(text, /2\/4/);
  assert.match(text, /1\.5/);
});

test("workspace UI keeps the clear-cache button wired", async () => {
  const workspaceJs = await readFile(new URL("../src/static/workspace-ui.js", import.meta.url), "utf8");

  assert.match(workspaceJs, /function clearClusterCache\(/);
  assert.match(workspaceJs, /const REALTIME_REFRESH_INTERVAL_MS = 2500;/);
  assert.match(workspaceJs, /function refreshWorkspaceState\(/);
  assert.match(workspaceJs, /function handleOperationEvent\(/);
  assert.match(workspaceJs, /function startRealtimeRefresh\(/);
  assert.match(workspaceJs, /function stopRealtimeRefresh\(/);
  assert.match(workspaceJs, /workspaceDirInput\?\.addEventListener\("change"/);
  assert.match(workspaceJs, /workspaceFilePathInput\?\.addEventListener\("change"/);
  assert.match(workspaceJs, /stage === "workspace_write"/);
  assert.match(workspaceJs, /generatedFiles\[0\]/);
  assert.match(workspaceJs, /const FOLDER_PICK_POLL_INTERVAL_MS = 400;/);
  assert.match(workspaceJs, /\/api\/system\/pick-folder\?jobId=/);
  assert.match(workspaceJs, /payload\.status === "pending"/);
  assert.match(
    workspaceJs,
    /clearWorkspaceCacheButton\?\.addEventListener\("click", clearClusterCache\);/
  );
  assert.match(workspaceJs, /function refreshLocale\(/);
});

test("windows folder dialog launches hidden and in STA mode", async () => {
  const dialogsJs = await readFile(new URL("../src/system/dialogs.mjs", import.meta.url), "utf8");

  assert.match(dialogsJs, /"-Sta"/);
  assert.match(dialogsJs, /"-WindowStyle"/);
  assert.match(dialogsJs, /windowsHide: true/);
});

test("bot and scheme UI expose refreshLocale for runtime language switching", async () => {
  const botJs = await readFile(new URL("../src/static/bot-ui.js", import.meta.url), "utf8");
  const schemesJs = await readFile(new URL("../src/static/models-schemes-ui.js", import.meta.url), "utf8");
  const connectivityJs = await readFile(new URL("../src/static/connectivity-ui.js", import.meta.url), "utf8");

  assert.match(botJs, /function refreshLocale\(/);
  assert.match(schemesJs, /function refreshLocale\(/);
  assert.match(connectivityJs, /function refreshLocale\(/);
});

test("app bootstrap wires workspace realtime refresh to cluster-run lifecycle", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");

  assert.match(bootstrapJs, /onOperationEvent:\s*\(event\)\s*=>\s*workspaceUi\.handleOperationEvent\(event\)/);
  assert.match(bootstrapJs, /onOperationStart:\s*\(\)\s*=>\s*workspaceUi\.startRealtimeRefresh\(\)/);
  assert.match(bootstrapJs, /onOperationFinish:\s*\(\)\s*=>\s*workspaceUi\.stopRealtimeRefresh\(\)/);
});

test("critical static UI modules remain importable as ES modules", async () => {
  for (const relativePath of [
    "../src/static/locale-ui.js",
    "../src/static/multi-agent-ui.js",
    "../src/static/settings-ui.js",
    "../src/static/workspace-ui.js",
    "../src/static/app-bootstrap.js"
  ]) {
    const moduleUrl = `${pathToFileURL(fileURLToPath(new URL(relativePath, import.meta.url))).href}?test=${Date.now()}`;
    await assert.doesNotReject(() => import(moduleUrl));
  }
});

test("gitignore covers local secrets and packaged executables", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  assert.match(gitignore, /^cluster\.config\.json$/m);
  assert.match(gitignore, /^runtime\.settings\.json$/m);
  assert.match(gitignore, /^dist\/runtime\.settings\.json$/m);
  assert.match(gitignore, /^dist\/\*\.exe$/m);
  assert.match(gitignore, /^task-logs\/$/m);
  assert.match(gitignore, /^\/dist\/task-logs\/$/m);
  assert.match(gitignore, /^\/dist-verify\/$/m);
});

test("package metadata declares author and GPL license", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(packageJson.license, "GPL-2.0-only");
  assert.equal(typeof packageJson.author, "string");
  assert.equal(packageJson.author.length > 0, true);
});

test("root readme provides language selection links", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /\[English\]\(\.\/README\.en\.md\)/);
  assert.match(readme, /\[Simplified Chinese\]\(\.\/README\.zh-CN\.md\)/);
  assert.match(readme, /GPL-2\.0-only/);
});

test("english and chinese readmes include privacy note and license", async () => {
  const englishReadme = await readFile(new URL("../README.en.md", import.meta.url), "utf8");
  const chineseReadme = await readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8");

  assert.match(englishReadme, /GPL-2\.0-only/);
  assert.match(englishReadme, /cluster\.config\.blank\.json/);
  assert.match(englishReadme, /dist\/\*\.exe/);
  assert.match(englishReadme, /https:\/\/api\.moonshot\.cn\/anthropic/);
  assert.match(englishReadme, /\$web_search/);
  assert.match(chineseReadme, /GPL-2\.0-only/);
  assert.match(chineseReadme, /cluster\.config\.blank\.json/);
  assert.match(chineseReadme, /dist\/\*\.exe/);
  assert.match(chineseReadme, /https:\/\/api\.moonshot\.cn\/anthropic/);
  assert.match(chineseReadme, /\$web_search/);
});
