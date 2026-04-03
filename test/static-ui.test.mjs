import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSeaAssets, collectStaticAssets } from "../scripts/build-win-exe.mjs";
import { createAppState } from "../src/static/app-state.js";
import { getRunStateTextForEvent } from "../src/static/cluster-run-ui.js";
import { formatModelTestRetryStatus } from "../src/static/model-connectivity-service.js";
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
    getRunStateTextForEvent({ stage: "cluster_done" }, translate),
    "run.state.done:{}"
  );
  assert.equal(getRunStateTextForEvent({ stage: "unknown_stage" }, translate), "");
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
    "runButton",
    "cancelButton",
    "consoleNav",
    "agentVizStage",
    "schemeConnectivityRetestButton",
    "clearWorkspaceCacheButton"
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

test("app.js wires cluster run bootstrap explicitly", async () => {
  const appJs = await readFile(new URL("../src/static/app.js", import.meta.url), "utf8");

  assert.match(appJs, /import \{ startApp \} from "\.\/app-bootstrap\.js";/);
  assert.match(appJs, /startApp\(\);/);
  assert.doesNotMatch(appJs, /createClusterRunUi/);
});

test("app.js wires settings bootstrap explicitly", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");

  assert.match(bootstrapJs, /import \{ createSettingsUi \} from "\.\/settings-ui\.js";/);
  assert.match(bootstrapJs, /import \{ createLocaleUi \} from "\.\/locale-ui\.js";/);
  assert.match(bootstrapJs, /settingsUi = createSettingsUi\(/);
  assert.match(bootstrapJs, /const bindingSteps = \[/);
  assert.match(bootstrapJs, /settingsUi\.loadSettings\(\)/);
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
});

test("app bootstrap refreshes locale-sensitive modules on language changes", async () => {
  const bootstrapJs = await readFile(new URL("../src/static/app-bootstrap.js", import.meta.url), "utf8");

  assert.match(bootstrapJs, /runConsoleUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /connectivityUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /clusterRunUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /settingsUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /workspaceUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /modelsSchemesUi\?\.refreshLocale\?\.\(\)/);
  assert.match(bootstrapJs, /botUi\?\.refreshLocale\?\.\(\)/);
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

test("ui-core shared helpers normalize text lists and render escaped list output", () => {
  assert.deepEqual(normalizeStringList("alpha, beta\nalpha锛沢amma"), ["alpha", "beta", "gamma"]);
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
  assert.match(
    workspaceJs,
    /clearWorkspaceCacheButton\?\.addEventListener\("click", clearClusterCache\);/
  );
  assert.match(workspaceJs, /function refreshLocale\(/);
});

test("bot and scheme UI expose refreshLocale for runtime language switching", async () => {
  const botJs = await readFile(new URL("../src/static/bot-ui.js", import.meta.url), "utf8");
  const schemesJs = await readFile(new URL("../src/static/models-schemes-ui.js", import.meta.url), "utf8");

  assert.match(botJs, /function refreshLocale\(/);
  assert.match(schemesJs, /function refreshLocale\(/);
});

test("gitignore covers local secrets and packaged executables", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");

  assert.match(gitignore, /^cluster\.config\.json$/m);
  assert.match(gitignore, /^runtime\.settings\.json$/m);
  assert.match(gitignore, /^dist\/runtime\.settings\.json$/m);
  assert.match(gitignore, /^dist\/\*\.exe$/m);
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
  assert.match(chineseReadme, /GPL-2\.0-only/);
  assert.match(chineseReadme, /cluster\.config\.blank\.json/);
  assert.match(chineseReadme, /dist\/\*\.exe/);
});
