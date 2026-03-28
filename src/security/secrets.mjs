import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SETTINGS_ENCRYPTION_VERSION = 1;
const LOCAL_KEY_FILENAME = ".agent-cluster.key";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSecretMap(secrets) {
  const normalized = {};
  if (!secrets || typeof secrets !== "object") {
    return normalized;
  }

  for (const [name, value] of Object.entries(secrets)) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      continue;
    }
    normalized[normalizedName] = String(value ?? "");
  }

  return normalized;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShellSync(script, env = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script)
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      }
    }
  );

  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || "PowerShell secret operation failed.").trim()
    );
  }

  return String(result.stdout || "").trim();
}

function protectWindowsDpapiSync(plainText) {
  const payload = Buffer.from(String(plainText || ""), "utf8").toString("base64");
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_CLUSTER_SECRET_INPUT_B64))
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
ConvertFrom-SecureString $secure
`;

  return {
    provider: "windows-dpapi",
    version: SETTINGS_ENCRYPTION_VERSION,
    payload: runPowerShellSync(script, {
      AGENT_CLUSTER_SECRET_INPUT_B64: payload
    })
  };
}

function unprotectWindowsDpapiSync(blob) {
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$secure = ConvertTo-SecureString $env:AGENT_CLUSTER_SECRET_INPUT
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain))
} finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
`;

  const base64 = runPowerShellSync(script, {
    AGENT_CLUSTER_SECRET_INPUT: String(blob?.payload || "")
  });
  return Buffer.from(base64, "base64").toString("utf8");
}

function resolveLocalKeyPath(settingsPath) {
  return join(dirname(settingsPath), LOCAL_KEY_FILENAME);
}

function loadOrCreateLocalKeySync(settingsPath) {
  const configured = String(process.env.AGENT_CLUSTER_MASTER_KEY || "").trim();
  if (configured) {
    return createHash("sha256").update(configured).digest();
  }

  const keyPath = resolveLocalKeyPath(settingsPath);
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  }

  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${key.toString("base64")}\n`, "utf8");
  return key;
}

function protectLocalAesSync(plainText, settingsPath) {
  const key = loadOrCreateLocalKeySync(settingsPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(String(plainText || ""), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    provider: "local-aes-gcm",
    version: SETTINGS_ENCRYPTION_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    payload: payload.toString("base64")
  };
}

function unprotectLocalAesSync(blob, settingsPath) {
  const key = loadOrCreateLocalKeySync(settingsPath);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(blob?.iv || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(blob?.tag || ""), "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(blob?.payload || ""), "base64")),
    decipher.final()
  ]);
  return plain.toString("utf8");
}

export function protectSecretMapSync(secrets, { settingsPath } = {}) {
  const normalizedSecrets = normalizeSecretMap(secrets);
  if (!Object.keys(normalizedSecrets).length) {
    return null;
  }

  const plainText = JSON.stringify(normalizedSecrets);
  if (process.platform === "win32") {
    return protectWindowsDpapiSync(plainText);
  }

  return protectLocalAesSync(plainText, settingsPath);
}

export function unprotectSecretMapSync(blob, { settingsPath } = {}) {
  if (!blob || typeof blob !== "object") {
    return {};
  }

  const provider = String(blob.provider || "").trim();
  let plainText = "";

  if (provider === "windows-dpapi") {
    plainText = unprotectWindowsDpapiSync(blob);
  } else if (provider === "local-aes-gcm") {
    plainText = unprotectLocalAesSync(blob, settingsPath);
  } else {
    throw new Error(`Unsupported secret encryption provider "${provider}".`);
  }

  return normalizeSecretMap(JSON.parse(plainText));
}

export function materializeSavedSettingsSync(settingsPath, rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object") {
    return rawSettings;
  }

  const settings = cloneJson(rawSettings);
  if (settings.secretsEncrypted && !settings.secrets) {
    settings.secrets = unprotectSecretMapSync(settings.secretsEncrypted, { settingsPath });
    return settings;
  }

  if (settings.secrets && !settings.secretsEncrypted) {
    settings.secrets = normalizeSecretMap(settings.secrets);
    settings.secretsEncrypted = protectSecretMapSync(settings.secrets, { settingsPath });
    const toPersist = cloneJson(settings);
    delete toPersist.secrets;
    writeFileSync(settingsPath, `${JSON.stringify(toPersist, null, 2)}\n`, "utf8");
    return settings;
  }

  settings.secrets = normalizeSecretMap(settings.secrets);
  return settings;
}

export function serializeSavedSettingsSync(settingsPath, settings) {
  const normalized = cloneJson(settings || {});
  normalized.secrets = normalizeSecretMap(normalized.secrets);
  normalized.secretsEncrypted = protectSecretMapSync(normalized.secrets, { settingsPath });
  delete normalized.secrets;
  return normalized;
}
