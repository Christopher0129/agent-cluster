import { spawn } from "node:child_process";
import { extname } from "node:path";
import { ensureWorkspaceDirectory, resolveWorkspacePath } from "./fs.mjs";
import { createAbortError, getAbortMessage, throwIfAborted } from "../utils/abort.mjs";

const MAX_OUTPUT_BYTES = 200000;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 180000;
const ALLOWED_EXECUTABLES = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "rg",
  "rg.exe",
  "python",
  "py",
  "pytest",
  "dotnet",
  "cargo",
  "go",
  "java",
  "javac",
  "mvn",
  "gradle",
  "gradlew",
  "git",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe"
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "diff", "show", "log", "rev-parse", "ls-files"]);
const SAFE_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".py", ".ps1", ".cmd", ".bat", ".sh"]);
const BLOCKED_ARGUMENT_SNIPPETS = [
  "rm -rf",
  "remove-item",
  "del /f",
  "format",
  "mkfs",
  "shutdown",
  "reboot",
  "git reset --hard",
  "git clean -fd",
  "git clean -xdf",
  "powershell -command",
  "powershell -encodedcommand",
  "pwsh -command",
  "pwsh -encodedcommand",
  "cmd /c del",
  "cmd /c rd"
];

function normalizeExecutable(command) {
  return String(command || "").trim().toLowerCase();
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item ?? "")) : [];
}

function truncateOutput(value) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: text.slice(0, MAX_OUTPUT_BYTES),
    truncated: true
  };
}

function validateCommandPolicy(workspaceDir, command, args) {
  const executable = normalizeExecutable(command);
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`Command "${command}" is not allowed inside the workspace command tool.`);
  }

  const combined = [executable, ...args].join(" ").toLowerCase();
  if (BLOCKED_ARGUMENT_SNIPPETS.some((snippet) => combined.includes(snippet))) {
    throw new Error(`Command "${command}" contains blocked arguments for safety reasons.`);
  }

  if (executable === "git" && !ALLOWED_GIT_SUBCOMMANDS.has(String(args[0] || "").trim())) {
    throw new Error("Only read-only git commands are allowed inside the workspace command tool.");
  }

  if (executable === "node" && ["-e", "--eval"].includes(String(args[0] || "").trim())) {
    throw new Error("node eval arguments are blocked. Run a script file from the workspace instead.");
  }

  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
    const mode = String(args[0] || "").trim().toLowerCase();
    if (!["-file", "-f"].includes(mode)) {
      throw new Error("PowerShell commands must use -File with a script inside the workspace.");
    }

    const scriptPath = String(args[1] || "").trim();
    const resolved = resolveWorkspacePath(workspaceDir, scriptPath);
    if (!SAFE_SCRIPT_EXTENSIONS.has(extname(resolved.relativePath).toLowerCase())) {
      throw new Error("Only workspace script files can be executed with PowerShell.");
    }
  }

  if (["cmd", "cmd.exe"].includes(executable)) {
    const mode = String(args[0] || "").trim().toLowerCase();
    if (mode !== "/c") {
      throw new Error("cmd commands must use /c with a batch script inside the workspace.");
    }

    const scriptPath = String(args[1] || "").trim();
    const resolved = resolveWorkspacePath(workspaceDir, scriptPath);
    if (![".cmd", ".bat"].includes(extname(resolved.relativePath).toLowerCase())) {
      throw new Error("Only .cmd or .bat workspace scripts can be executed with cmd.");
    }
  }
}

export async function runWorkspaceCommand(workspaceDir, command, args = [], options = {}) {
  await ensureWorkspaceDirectory(workspaceDir);
  throwIfAborted(options.signal);
  const normalizedCommand = String(command || "").trim();
  const normalizedArgs = normalizeArgs(args);
  validateCommandPolicy(workspaceDir, normalizedCommand, normalizedArgs);

  const cwd = String(options.cwd || ".").trim() || ".";
  const cwdPath = resolveWorkspacePath(workspaceDir, cwd);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
  );

  return new Promise((resolve, reject) => {
    const child = spawn(normalizedCommand, normalizedArgs, {
      cwd: cwdPath.absolutePath,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill();
    };

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      cleanup();
      if (aborted || options.signal?.aborted) {
        reject(createAbortError(getAbortMessage(options.signal), error));
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      if (aborted || options.signal?.aborted) {
        reject(createAbortError(getAbortMessage(options.signal)));
        return;
      }
      const normalizedStdout = truncateOutput(stdout);
      const normalizedStderr = truncateOutput(stderr);
      resolve({
        command: normalizedCommand,
        args: normalizedArgs,
        cwd: cwdPath.relativePath,
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        signal: signal || "",
        timedOut,
        success: !timedOut && Number(exitCode) === 0,
        stdout: normalizedStdout.text,
        stderr: normalizedStderr.text,
        stdoutTruncated: normalizedStdout.truncated,
        stderrTruncated: normalizedStderr.truncated
      });
    });
  });
}
