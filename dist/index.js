"use strict";
/**
 * guardian-tap: One-line integration to make any Express app observable by GuardianAI.
 *
 * Usage:
 *   import { attachObserver } from 'guardian-tap';
 *   attachObserver(app);
 *
 * That's it. No other changes needed. app.listen() works as before.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachObserver = attachObserver;
exports.broadcastEvent = broadcastEvent;
const http_1 = require("http");
const ws_1 = require("ws");
const VERSION = "0.1.0";
/** Set of connected observer WebSocket clients */
const observers = new Set();
/** Broadcast a JSON string to all connected observers */
function broadcastRaw(text) {
    if (observers.size === 0)
        return;
    const dead = [];
    for (const obs of observers) {
        try {
            if (obs.readyState === ws_1.WebSocket.OPEN) {
                obs.send(text);
            }
            else {
                dead.push(obs);
            }
        }
        catch {
            dead.push(obs);
        }
    }
    for (const d of dead)
        observers.delete(d);
}
/** Broadcast a dict wrapped in a tap envelope with request context */
function broadcastWithContext(data, path = "", method = "") {
    const envelope = {
        _tap: { path, method, timestamp: Date.now() / 1000 },
        ...data,
    };
    broadcastRaw(JSON.stringify(envelope));
}
/** Try to parse a string as a JSON object */
function tryParseJson(text) {
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : null;
    }
    catch {
        return null;
    }
}
/** Extract JSON events from an SSE chunk */
function extractSseEvents(chunk) {
    const events = [];
    let currentEventType = null;
    for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
            currentEventType = trimmed.slice(6).trim();
        }
        else if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            const parsed = tryParseJson(dataStr);
            if (parsed) {
                if (!("type" in parsed) && currentEventType) {
                    events.push({ type: currentEventType, data: parsed });
                }
                else {
                    events.push(parsed);
                }
            }
            else if (currentEventType && dataStr) {
                events.push({ type: currentEventType, data: { raw: dataStr } });
            }
            currentEventType = null;
        }
    }
    return events;
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
function attachObserver(app, options = {}) {
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
    app.listen = function (...args) {
        // Guard against multiple listen calls
        if (listenCalled) {
            return originalListen(...args);
        }
        listenCalled = true;
        const server = (0, http_1.createServer)(app);
        const wss = new ws_1.WebSocketServer({ server, path: wsPath });
        wss.on("connection", (ws) => {
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
        return server.listen(...args);
    };
    // Middleware to intercept responses
    app.use((req, res, next) => {
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
        res.json = function (body) {
            if (body && typeof body === "object" && !alreadyBroadcast) {
                alreadyBroadcast = true;
                broadcastWithContext(body, reqPath, reqMethod);
            }
            return originalJson(body);
        };
        // Intercept res.send() for string/JSON payloads
        const originalSend = res.send.bind(res);
        res.send = function (body) {
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
        res.write = function (chunk, ...args) {
            if (observers.size > 0) {
                let text = null;
                if (typeof chunk === "string") {
                    text = chunk;
                }
                else if (Buffer.isBuffer(chunk)) {
                    try {
                        text = chunk.toString("utf-8");
                    }
                    catch {
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
            return originalWrite(chunk, ...args);
        };
        next();
    });
    console.log(`[guardian-tap] Attached at ${wsPath} (express + sse + json)`);
}
/** Manually broadcast a JSON payload to all observers */
function broadcastEvent(data) {
    broadcastRaw(JSON.stringify(data));
}
//# sourceMappingURL=index.js.map