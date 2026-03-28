import { createAbortError } from "./utils/abort.mjs";

const OPERATION_TTL_MS = 5 * 60 * 1000;
const MAX_EVENT_HISTORY = 200;

function now() {
  return Date.now();
}

function createOperationRecord(id, meta = {}) {
  return {
    id,
    meta,
    createdAt: now(),
    updatedAt: now(),
    seq: 0,
    events: [],
    listeners: new Set(),
    finished: false,
    cancellationRequested: false,
    abortController: new AbortController()
  };
}

function writeEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createOperationTracker() {
  const operations = new Map();

  function pruneExpired() {
    const cutoff = now() - OPERATION_TTL_MS;
    for (const [id, operation] of operations.entries()) {
      if (!operation.finished) {
        continue;
      }

      if (operation.updatedAt < cutoff) {
        operations.delete(id);
      }
    }
  }

  function lookupOperation(id) {
    pruneExpired();
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return null;
    }
    return operations.get(normalizedId) || null;
  }

  function ensureOperation(id, meta = {}) {
    pruneExpired();

    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("Operation id is required.");
    }

    let operation = operations.get(normalizedId);
    if (!operation) {
      operation = createOperationRecord(normalizedId, meta);
      operations.set(normalizedId, operation);
    } else if (meta && Object.keys(meta).length) {
      operation.meta = { ...operation.meta, ...meta };
      operation.updatedAt = now();
    }

    return operation;
  }

  function publish(id, payload) {
    const operation = ensureOperation(id);
    const event = {
      seq: ++operation.seq,
      operationId: operation.id,
      timestamp: new Date().toISOString(),
      ...payload
    };

    operation.updatedAt = now();
    operation.events.push(event);
    if (operation.events.length > MAX_EVENT_HISTORY) {
      operation.events.shift();
    }

    if (payload?.type === "complete" || payload?.type === "error") {
      operation.finished = true;
    }

    if (payload?.type === "cancelled") {
      operation.finished = true;
    }

    for (const listener of operation.listeners) {
      writeEvent(listener, event);
    }

    return event;
  }

  function attachStream(id, request, response) {
    const operation = ensureOperation(id);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");

    for (const event of operation.events) {
      writeEvent(response, event);
    }

    operation.listeners.add(response);

    const detach = () => {
      operation.listeners.delete(response);
      if (!response.writableEnded) {
        response.end();
      }
    };

    request.on("close", detach);
    response.on("close", () => {
      operation.listeners.delete(response);
    });
  }

  function getSignal(id) {
    return ensureOperation(id).abortController.signal;
  }

  function getSnapshot(id, options = {}) {
    const operation = lookupOperation(id);
    if (!operation) {
      return null;
    }

    const afterSeq = Math.max(0, Number(options.afterSeq) || 0);
    const events = operation.events.filter((event) => event.seq > afterSeq);
    const lastEvent = operation.events[operation.events.length - 1] || null;

    return {
      id: operation.id,
      meta: { ...operation.meta },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      seq: operation.seq,
      finished: operation.finished,
      cancellationRequested: operation.cancellationRequested,
      lastEvent,
      events
    };
  }

  function cancel(id, options = {}) {
    const operation = lookupOperation(id);
    if (!operation) {
      return {
        ok: false,
        code: "not_found"
      };
    }

    if (operation.finished) {
      return {
        ok: false,
        code: "already_finished"
      };
    }

    if (operation.cancellationRequested) {
      return {
        ok: true,
        alreadyRequested: true
      };
    }

    operation.cancellationRequested = true;
    operation.updatedAt = now();

    publish(operation.id, {
      type: "status",
      stage: "cancel_requested",
      tone: "warning",
      detail: String(options.detail || "Cancellation requested.")
    });

    operation.abortController.abort(
      createAbortError(
        String(options.message || "Operation cancelled by user.")
      )
    );

    return {
      ok: true,
      alreadyRequested: false
    };
  }

  function cancelAll(options = {}) {
    const results = [];

    for (const operation of operations.values()) {
      if (operation.finished) {
        continue;
      }

      results.push(
        cancel(operation.id, {
          detail: options.detail || "Cancellation requested for all active operations.",
          message: options.message || "Operation cancelled because the application is shutting down."
        })
      );
    }

    return {
      ok: true,
      cancelledCount: results.filter((result) => result.ok).length,
      results
    };
  }

  return {
    ensureOperation,
    publish,
    attachStream,
    cancel,
    cancelAll,
    getSignal,
    getSnapshot
  };
}
