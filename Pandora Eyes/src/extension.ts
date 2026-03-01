import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FrictionEngine } from './friction';
import { FrictionWriter } from './writer';

const SESSION_ID = crypto.randomBytes(4).toString('hex');

let engine: FrictionEngine | null = null;
let writer: FrictionWriter | null = null;
let isActive = false;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let windowTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// ACTIVATION
// ============================================================================

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('pandoraEyes');

    if (!config.get<boolean>('enabled', true)) {
        return;
    }

    if (config.get<boolean>('debugLogging', false)) {
        outputChannel = vscode.window.createOutputChannel('Pandora Eyes');
        context.subscriptions.push(outputChannel);
        log('Activating Pandora Eyes...');
    }

    const writeAllowed = vscode.workspace.isTrusted;
    if (!writeAllowed) {
        log('Untrusted workspace — observer-only mode (no JSONL writes)');
        writer = null;
    } else {
        const outputPath = await resolveOutputPath(config);
        if (!outputPath) {
            log('No valid output path found — disabling');
            return;
        }

        log(`Output path: ${outputPath}`);
        writer = new FrictionWriter(outputPath, SESSION_ID);
    }
    engine = new FrictionEngine(SESSION_ID);
    isActive = true;

    // ---- Event Subscriptions ----
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (engine) engine.onEdit(e);
        }),
        vscode.workspace.onDidSaveTextDocument(e => {
            if (engine) engine.onSave(e);
        }),
        vscode.window.onDidChangeActiveTextEditor(e => {
            if (engine) engine.onTabSwitch(e);
        }),
        vscode.languages.onDidChangeDiagnostics(e => {
            if (engine) engine.onDiagnostics(e);
        }),
        vscode.debug.onDidStartDebugSession(e => {
            if (engine) engine.onDebugStart(e);
        }),
        vscode.debug.onDidTerminateDebugSession(e => {
            if (engine) engine.onDebugEnd(e);
        }),
        vscode.window.onDidOpenTerminal(() => {
            if (engine) engine.onTerminalOpen();
        }),
        vscode.tasks.onDidEndTaskProcess(e => {
            if (engine) engine.onTaskEnd(e);
        }),
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (engine) engine.onSelectionChange(e);
        }),
        vscode.workspace.onDidCloseTextDocument(e => {
            if (engine) engine.onDocumentClose(e);
        }),
        vscode.window.onDidChangeWindowState(e => {
            if (engine) engine.onWindowStateChange(e);
        }),
    );

    // ---- Timers ----
    const windowSec = config.get<number>('windowSeconds', 30);
    const heartbeatMin = config.get<number>('heartbeatIntervalMinutes', 5);

    windowTimer = setInterval(() => {
        try {
            if (!isActive || !engine) return;
            if (!engine.hasActivity()) return;
            const window = engine.flush();
            const cal = vscode.workspace.getConfiguration('pandoraEyes')
                .get<boolean>('calibrationMode', true);
            const thresh = vscode.workspace.getConfiguration('pandoraEyes')
                .get<number>('scoreThreshold', 0.0);
            if (cal || window.score >= thresh) {
                if (writer) {
                    writer.append(window);
                }
                log(`Flushed window: score=${window.score.toFixed(3)}, top=${window.top_signal}${writer ? '' : ' (observer-only, not persisted)'}`);
            }
        } catch (err) {
            log(`Flush error: ${err}`);
        }
    }, windowSec * 1000);

    if (writeAllowed) {
        heartbeatTimer = setInterval(() => {
            try {
                if (!isActive || !writer) return;
                writer.heartbeat();
            } catch (err) {
                log(`Heartbeat error: ${err}`);
            }
        }, heartbeatMin * 60 * 1000);
    }

    context.subscriptions.push({
        dispose: () => {
            if (windowTimer) clearInterval(windowTimer);
            if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
    });

    // ---- Status Bar ----
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBarItem.text = writeAllowed ? '$(eye) Pandora' : '$(eye) Pandora (RO)';
    statusBarItem.tooltip = writeAllowed
        ? 'Pandora Eyes — friction observation active'
        : 'Pandora Eyes — observer-only (untrusted workspace, no writes)';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ---- Config Reactivity ----
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('pandoraEyes')) return;

            if (e.affectsConfiguration('pandoraEyes.enabled')) {
                const nowEnabled = vscode.workspace
                    .getConfiguration('pandoraEyes')
                    .get<boolean>('enabled', true);
                if (!nowEnabled && isActive) {
                    deactivate();
                    if (statusBarItem) {
                        statusBarItem.text = '$(eye-closed) Pandora';
                        statusBarItem.tooltip = 'Pandora Eyes — disabled';
                    }
                }
            }

            if (e.affectsConfiguration('pandoraEyes.debugLogging')) {
                const debug = vscode.workspace
                    .getConfiguration('pandoraEyes')
                    .get<boolean>('debugLogging', false);
                if (debug && !outputChannel) {
                    outputChannel = vscode.window.createOutputChannel('Pandora Eyes');
                } else if (!debug && outputChannel) {
                    outputChannel.dispose();
                    outputChannel = null;
                }
            }
        })
    );

    log(`Pandora Eyes active. Session: ${SESSION_ID}, Window: ${windowSec}s`);
}

// ============================================================================
// DEACTIVATION
// ============================================================================

export async function deactivate() {
    // Clear timers first to prevent writes during shutdown (DeepSeek P1)
    if (windowTimer) { clearInterval(windowTimer); windowTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

    isActive = false;
    if (engine?.hasActivity() && writer) {
        try {
            const finalWindow = engine.flush();
            writer.append(finalWindow);
        } catch {
            // Best effort — VS Code is shutting down
        }
    }
    await writer?.close();
    engine = null;
    writer = null;
    log('Pandora Eyes deactivated');
}

// ============================================================================
// OUTPUT PATH RESOLUTION
// ============================================================================

async function resolveOutputPath(
    config: vscode.WorkspaceConfiguration
): Promise<string | null> {
    const explicit = config.get<string>('outputPath', '');
    if (explicit?.trim()) {
        const validated = await validateOutputPath(explicit.trim());
        if (validated) return validated;
        log(`Explicit outputPath invalid: ${explicit}`);
    }

    const envPath = process.env.PANDORA_TRAIN_DIR;
    if (envPath) {
        const validated = await validateOutputPath(
            path.join(envPath, 'friction.jsonl')
        );
        if (validated) return validated;
    }

    const candidates = [
        path.join('C:', 'Coherent Light Designs', '8 - Bus v1', '_train'),
    ];

    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        candidates.push(
            path.join(home, 'Coherent Light Designs', '8 - Bus v1', '_train')
        );
    }

    for (const dir of candidates) {
        try {
            await fs.promises.access(dir, fs.constants.F_OK | fs.constants.W_OK);
            const stats = await fs.promises.stat(dir);
            if (stats.isDirectory()) {
                return path.join(dir, 'friction.jsonl');
            }
        } catch {
            continue;
        }
    }

    return null;
}

async function validateOutputPath(filePath: string): Promise<string | null> {
    const resolved = path.resolve(filePath);

    if (path.extname(resolved).toLowerCase() !== '.jsonl') return null;

    const safePrefixes = [
        path.join('C:', 'Coherent Light Designs'),
        process.env.HOME || '',
        process.env.USERPROFILE || '',
        process.env.PANDORA_TRAIN_DIR || '',
    ].filter(Boolean);

    // Boundary-safe prefix check: require separator after prefix to prevent
    // sibling-dir bypass (e.g. "Coherent Light Designs Evil\")
    const isSafe = safePrefixes.some(prefix => {
        const resolvedPrefix = path.resolve(prefix);
        return isPathWithinPrefix(resolved, resolvedPrefix);
    });
    if (!isSafe) return null;

    const parentDir = path.dirname(resolved);
    try {
        await fs.promises.access(parentDir, fs.constants.F_OK | fs.constants.W_OK);
        return resolved;
    } catch {
        return null;
    }
}

function normalizePathForCompare(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithinPrefix(targetPath: string, prefixPath: string): boolean {
    const target = normalizePathForCompare(targetPath);
    const prefix = normalizePathForCompare(prefixPath);
    return target === prefix || target.startsWith(prefix + path.sep);
}

// ============================================================================
// LOGGING
// ============================================================================

function log(msg: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
}
