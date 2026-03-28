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

export function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Empty text cannot be parsed as JSON.");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
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

  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(extractJsonCandidate(trimmed));
  }
}
