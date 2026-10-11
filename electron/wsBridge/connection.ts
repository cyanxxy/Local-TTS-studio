const WEBSOCKET_TARGET_LABEL = "Rust local bridge WebSocket";
// Pause between attempts after a connection is refused outright.
const RETRY_DELAY_MS = 50;

export function isOpen(socket: WebSocket | null): socket is WebSocket {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

/** Closes a socket that may already be closing or closed. */
export function closeQuietly(socket: WebSocket | null): void {
  try {
    socket?.close();
  } catch {
    // Already closed.
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function openWebSocketOnce(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out connecting to ${WEBSOCKET_TARGET_LABEL}.`));
    }, timeoutMs);
    timeout.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      if (error) {
        closeQuietly(socket);
        reject(error);
      } else {
        resolve(socket);
      }
    };

    const handleOpen = () => finish();
    const handleError = () => finish(new Error(`Failed connecting to ${WEBSOCKET_TARGET_LABEL}.`));
    const handleClose = () => finish(new Error(`${WEBSOCKET_TARGET_LABEL} closed before connecting.`));

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

/**
 * Connects to a freshly announced bridge port, retrying a refused connection
 * until `timeoutMs` elapses or the process dies.
 */
export async function openWebSocketWithRetry(
  url: string,
  timeoutMs: number,
  isWorkerAlive: () => boolean,
): Promise<WebSocket> {
  const started = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - started < timeoutMs && isWorkerAlive()) {
    try {
      // Each attempt gets the whole remaining budget rather than a short slice.
      // A slice that expires mid-handshake closes a socket the bridge may have
      // already accepted, and the bridge exits after its one owning connection
      // — so every later retry would hit a dead port. Retrying is only here to
      // cover a connection refused outright, which fails fast on its own.
      return await openWebSocketOnce(url, timeoutMs - (Date.now() - started));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(RETRY_DELAY_MS);
    }
  }

  if (lastError) throw lastError;
  throw new Error(
    isWorkerAlive()
      ? `Timed out connecting to ${WEBSOCKET_TARGET_LABEL}.`
      : "Rust local bridge process exited during startup.",
  );
}
