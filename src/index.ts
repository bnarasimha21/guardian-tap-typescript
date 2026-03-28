/**
 * guardian-tap: One-line integration to make any Express app observable by GuardianAI.
 *
 * Usage:
 *   const { attachObserver } = require('guardian-tap');
 *   attachObserver(app);
 *
 * Or with ES modules:
 *   import { attachObserver } from 'guardian-tap';
 *   attachObserver(app);
 */

import type { Express, Request, Response, NextFunction } from "express";
import { createServer, Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const SSE_DATA_RE = /^data:\s*(.+)$/gm;

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
  for (const d of dead) {
    observers.delete(d);
  }
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
 * This does three things:
 * 1. Creates a WebSocket server at /ws-observe for observers to connect to
 * 2. Intercepts SSE responses (text/event-stream) and broadcasts events to observers
 * 3. Intercepts res.json() calls and broadcasts them to observers
 *
 * @param app - Express application instance
 * @param options - Configuration options
 * @returns The HTTP server (use this instead of app.listen())
 */
export function attachObserver(
  app: Express,
  options: AttachOptions = {}
): HttpServer {
  const wsPath = options.path || "/ws-observe";

  // Create HTTP server from Express app
  const server = createServer(app);

  // Create WebSocket server on the same HTTP server
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

    // Intercept res.write() for SSE streams
    const originalWrite = res.write.bind(res);
    let isSse = false;

    // Intercept writeHead/setHeader to detect SSE
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: string | number | readonly string[]): Response {
      if (name.toLowerCase() === "content-type" && String(value).includes("text/event-stream")) {
        isSse = true;
      }
      return originalSetHeader(name, value);
    };

    res.write = function (chunk: any, ...args: any[]): boolean {
      if (isSse && observers.size > 0) {
        const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf-8") || "";
        if (text) {
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

  return server;
}

/** Manually broadcast a JSON payload to all observers */
export function broadcastEvent(data: Record<string, unknown>): void {
  broadcast(JSON.stringify(data));
}
