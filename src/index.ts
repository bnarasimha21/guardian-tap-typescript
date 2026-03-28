/**
 * guardian-tap: One-line integration to make any Express app observable by GuardianAI.
 *
 * Usage:
 *   import { attachObserver } from 'guardian-tap';
 *   attachObserver(app);
 *
 * That's it. No other changes needed. app.listen() works as before.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const VERSION = "0.1.0";

/** Set of connected observer WebSocket clients */
const observers = new Set<WebSocket>();

/** Broadcast a JSON string to all connected observers */
function broadcastRaw(text: string): void {
  if (observers.size === 0) return;
  const dead: WebSocket[] = [];
  for (const obs of observers) {
    try {
      if (obs.readyState === WebSocket.OPEN) {
        obs.send(text);
      } else {
        dead.push(obs);
      }
    } catch {
      dead.push(obs);
    }
  }
  for (const d of dead) observers.delete(d);
}

/** Broadcast a dict wrapped in a tap envelope with request context */
function broadcastWithContext(
  data: Record<string, unknown>,
  path: string = "",
  method: string = ""
): void {
  const envelope = {
    _tap: { path, method, timestamp: Date.now() / 1000 },
    ...data,
  };
  broadcastRaw(JSON.stringify(envelope));
}

/** Try to parse a string as a JSON object */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Extract JSON events from an SSE chunk */
function extractSseEvents(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let currentEventType: string | null = null;

  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      currentEventType = trimmed.slice(6).trim();
    } else if (trimmed.startsWith("data:")) {
      const dataStr = trimmed.slice(5).trim();
      const parsed = tryParseJson(dataStr);
      if (parsed) {
        if (!("type" in parsed) && currentEventType) {
          events.push({ type: currentEventType, data: parsed });
        } else {
          events.push(parsed);
        }
      } else if (currentEventType && dataStr) {
        events.push({ type: currentEventType, data: { raw: dataStr } });
      }
      currentEventType = null;
    }
  }
  return events;
}

export interface AttachOptions {
  /** WebSocket path for observers. Defaults to "/ws-observe" */
  path?: string;
}

/**
 * Attach a GuardianAI observer to an Express app.
 *
 * Intercepts res.json(), res.send(), and res.write() (SSE).
 * All outgoing messages are broadcast to connected observers
 * with request context (path, method, timestamp).
 *
 * @param app - Express application instance
 * @param options - Configuration options
 */
export function attachObserver(
  app: Express,
  options: AttachOptions = {}
): void {
  const wsPath = options.path || "/ws-observe";
  let listenCalled = false;

  // Health check endpoint (HTTP GET)
  app.get(wsPath, (_req, res) => {
    res.json({
      status: "ok",
      guardian_tap: true,
      version: VERSION,
      framework: "express",
      observers: observers.size,
      websocket_support: true,
    });
  });

  // Patch app.listen to create an HTTP server with WebSocket support
  const originalListen = app.listen.bind(app);

  (app as any).listen = function (...args: any[]): HttpServer {
    // Guard against multiple listen calls
    if (listenCalled) {
      return (originalListen as any)(...args);
    }
    listenCalled = true;

    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: wsPath });

    wss.on("connection", (ws: WebSocket) => {
      observers.add(ws);
      console.log(`[guardian-tap] Observer connected (${observers.size} total)`);

      ws.on("close", () => {
        observers.delete(ws);
        console.log(`[guardian-tap] Observer disconnected (${observers.size} remaining)`);
      });

      ws.on("error", () => {
        observers.delete(ws);
      });
    });

    return (server.listen as any)(...args);
  };

  // Middleware to intercept responses
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (observers.size === 0) {
      next();
      return;
    }

    const reqPath = req.path;
    const reqMethod = req.method;

    // Dedup guard: prevent double-broadcast from res.json -> res.send chain
    let alreadyBroadcast = false;

    // Intercept res.json()
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      if (body && typeof body === "object" && !alreadyBroadcast) {
        alreadyBroadcast = true;
        broadcastWithContext(body as Record<string, unknown>, reqPath, reqMethod);
      }
      return originalJson(body);
    };

    // Intercept res.send() for string/JSON payloads
    const originalSend = res.send.bind(res);
    res.send = function (body: any): Response {
      if (!alreadyBroadcast && body && typeof body === "string" && observers.size > 0) {
        const parsed = tryParseJson(body);
        if (parsed) {
          alreadyBroadcast = true;
          broadcastWithContext(parsed, reqPath, reqMethod);
        }
      }
      return originalSend(body);
    };

    // Intercept res.write() - detect SSE data lines and Buffer chunks
    const originalWrite = res.write.bind(res);

    res.write = function (chunk: any, ...args: any[]): boolean {
      if (observers.size > 0) {
        let text: string | null = null;

        if (typeof chunk === "string") {
          text = chunk;
        } else if (Buffer.isBuffer(chunk)) {
          try {
            text = chunk.toString("utf-8");
          } catch {
            // Not valid UTF-8, skip
          }
        }

        if (text && text.includes("data:")) {
          const events = extractSseEvents(text);
          for (const event of events) {
            broadcastWithContext(event, reqPath, reqMethod);
          }
        }
      }
      return (originalWrite as any)(chunk, ...args);
    };

    next();
  });

  console.log(`[guardian-tap] Attached at ${wsPath} (express + sse + json)`);
}

/** Manually broadcast a JSON payload to all observers */
export function broadcastEvent(data: Record<string, unknown>): void {
  broadcastRaw(JSON.stringify(data));
}
