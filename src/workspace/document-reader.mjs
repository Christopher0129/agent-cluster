import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { spawn } from "node:child_process";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".tsv",
  ".log",
  ".ini",
  ".toml",
  ".conf",
  ".config",
  ".env",
  ".properties",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".kts",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".dockerfile",
  ".gradle",
  ".makefile"
]);

const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
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

      resolve(stdout);
    });
  });
}

function buildOfficeExtractionScript() {
  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$path = $env:AGENT_CLUSTER_DOC_PATH
$ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()

function Decode-XmlText([string]$value) {
  return [System.Net.WebUtility]::HtmlDecode(($value -replace '<[^>]+>', ' ' -replace '\\s+', ' ').Trim())
}

function Get-ZipEntryText([string]$archivePath, [string]$entryName) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entry = $archive.Entries | Where-Object { $_.FullName -eq $entryName } | Select-Object -First 1
    if (-not $entry) { return "" }
    $stream = $entry.Open()
    try {
      $reader = New-Object System.IO.StreamReader($stream)
      return $reader.ReadToEnd()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-ZipEntries([string]$archivePath, [string]$prefix) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    return $archive.Entries |
      Where-Object { $_.FullName.StartsWith($prefix) -and -not $_.FullName.EndsWith('/') } |
      Sort-Object FullName |
      ForEach-Object {
        $stream = $_.Open()
        try {
          $reader = New-Object System.IO.StreamReader($stream)
          [PSCustomObject]@{
            Name = $_.FullName
            Content = $reader.ReadToEnd()
          }
        } finally {
          $stream.Dispose()
        }
      }
  } finally {
    $archive.Dispose()
  }
}

function Extract-Docx([string]$filePath) {
  $parts = @()
  foreach ($entry in Get-ZipEntries $filePath 'word/') {
    if ($entry.Name -like '*.xml') {
      $parts += [regex]::Matches($entry.Content, '<w:t[^>]*>(.*?)</w:t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
    }
  }
  return ($parts | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-Pptx([string]$filePath) {
  $slides = @()
  foreach ($entry in Get-ZipEntries $filePath 'ppt/slides/') {
    if ($entry.Name -like '*.xml') {
      $texts = [regex]::Matches($entry.Content, '<a:t[^>]*>(.*?)</a:t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
      if ($texts.Count -gt 0) {
        $slides += ('[' + $entry.Name + ']')
        $slides += $texts
      }
    }
  }
  return ($slides | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-Xlsx([string]$filePath) {
  $sharedStrings = @()
  $sharedXml = Get-ZipEntryText $filePath 'xl/sharedStrings.xml'
  if ($sharedXml) {
    $sharedStrings = [regex]::Matches($sharedXml, '<t[^>]*>(.*?)</t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
  }

  $lines = @()
  foreach ($entry in Get-ZipEntries $filePath 'xl/worksheets/') {
    if ($entry.Name -like '*.xml') {
      $sheetValues = @()
      foreach ($cell in [regex]::Matches($entry.Content, '<c[^>]*?(?: t="(?<type>[^"]+)")?[^>]*>(?<inner>.*?)</c>')) {
        $type = $cell.Groups['type'].Value
        $inner = $cell.Groups['inner'].Value
        $valueMatch = [regex]::Match($inner, '<v>(.*?)</v>')
        $inlineMatch = [regex]::Match($inner, '<t[^>]*>(.*?)</t>')
        if ($inlineMatch.Success) {
          $sheetValues += Decode-XmlText($inlineMatch.Groups[1].Value)
          continue
        }
        if ($valueMatch.Success) {
          if ($type -eq 's') {
            $index = 0
            if ([int]::TryParse($valueMatch.Groups[1].Value, [ref]$index) -and $index -lt $sharedStrings.Count) {
              $sheetValues += $sharedStrings[$index]
            }
          } else {
            $sheetValues += Decode-XmlText($valueMatch.Groups[1].Value)
          }
        }
      }
      if ($sheetValues.Count -gt 0) {
        $lines += ('[' + $entry.Name + ']')
        $lines += $sheetValues
      }
    }
  }
  return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-WordLegacy([string]$filePath) {
  $word = $null
  $doc = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Open($filePath, $false, $true)
    return $doc.Content.Text
  } finally {
    if ($doc) { $doc.Close() | Out-Null }
    if ($word) { $word.Quit() | Out-Null }
  }
}

function Extract-ExcelLegacy([string]$filePath) {
  $excel = $null
  $workbook = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $workbook = $excel.Workbooks.Open($filePath, 0, $true)
    $lines = @()
    foreach ($sheet in $workbook.Worksheets) {
      $lines += ('[' + $sheet.Name + ']')
      $range = $sheet.UsedRange
      $values = $range.Value2
      if ($values -is [System.Array]) {
        foreach ($row in $values) {
          $lines += (($row | ForEach-Object { if ($_ -ne $null) { $_.ToString() } else { "" } }) -join "\`t")
        }
      } elseif ($values -ne $null) {
        $lines += $values.ToString()
      }
    }
    return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
  } finally {
    if ($workbook) { $workbook.Close($false) | Out-Null }
    if ($excel) { $excel.Quit() | Out-Null }
  }
}

function Extract-PowerPointLegacy([string]$filePath) {
  $powerPoint = $null
  $presentation = $null
  try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Open($filePath, $true, $false, $false)
    $lines = @()
    foreach ($slide in $presentation.Slides) {
      $lines += ('[Slide ' + $slide.SlideIndex + ']')
      foreach ($shape in $slide.Shapes) {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $lines += $shape.TextFrame.TextRange.Text
        }
      }
    }
    return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
  } finally {
    if ($presentation) { $presentation.Close() }
    if ($powerPoint) { $powerPoint.Quit() }
  }
}

switch ($ext) {
  '.docx' { Write-Output (Extract-Docx $path); break }
  '.pptx' { Write-Output (Extract-Pptx $path); break }
  '.xlsx' { Write-Output (Extract-Xlsx $path); break }
  '.doc' { Write-Output (Extract-WordLegacy $path); break }
  '.xls' { Write-Output (Extract-ExcelLegacy $path); break }
  '.ppt' { Write-Output (Extract-PowerPointLegacy $path); break }
  default { throw "Unsupported office extension: $ext" }
}
`;
}

async function extractOfficeDocumentText(filePath) {
  const output = await runPowerShell(buildOfficeExtractionScript(), {
    AGENT_CLUSTER_DOC_PATH: filePath
  });
  return output.trim();
}

export async function readDocumentText(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) || extension === "") {
    return readFile(filePath, "utf8");
  }

  if (OFFICE_EXTENSIONS.has(extension)) {
    return extractOfficeDocumentText(filePath);
  }

  const binary = await readFile(filePath);
  return binary.toString("utf8");
}

export function isSupportedReadableDocument(filePath) {
  const extension = extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension) || extension === "";
}
