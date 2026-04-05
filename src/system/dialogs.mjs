import { spawn } from "node:child_process";

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Sta",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script)
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          ...env
        }
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

export async function pickFolderDialog(initialDir = "") {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select Agent Cluster workspace folder"
$dialog.ShowNewFolderButton = $true
$initialDir = $env:AGENT_CLUSTER_INITIAL_DIR
if (-not [string]::IsNullOrWhiteSpace($initialDir) -and (Test-Path -LiteralPath $initialDir -PathType Container)) {
  $dialog.SelectedPath = (Resolve-Path -LiteralPath $initialDir).Path
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

  return runPowerShell(script, {
    AGENT_CLUSTER_INITIAL_DIR: String(initialDir || "")
  });
}
