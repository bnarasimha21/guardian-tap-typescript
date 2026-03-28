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

/** Set of connected observer WebSocket clients */
const observers = new Set<WebSocket>();

/** Broadcast a JSON string to all connected observers */
function broadcast(text: string): void {
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
function extractSseEvents(chunk: string): string[] {
  const events: string[] = [];
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
          events.push(JSON.stringify({ type: currentEventType, data: parsed }));
        } else {
          events.push(JSON.stringify(parsed));
        }
      } else if (currentEventType && dataStr) {
        events.push(JSON.stringify({ type: currentEventType, data: { raw: dataStr } }));
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
 * Just call attachObserver(app) after creating your Express app.
 * No other changes needed. app.listen() continues to work as before.
 *
 * @param app - Express application instance
 * @param options - Configuration options
 */
export function attachObserver(
  app: Express,
  options: AttachOptions = {}
): void {
  const wsPath = options.path || "/ws-observe";

  // Health check endpoint (HTTP GET)
  app.get(wsPath, (_req, res) => {
    res.json({
      status: "ok",
      guardian_tap: true,
      version: "0.1.0",
      framework: "express",
      observers: observers.size,
      websocket_support: true,
    });
  });

  // Patch app.listen to create an HTTP server with WebSocket support
  const originalListen = app.listen.bind(app);

  (app as any).listen = function (...args: any[]): HttpServer {
    // Create HTTP server from the Express app
    const server = createServer(app);

    // Attach WebSocket server for observers
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

    // Call server.listen with the same arguments
    return (server.listen as any)(...args);
  };

  // Middleware to intercept SSE and JSON responses
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (observers.size === 0) {
      next();
      return;
    }

    // Intercept res.json()
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      if (body && typeof body === "object") {
        broadcast(JSON.stringify(body));
      }
      return originalJson(body);
    };

    // Intercept res.send() for string/JSON payloads
    const originalSend = res.send.bind(res);
    res.send = function (body: any): Response {
      if (body && typeof body === "string" && observers.size > 0) {
        const parsed = tryParseJson(body);
        if (parsed) {
          broadcast(JSON.stringify(parsed));
        }
      }
      return originalSend(body);
    };

    // Intercept res.write() - detect SSE data lines automatically
    const originalWrite = res.write.bind(res);

    res.write = function (chunk: any, ...args: any[]): boolean {
      if (observers.size > 0) {
        const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf-8") || "";
        if (text && text.includes("data:")) {
          const events = extractSseEvents(text);
          for (const event of events) {
            broadcast(event);
          }
        }
      }
      return (originalWrite as any)(chunk, ...args);
    };

    next();
  });

  console.log(`[guardian-tap] Attached at ${wsPath} (express + sse)`);
}

/** Manually broadcast a JSON payload to all observers */
export function broadcastEvent(data: Record<string, unknown>): void {
  broadcast(JSON.stringify(data));
}
