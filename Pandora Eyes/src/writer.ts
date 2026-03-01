import * as fs from 'fs';
import * as path from 'path';
import type { FrictionWindow } from './friction';

interface HeartbeatEntry {
    type: 'heartbeat';
    ts: string;
    session_id: string;
    uptime_sec: number;
}

export class FrictionWriter {
    private outputPath: string;
    private sessionId: string;
    private startTime: number;

    // Write queue
    private queue: string[] = [];
    private processing = false;
    private closed = false;
    private fd: fs.promises.FileHandle | null = null;

    // Promise-based drain
    private drainResolvers: Array<() => void> = [];

    // Stats
    private bytesWritten = 0;
    private entriesWritten = 0;
    private errorCount = 0;
    private droppedCount = 0;

    // Periodic fsync
    private writesSinceSync = 0;
    private readonly SYNC_INTERVAL = 10;
    private readonly MAX_QUEUE_SIZE = 100;
    private readonly DRAIN_TIMEOUT_MS = 3000;

    constructor(outputPath: string, sessionId: string) {
        this.outputPath = outputPath;
        this.sessionId = sessionId;
        this.startTime = Date.now();
    }

    // ================================================================
    // PUBLIC API
    // ================================================================

    append(window: FrictionWindow): void {
        if (this.closed) return;
        this.enqueue(JSON.stringify(window) + '\n');
    }

    heartbeat(): void {
        if (this.closed) return;
        const entry: HeartbeatEntry = {
            type: 'heartbeat',
            ts: new Date().toISOString(),
            session_id: this.sessionId,
            uptime_sec: Math.round((Date.now() - this.startTime) / 1000),
        };
        this.enqueue(JSON.stringify(entry) + '\n');
    }

    async close(): Promise<void> {
        this.closed = true;

        // Drain with timeout + cleanup (Claude Web fix: cancel dangling timer)
        let timer: ReturnType<typeof setTimeout>;
        const drainPromise = this.drain();
        const timeoutPromise = new Promise<void>(resolve => {
            timer = setTimeout(resolve, this.DRAIN_TIMEOUT_MS);
        });
        await Promise.race([drainPromise, timeoutPromise]);
        clearTimeout(timer!);

        await this.closeFd();
    }

    getStats() {
        return {
            bytesWritten: this.bytesWritten,
            entriesWritten: this.entriesWritten,
            errorCount: this.errorCount,
            droppedCount: this.droppedCount,
            queueLength: this.queue.length,
        };
    }

    // ================================================================
    // WRITE QUEUE
    // ================================================================

    private enqueue(line: string): void {
        if (this.closed) return;

        if (this.queue.length >= this.MAX_QUEUE_SIZE) {
            this.queue.shift();
            this.droppedCount++;
        }

        this.queue.push(line);

        if (!this.processing) {
            this.processQueue();
        }
    }

    private async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const line = this.queue.shift()!;
            try {
                await this.writeLine(line);
                this.bytesWritten += Buffer.byteLength(line, 'utf8');
                this.entriesWritten++;

                this.writesSinceSync++;
                if (this.writesSinceSync >= this.SYNC_INTERVAL && this.fd) {
                    await this.fd.sync();
                    this.writesSinceSync = 0;
                }
            } catch (err) {
                await this.handleWriteError(err as NodeJS.ErrnoException, line);
            }
        }

        this.processing = false;

        for (const resolve of this.drainResolvers) {
            resolve();
        }
        this.drainResolvers = [];
    }

    private drain(): Promise<void> {
        if (!this.processing && this.queue.length === 0) {
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.drainResolvers.push(resolve);
        });
    }

    // ================================================================
    // FILE HANDLE MANAGEMENT
    // ================================================================

    private async writeLine(line: string): Promise<void> {
        if (!this.fd) {
            await this.ensureDirectory();
            this.fd = await fs.promises.open(this.outputPath, 'a');
        }
        await this.fd.write(line, undefined, 'utf8');
    }

    private async closeFd(): Promise<void> {
        if (this.fd) {
            try {
                await this.fd.close();
            } catch {
                // Best effort
            }
            this.fd = null;
        }
    }

    private async ensureDirectory(): Promise<void> {
        await fs.promises.mkdir(
            path.dirname(this.outputPath),
            { recursive: true }
        );
    }

    // ================================================================
    // ERROR HANDLING
    // ================================================================

    private async handleWriteError(
        err: NodeJS.ErrnoException,
        line: string
    ): Promise<void> {
        switch (err.code) {
            case 'ENOENT':
                await this.closeFd();
                try {
                    await this.ensureDirectory();
                    await this.writeLine(line);
                    this.bytesWritten += Buffer.byteLength(line, 'utf8');
                    this.entriesWritten++;
                } catch {
                    this.errorCount++;
                }
                break;

            case 'ENOSPC':
                // Disk full — clear queue to prevent spin loop (Claude Web fix)
                await this.closeFd();
                this.errorCount++;
                this.droppedCount += this.queue.length;
                this.queue.length = 0;
                this.processing = false;
                for (const resolve of this.drainResolvers) {
                    resolve();
                }
                this.drainResolvers = [];
                return;

            case 'EBADF':
                await this.closeFd();
                try {
                    await this.writeLine(line);
                    this.bytesWritten += Buffer.byteLength(line, 'utf8');
                    this.entriesWritten++;
                } catch {
                    this.errorCount++;
                }
                break;

            default:
                await this.closeFd();
                this.errorCount++;
                break;
        }
    }
}
