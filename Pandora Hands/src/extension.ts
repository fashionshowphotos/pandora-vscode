import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RpcServer } from './rpc_server';

let server: RpcServer | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

// ============================================================================
// ACTIVATION
// ============================================================================

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('pandoraHands');

    if (!config.get<boolean>('enabled', true)) return;

    if (!vscode.workspace.isTrusted) {
        // Pandora Hands requires trusted workspace — manifest enforces this too
        return;
    }

    if (config.get<boolean>('debugLogging', false)) {
        outputChannel = vscode.window.createOutputChannel('Pandora Hands');
        context.subscriptions.push(outputChannel);
    }

    const port = config.get<number>('port', 7345);
    const readOnly = config.get<boolean>('readOnly', false);
    const auditEnabled = config.get<boolean>('auditLog', true);

    // Auth token — read from file or auto-generate
    const token = await resolveAuthToken(config, context);

    // Audit log path
    const auditPath = auditEnabled
        ? path.join(context.globalStorageUri.fsPath, 'audit.jsonl')
        : null;

    if (auditPath) {
        await fs.promises.mkdir(path.dirname(auditPath), { recursive: true });
    }

    server = new RpcServer({
        port,
        token,
        readOnly,
        auditPath,
        log: (msg: string) => {
            if (outputChannel) {
                outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
            }
        },
    });

    try {
        await server.start();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Pandora Hands: Failed to start RPC server: ${msg}`);
        return;
    }

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    updateStatusBar(false);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Track connection state
    server.onConnectionChange = (connected: boolean) => {
        updateStatusBar(connected);
    };

    // Config reactivity
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('pandoraHands.enabled')) {
                const nowEnabled = vscode.workspace
                    .getConfiguration('pandoraHands')
                    .get<boolean>('enabled', true);
                if (!nowEnabled) deactivate();
            }
            if (e.affectsConfiguration('pandoraHands.readOnly')) {
                const ro = vscode.workspace
                    .getConfiguration('pandoraHands')
                    .get<boolean>('readOnly', false);
                if (server) server.readOnly = ro;
            }
        })
    );

    context.subscriptions.push({ dispose: () => deactivate() });

    if (outputChannel) {
        outputChannel.appendLine(`Pandora Hands active on ws://127.0.0.1:${port}`);
        outputChannel.appendLine(`Read-only: ${readOnly}`);
        outputChannel.appendLine(`Audit: ${auditPath || 'disabled'}`);
    }
}

// ============================================================================
// DEACTIVATION
// ============================================================================

export async function deactivate() {
    if (server) {
        server.stop();
        server = null;
    }
    if (statusBarItem) {
        statusBarItem.text = '$(plug) Hands OFF';
        statusBarItem.tooltip = 'Pandora Hands — stopped';
    }
}

// ============================================================================
// AUTH TOKEN
// ============================================================================

async function resolveAuthToken(
    config: vscode.WorkspaceConfiguration,
    context: vscode.ExtensionContext
): Promise<string> {
    const explicit = config.get<string>('tokenFile', '');
    if (explicit?.trim()) {
        try {
            return (await fs.promises.readFile(explicit.trim(), 'utf-8')).trim();
        } catch {
            // Fall through to auto-generate
        }
    }

    // Auto-generate and persist in global storage
    const tokenPath = path.join(context.globalStorageUri.fsPath, 'auth_token');
    try {
        await fs.promises.mkdir(path.dirname(tokenPath), { recursive: true });
        const existing = await fs.promises.readFile(tokenPath, 'utf-8');
        if (existing.trim().length >= 16) return existing.trim();
    } catch { /* doesn't exist yet */ }

    const token = crypto.randomBytes(32).toString('hex');
    await fs.promises.writeFile(tokenPath, token, { encoding: 'utf-8', mode: 0o600 });
    return token;
}

// ============================================================================
// STATUS BAR
// ============================================================================

function updateStatusBar(connected: boolean) {
    if (!statusBarItem) return;
    if (connected) {
        statusBarItem.text = '$(plug) Hands LIVE';
        statusBarItem.tooltip = 'Pandora Hands — Pandora connected';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(plug) Hands';
        statusBarItem.tooltip = 'Pandora Hands — waiting for connection';
        statusBarItem.backgroundColor = undefined;
    }
}
