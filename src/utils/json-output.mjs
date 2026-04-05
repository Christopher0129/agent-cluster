function findBalancedJson(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[") {
      starts.push(index);
    }
  }

  for (const startIndex of starts) {
    const stack = [];
    let inString = false;
    let escaping = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack[stack.length - 1] !== expected) {
          break;
        }

        stack.pop();
        if (!stack.length) {
          return text.slice(startIndex, index + 1);
        }
      }
    }
  }

  return null;
}

function normalizeSmartQuotes(text) {
  return String(text || "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function removeJsonLikeComments(text) {
  let result = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length - 1 && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function normalizeJsonLikeStrings(text) {
  let result = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        result += "\\";
        escaping = true;
        continue;
      }

      if (char === quote) {
        result += '"';
        quote = "";
        continue;
      }

      if (char === "\r") {
        if (text[index + 1] === "\n") {
          index += 1;
        }
        result += "\\n";
        continue;
      }

      if (char === "\n") {
        result += "\\n";
        continue;
      }

      if (quote === "'" && char === '"') {
        result += '\\"';
        continue;
      }

      result += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += '"';
      continue;
    }

    result += char;
  }

  return result;
}

function isBareJsonKeyStart(char) {
  return /[A-Za-z_\u00C0-\uFFFF$]/.test(String(char || ""));
}

function isBareJsonKeyChar(char) {
  return /[A-Za-z0-9_\u00C0-\uFFFF$-]/.test(String(char || ""));
}

function quoteBareJsonKeys(text) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "{" || char === ",") {
      result += char;
      let cursor = index + 1;
      let whitespace = "";
      while (cursor < text.length && /\s/.test(text[cursor])) {
        whitespace += text[cursor];
        cursor += 1;
      }

      if (text[cursor] === '"' || !isBareJsonKeyStart(text[cursor])) {
        result += whitespace;
        index = cursor - 1;
        continue;
      }

      let keyEnd = cursor + 1;
      while (keyEnd < text.length && isBareJsonKeyChar(text[keyEnd])) {
        keyEnd += 1;
      }
      const key = text.slice(cursor, keyEnd);
      let postKeyWhitespace = "";
      let colonIndex = keyEnd;
      while (colonIndex < text.length && /\s/.test(text[colonIndex])) {
        postKeyWhitespace += text[colonIndex];
        colonIndex += 1;
      }

      if (text[colonIndex] === ":") {
        result += `${whitespace}"${key}"${postKeyWhitespace}`;
        index = colonIndex - 1;
        continue;
      }

      result += whitespace;
      index = cursor - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingJsonCommas(text) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor += 1;
      }
      if (text[cursor] === "}" || text[cursor] === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function repairJsonLikeText(text) {
  return stripTrailingJsonCommas(
    quoteBareJsonKeys(
      normalizeJsonLikeStrings(
        removeJsonLikeComments(
          normalizeSmartQuotes(String(text || "").replace(/^\uFEFF/, "").trim())
        )
      )
    )
  );
}

function extractOuterFencedBlock(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("```")) {
    return null;
  }

  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) {
    return null;
  }

  const closingFenceIndex = trimmed.lastIndexOf("```");
  if (closingFenceIndex <= firstLineEnd) {
    return null;
  }

  const trailing = trimmed.slice(closingFenceIndex + 3).trim();
  if (trailing) {
    return null;
  }

  return trimmed.slice(firstLineEnd + 1, closingFenceIndex).trim();
}

export function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Empty text cannot be parsed as JSON.");
  }

  const outerFenced = extractOuterFencedBlock(trimmed);
  if (outerFenced) {
    return outerFenced;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const balanced = findBalancedJson(trimmed);
  if (balanced) {
    return balanced;
  }

  throw new Error("No JSON object or array found in model output.");
}

export function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Empty text cannot be parsed as JSON.");
  }

  const candidates = [trimmed];
  try {
    const extracted = extractJsonCandidate(trimmed);
    if (extracted && extracted !== trimmed) {
      candidates.push(extracted);
    }
  } catch {
    // Ignore and continue with the raw candidate.
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
      const repairedCandidate = repairJsonLikeText(candidate);
      if (!repairedCandidate || repairedCandidate === candidate) {
        continue;
      }
      try {
        return JSON.parse(repairedCandidate);
      } catch (repairError) {
        lastError = repairError;
      }
    }
  }

  throw lastError || new Error("No JSON object or array found in model output.");
}
