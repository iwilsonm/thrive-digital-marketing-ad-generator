/**
 * Shared SSE (Server-Sent Events) streaming utilities.
 *
 * Replaces the identical SSE setup block copy-pasted across route files.
 */

/**
 * Initialize an SSE stream on the response.
 * Disables timeouts, sets headers, starts keepalive, tracks client disconnect.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {{ sendEvent: (obj: object) => void, end: () => void, isClosed: () => boolean }}
 */
export function createSSEStream(req, res) {
  req.setTimeout(0);
  res.setTimeout(0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',  // Prevent gzip from buffering SSE
  });
  // Force flush headers immediately so the client knows the stream is open
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    closed = true;
    clearInterval(keepalive);
  });

  return {
    sendEvent(obj) {
      if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    end() {
      clearInterval(keepalive);
      if (!closed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
    isClosed() {
      return closed;
    },
  };
}

/**
 * Run an async service function with SSE streaming.
 *
 * Sets up the SSE stream, calls `serviceFn(sendEvent)`, and handles
 * completion/error automatically. Eliminates the repeated
 * try/catch/clearInterval/closed-check dance in every SSE route.
 *
 * @param {Request} req
 * @param {Response} res
 * @param {(sendEvent: (obj) => void) => Promise<void>} serviceFn
 */
export function streamService(req, res, serviceFn) {
  const sse = createSSEStream(req, res);

  serviceFn(sse.sendEvent)
    .then(() => {
      sse.end();
    })
    .catch((err) => {
      console.error('[SSE] Stream error:', err.message);
      sse.sendEvent({
        type: 'error',
        message: err.message,
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.userActionable !== undefined ? { userActionable: err.userActionable } : {}),
        ...(err.actionUrl ? { actionUrl: err.actionUrl } : {}),
        ...(err.actionLabel ? { actionLabel: err.actionLabel } : {}),
      });
      sse.end();
    });
}
