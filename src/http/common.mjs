const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export function resolveStaticAssetPath(urlPathname) {
  if (!String(urlPathname || "").startsWith("/assets/")) {
    return "";
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(String(urlPathname).slice("/assets/".length))
      .replaceAll("\\", "/")
      .trim();
  } catch {
    return "";
  }
  if (!relativePath || relativePath.startsWith("/")) {
    return "";
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "";
  }

  return relativePath;
}

export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

export function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(body);
}

export async function readRequestBody(request) {
  const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in request body: ${error.message}`);
  }
}

export function resolveOperationId(body, fallbackPrefix, randomUuid) {
  const explicit = String(body?.operationId || "").trim();
  return explicit || `${fallbackPrefix}_${randomUuid()}`;
}

export function resolveServerUrl(request) {
  const port = request?.socket?.localPort || 0;
  return `http://127.0.0.1:${port}`;
}

export async function serveStaticFile(response, assetPath, staticAssetLoader) {
  const body = await staticAssetLoader(assetPath);
  const dotIndex = assetPath.lastIndexOf(".");
  const extension = dotIndex >= 0 ? assetPath.slice(dotIndex) : "";
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  response.end(body);
}
