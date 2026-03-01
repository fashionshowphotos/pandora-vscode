import * as http from 'http';
import * as fs from 'fs';
import * as crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { handleAction, VALID_ACTIONS, READ_ACTIONS } from './handlers';

// ============================================================================
// TYPES
// ============================================================================

interface RpcRequest {
    id: string;
    type: string;
    payload?: Record<string, unknown>;
}

interface RpcResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

interface ServerOptions {
    port: number;
    token: string;
    readOnly: boolean;
    auditPath: string | null;
    log: (msg: string) => void;
}

// ============================================================================
// RATE LIMITER (token bucket)
// ============================================================================

class RateLimiter {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number; // tokens per second

    constructor(maxTokens = 60, refillRate = 10) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRate;
        this.lastRefill = Date.now();
    }

    tryConsume(): boolean {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;

        if (this.tokens >= 1) {
            this.tokens--;
            return true;
        }
        return false;
    }
}

// ============================================================================
// RPC SERVER
// ============================================================================

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1MB
const MAX_REQUEST_ID_LENGTH = 128;
const AUTH_TIMEOUT_MS = 5000;

function constantTimeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export class RpcServer {
    private options: ServerOptions;
    private httpServer: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private activeClient: WebSocket | null = null;
    private authenticated = false;
    private rateLimiter = new RateLimiter();
    private auditFd: fs.promises.FileHandle | null = null;

    readOnly: boolean;
    onConnectionChange: ((connected: boolean) => void) | null = null;

    constructor(options: ServerOptions) {
        this.options = options;
        this.readOnly = options.readOnly;
    }

    // ================================================================
    // LIFECYCLE
    // ================================================================

    async start(): Promise<void> {
        if (this.wss) return; // idempotent

        // Open audit log
        if (this.options.auditPath) {
            await fs.promises.mkdir(
                require('path').dirname(this.options.auditPath),
                { recursive: true }
            );
            this.auditFd = await fs.promises.open(this.options.auditPath, 'a');
        }

        this.httpServer = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Pandora Hands RPC');
        });

        this.wss = new WebSocketServer({
            server: this.httpServer,
            verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
                // Block cross-origin WebSocket from malicious websites
                const origin = info.origin || info.req.headers.origin;
                if (!origin) return true; // No origin = non-browser client (e.g. Pandora)
                return origin === 'http://127.0.0.1' || origin === 'http://localhost';
            },
        });

        this.wss.on('connection', (ws) => this.handleConnection(ws));

        return new Promise((resolve, reject) => {
            this.httpServer!.on('error', reject);
            this.httpServer!.listen(this.options.port, '127.0.0.1', () => {
                this.options.log(`RPC server listening on ws://127.0.0.1:${this.options.port}`);
                resolve();
            });
        });
    }

    stop(): void {
        if (this.activeClient) {
            try { this.activeClient.close(1000, 'Server stopping'); } catch { /* */ }
            this.activeClient = null;
        }
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
        if (this.auditFd) {
            this.auditFd.close().catch(() => {});
            this.auditFd = null;
        }
        this.authenticated = false;
        this.onConnectionChange?.(false);
    }

    // ================================================================
    // CONNECTION HANDLING (one-client policy)
    // ================================================================

    private handleConnection(ws: WebSocket): void {
        // One-client policy: kick existing client
        if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
            this.options.log('New connection — kicking existing client');
            try { this.activeClient.close(1000, 'Replaced by new connection'); } catch { /* */ }
        }

        this.activeClient = ws;
        this.authenticated = false;

        this.options.log('Client connected — awaiting hello');
        this.onConnectionChange?.(false); // not authenticated yet

        // Auth timeout — must send hello within 5s
        const authTimer = setTimeout(() => {
            if (!this.authenticated) {
                this.options.log('Auth timeout — disconnecting');
                ws.close(4001, 'Auth timeout');
            }
        }, AUTH_TIMEOUT_MS);

        ws.on('message', async (data) => {
            // Max message size
            const raw = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
            if (raw.length > MAX_MESSAGE_BYTES) {
                ws.close(4002, 'Message too large');
                return;
            }

            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                this.send(ws, { id: '', ok: false, error: 'Invalid JSON' });
                return;
            }

            // Handle auth handshake
            if (!this.authenticated) {
                if (msg.type === 'hello' && typeof msg.token === 'string' && constantTimeEqual(msg.token as string, this.options.token)) {
                    this.authenticated = true;
                    clearTimeout(authTimer);
                    this.send(ws, { id: msg.id as string || 'auth', ok: true, result: { authenticated: true } });
                    this.options.log('Client authenticated');
                    this.onConnectionChange?.(true);
                } else {
                    this.options.log('Auth failed — bad token or missing hello');
                    ws.close(4003, 'Authentication failed');
                }
                return;
            }

            // Rate limit
            if (!this.rateLimiter.tryConsume()) {
                this.send(ws, { id: msg.id as string || '', ok: false, error: 'Rate limited' });
                return;
            }

            // Route RPC
            await this.handleRpc(ws, msg as unknown as RpcRequest);
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            if (ws === this.activeClient) {
                this.activeClient = null;
                this.authenticated = false;
                this.options.log('Client disconnected');
                this.onConnectionChange?.(false);
            }
        });

        ws.on('error', (err) => {
            this.options.log(`WS error: ${err.message}`);
        });
    }

    // ================================================================
    // RPC DISPATCH
    // ================================================================

    private async handleRpc(ws: WebSocket, req: RpcRequest): Promise<void> {
        const start = Date.now();

        if (!req.id || typeof req.id !== 'string') {
            this.send(ws, { id: '', ok: false, error: 'Missing request id' });
            return;
        }

        // Cap request ID length to prevent audit log bloat
        if (req.id.length > MAX_REQUEST_ID_LENGTH) {
            this.send(ws, { id: '', ok: false, error: `Request id too long (max ${MAX_REQUEST_ID_LENGTH} chars)` });
            return;
        }

        if (!req.type || typeof req.type !== 'string') {
            this.send(ws, { id: req.id, ok: false, error: 'Missing action type' });
            return;
        }

        // Sanitize — reject control characters to prevent audit log injection
        if (/[\n\r\0]/.test(req.id) || /[\n\r\0]/.test(req.type)) {
            this.send(ws, { id: '', ok: false, error: 'Invalid characters in id or type' });
            return;
        }

        // Strict action allowlist
        if (!VALID_ACTIONS.has(req.type)) {
            this.send(ws, { id: req.id, ok: false, error: `Unknown action: ${req.type}` });
            return;
        }

        // Read-only enforcement
        if (this.readOnly && !READ_ACTIONS.has(req.type)) {
            this.send(ws, { id: req.id, ok: false, error: 'Read-only mode — write/execute actions blocked' });
            await this.audit(req, false, 'read_only_blocked', Date.now() - start);
            return;
        }

        try {
            const result = await handleAction(req.type, req.payload || {});
            this.send(ws, { id: req.id, ok: true, result });
            await this.audit(req, true, null, Date.now() - start);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.send(ws, { id: req.id, ok: false, error: errMsg });
            // Sanitize error message for audit log — strip control chars that break JSONL
            const safeErr = errMsg.replace(/[\n\r\0]/g, ' ').slice(0, 1024);
            await this.audit(req, false, safeErr, Date.now() - start);
        }
    }

    // ================================================================
    // TRANSPORT
    // ================================================================

    private send(ws: WebSocket, msg: RpcResponse): void {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(msg));
            } catch { /* swallow send errors */ }
        }
    }

    // ================================================================
    // AUDIT LOG
    // ================================================================

    private async audit(
        req: RpcRequest,
        ok: boolean,
        error: string | null,
        durationMs: number
    ): Promise<void> {
        if (!this.auditFd) return;
        const entry = {
            ts: new Date().toISOString(),
            id: req.id,
            type: req.type,
            ok,
            error: error || undefined,
            durationMs,
        };
        try {
            await this.auditFd.write(JSON.stringify(entry) + '\n', undefined, 'utf-8');
        } catch { /* best effort */ }
    }
}
