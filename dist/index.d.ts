/**
 * guardian-tap: One-line integration to make any Express app observable by GuardianAI.
 *
 * Usage:
 *   import { attachObserver } from 'guardian-tap';
 *   attachObserver(app);
 *
 * That's it. No other changes needed. app.listen() works as before.
 */
import type { Express } from "express";
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
export declare function attachObserver(app: Express, options?: AttachOptions): void;
/** Manually broadcast a JSON payload to all observers */
export declare function broadcastEvent(data: Record<string, unknown>): void;
//# sourceMappingURL=index.d.ts.map