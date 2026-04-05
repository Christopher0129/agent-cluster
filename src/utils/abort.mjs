export const DEFAULT_ABORT_MESSAGE = "Operation cancelled by user.";

export function createAbortError(message = DEFAULT_ABORT_MESSAGE, cause = undefined) {
  const error = new Error(String(message || DEFAULT_ABORT_MESSAGE));
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.cancelled = true;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

export function isAbortError(error) {
  return Boolean(
    error?.cancelled ||
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR"
  );
}

export function getAbortMessage(signal, fallback = DEFAULT_ABORT_MESSAGE) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason && typeof reason.message === "string" && reason.message.trim()) {
    return reason.message.trim();
  }
  return fallback;
}

export function throwIfAborted(signal, fallback = DEFAULT_ABORT_MESSAGE) {
  if (signal?.aborted) {
    throw createAbortError(getAbortMessage(signal, fallback), signal.reason);
  }
}

export function abortableSleep(ms, signal, fallback = DEFAULT_ABORT_MESSAGE) {
  throwIfAborted(signal, fallback);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));

    const onAbort = () => {
      cleanup();
      reject(createAbortError(getAbortMessage(signal, fallback), signal.reason));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function combineAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (!activeSignals.length) {
    return null;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  const listeners = [];

  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  const forwardAbort = (sourceSignal) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(
      sourceSignal?.reason || createAbortError(getAbortMessage(sourceSignal))
    );
    cleanup();
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      forwardAbort(signal);
      return controller.signal;
    }

    const listener = () => forwardAbort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }

  return controller.signal;
}
