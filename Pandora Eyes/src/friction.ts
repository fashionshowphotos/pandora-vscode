import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';

// ============================================================================
// FRICTION WINDOW SCHEMA (v1)
// ============================================================================

export interface FrictionWindow {
    version: 1;
    type: 'friction';
    ts: string;
    session_id: string;
    window_duration_sec: number;

    // Raw signals
    edit_count: number;
    undo_count: number;
    save_count: number;
    file_churn: number;
    tab_switches: number;
    diagnostic_delta: number;
    debug_restarts: number;
    terminal_opens: number;
    task_failures: number;
    selection_changes: number;
    docs_closed_unedited: number;
    focus_losses: number;

    // Derived
    edit_velocity: number;
    undo_rate: number;
    save_freq: number;
    dwell_time: number;

    // Composite
    score: number;
    top_signal: string;
    signal_breakdown: Record<string, number>;
    context: {
        file_hash: string;
        workspace_hash: string;
        file_ext: string;
        language: string;
    };
}

// ============================================================================
// SCORING WEIGHTS (consensus from 5/5 AI review)
// ============================================================================

const WEIGHTS: Record<string, number> = {
    undo_rate: 0.20,
    diagnostic_delta: 0.20,
    debug_restarts: 0.15,
    dwell_time: 0.15,
    task_failures: 0.10,
    file_churn: 0.10,
    tab_switches: 0.05,
    terminal_opens: 0.05,
};

// ============================================================================
// FRICTION ENGINE
// ============================================================================

export class FrictionEngine {
    private sessionId: string;
    private windowStart: number;

    // Raw counters
    private editCount = 0;
    private undoCount = 0;
    private saveCount = 0;
    private tabSwitches = 0;
    private debugRestarts = 0;
    private terminalOpens = 0;
    private taskFailures = 0;
    private selectionChanges = 0;
    private docsClosedUnedited = 0;
    private focusLosses = 0;

    // File tracking
    private filesEdited = new Set<string>();
    private activeFile: string | null = null;
    private activeLanguage = '';

    // Diagnostic baseline (per-window snapshot)
    private diagnosticBaseline: number | null = null;
    private latestDiagnosticCount = 0;

    // Dwell tracking (focus-aware)
    private lastEditTime = 0;
    private isFocused = true;

    // Document open tracking (LRU eviction at capacity)
    private openedDocs = new Map<string, { wasEdited: boolean; lastAccess: number }>();
    private readonly MAX_TRACKED_DOCS = 200;

    // Selection debounce
    private selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly SELECTION_DEBOUNCE_MS = 300;

    // Activity guard
    private activityDetected = false;

    // Workspace hash (computed once)
    private workspaceHash: string;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
        this.windowStart = Date.now();

        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.workspaceHash = this.hashPath(wsFolder);
    }

    // ============================================================================
    // EVENT HANDLERS
    // ============================================================================

    onEdit(e: vscode.TextDocumentChangeEvent): void {
        if (e.document.uri.scheme !== 'file') return;
        this.activityDetected = true;
        this.editCount += e.contentChanges.length;
        this.lastEditTime = Date.now();

        const uri = e.document.uri.toString();
        this.filesEdited.add(uri);

        // Track that this doc was edited (LRU update)
        this.trackDoc(uri, true);

        // Hybrid undo detection (API + heuristic)
        // 1. API signal: VS Code undo reason
        if (e.reason === vscode.TextDocumentChangeReason.Undo) {
            this.undoCount++;
            return;
        }
        // 2. Heuristic: significant deletion with minimal replacement
        for (const change of e.contentChanges) {
            if (change.rangeLength > 0 && change.text.length < change.rangeLength * 0.5) {
                this.undoCount++;
            }
        }
    }

    onSave(_e: vscode.TextDocument): void {
        this.activityDetected = true;
        this.saveCount++;
    }

    onTabSwitch(editor: vscode.TextEditor | undefined): void {
        this.activityDetected = true;
        this.tabSwitches++;

        if (editor?.document.uri.scheme === 'file') {
            const fsPath = editor.document.uri.fsPath;
            this.activeFile = fsPath;
            this.activeLanguage = editor.document.languageId;

            // Track opened doc (LRU update)
            const uri = editor.document.uri.toString();
            this.trackDoc(uri, this.openedDocs.get(uri)?.wasEdited ?? false);
        }
    }

    onDiagnostics(_e: vscode.DiagnosticChangeEvent): void {
        // Count total diagnostics across all files
        let total = 0;
        for (const [, diags] of vscode.languages.getDiagnostics()) {
            total += diags.filter(d =>
                d.severity === vscode.DiagnosticSeverity.Error ||
                d.severity === vscode.DiagnosticSeverity.Warning
            ).length;
        }
        this.latestDiagnosticCount = total;

        // Snapshot baseline on first diagnostic event in this window
        if (this.diagnosticBaseline === null) {
            this.diagnosticBaseline = total;
        }
    }

    onDebugStart(_e: vscode.DebugSession): void {
        this.activityDetected = true;
    }

    onDebugEnd(_e: vscode.DebugSession): void {
        this.activityDetected = true;
        this.debugRestarts++;
    }

    onTerminalOpen(): void {
        this.activityDetected = true;
        this.terminalOpens++;
    }

    onTaskEnd(e: vscode.TaskProcessEndEvent): void {
        this.activityDetected = true;
        if (e.exitCode !== undefined && e.exitCode !== 0) {
            this.taskFailures++;
        }
    }

    onSelectionChange(_e: vscode.TextEditorSelectionChangeEvent): void {
        // Debounced — only count if rapid-fire selections (thrashing)
        if (this.selectionDebounceTimer) {
            clearTimeout(this.selectionDebounceTimer);
        }
        this.selectionDebounceTimer = setTimeout(() => {
            this.selectionChanges++;
            this.selectionDebounceTimer = null;
        }, this.SELECTION_DEBOUNCE_MS);
    }

    onDocumentClose(doc: vscode.TextDocument): void {
        if (doc.uri.scheme !== 'file') return;
        const uri = doc.uri.toString();
        const entry = this.openedDocs.get(uri);
        if (entry && !entry.wasEdited) {
            this.docsClosedUnedited++;
        }
        this.openedDocs.delete(uri);
    }

    onWindowStateChange(state: vscode.WindowState): void {
        if (!state.focused && this.isFocused) {
            this.focusLosses++;
        }
        this.isFocused = state.focused;
    }

    // ============================================================================
    // WINDOW MANAGEMENT
    // ============================================================================

    hasActivity(): boolean {
        return this.activityDetected;
    }

    flush(): FrictionWindow {
        const now = Date.now();
        const durationSec = (now - this.windowStart) / 1000;

        // Derived signals
        const editVelocity = durationSec > 0 ? this.editCount / durationSec : 0;
        const undoRate = this.editCount > 0 ? this.undoCount / this.editCount : 0;
        const saveFreq = durationSec > 0 ? this.saveCount / (durationSec / 60) : 0;

        // Dwell: time since last edit (only while focused)
        const dwellTime = this.isFocused && this.lastEditTime > 0
            ? (now - this.lastEditTime) / 1000
            : 0;

        // Diagnostic delta (from baseline)
        const diagnosticDelta = this.diagnosticBaseline !== null
            ? Math.max(0, this.latestDiagnosticCount - this.diagnosticBaseline)
            : 0;

        const fileChurn = this.filesEdited.size;

        // Score computation
        const signals: Record<string, number> = {
            undo_rate: Math.min(undoRate, 1),
            diagnostic_delta: Math.min(diagnosticDelta / 10, 1),
            debug_restarts: Math.min(this.debugRestarts / 3, 1),
            dwell_time: Math.min(dwellTime / 120, 1), // 2min max
            task_failures: Math.min(this.taskFailures / 3, 1),
            file_churn: Math.min(fileChurn / 10, 1),
            tab_switches: Math.min(this.tabSwitches / 20, 1),
            terminal_opens: Math.min(this.terminalOpens / 5, 1),
        };

        const breakdown: Record<string, number> = {};
        let score = 0;
        for (const [key, weight] of Object.entries(WEIGHTS)) {
            const contribution = (signals[key] || 0) * weight;
            breakdown[key] = contribution;
            score += contribution;
        }
        score = Math.min(Math.max(score, 0), 1);

        // Top signal
        let topSignal = 'none';
        let topContribution = 0;
        for (const [key, val] of Object.entries(breakdown)) {
            if (val > topContribution) {
                topContribution = val;
                topSignal = key;
            }
        }

        // Context (privacy-safe)
        const fileHash = this.activeFile
            ? this.hashPath(path.relative(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                this.activeFile
              ))
            : '';
        const fileExt = this.activeFile
            ? path.extname(this.activeFile)
            : '';

        const window: FrictionWindow = {
            version: 1,
            type: 'friction',
            ts: new Date().toISOString(),
            session_id: this.sessionId,
            window_duration_sec: Math.round(durationSec),

            edit_count: this.editCount,
            undo_count: this.undoCount,
            save_count: this.saveCount,
            file_churn: fileChurn,
            tab_switches: this.tabSwitches,
            diagnostic_delta: diagnosticDelta,
            debug_restarts: this.debugRestarts,
            terminal_opens: this.terminalOpens,
            task_failures: this.taskFailures,
            selection_changes: this.selectionChanges,
            docs_closed_unedited: this.docsClosedUnedited,
            focus_losses: this.focusLosses,

            edit_velocity: Math.round(editVelocity * 100) / 100,
            undo_rate: Math.round(undoRate * 1000) / 1000,
            save_freq: Math.round(saveFreq * 100) / 100,
            dwell_time: Math.round(dwellTime),

            score,
            top_signal: topSignal,
            signal_breakdown: breakdown,
            context: {
                file_hash: fileHash,
                workspace_hash: this.workspaceHash,
                file_ext: fileExt,
                language: this.activeLanguage,
            },
        };

        // Reset for next window
        this.resetCounters();

        // Return deep clone to prevent mutation (Kimi P1)
        return JSON.parse(JSON.stringify(window)) as FrictionWindow;
    }

    // ============================================================================
    // INTERNALS
    // ============================================================================

    // LRU document tracking with eviction at capacity (Kimi P1)
    private trackDoc(uri: string, wasEdited: boolean): void {
        // Delete and re-insert to maintain Map insertion order (LRU)
        if (this.openedDocs.has(uri)) {
            const existing = this.openedDocs.get(uri)!;
            this.openedDocs.delete(uri);
            this.openedDocs.set(uri, {
                wasEdited: existing.wasEdited || wasEdited,
                lastAccess: Date.now(),
            });
        } else {
            // Evict LRU (oldest by insertion order) when at capacity
            if (this.openedDocs.size >= this.MAX_TRACKED_DOCS) {
                const oldest = this.openedDocs.keys().next().value;
                if (oldest !== undefined) this.openedDocs.delete(oldest);
            }
            this.openedDocs.set(uri, { wasEdited, lastAccess: Date.now() });
        }
    }

    private resetCounters(): void {
        this.windowStart = Date.now();
        this.editCount = 0;
        this.undoCount = 0;
        this.saveCount = 0;
        this.tabSwitches = 0;
        this.debugRestarts = 0;
        this.terminalOpens = 0;
        this.taskFailures = 0;
        this.selectionChanges = 0;
        this.docsClosedUnedited = 0;
        this.focusLosses = 0;
        this.filesEdited.clear();
        this.diagnosticBaseline = null;
        this.latestDiagnosticCount = 0;
        this.lastEditTime = 0;
        this.activityDetected = false;

        if (this.selectionDebounceTimer) {
            clearTimeout(this.selectionDebounceTimer);
            this.selectionDebounceTimer = null;
        }
    }

    private hashPath(p: string): string {
        if (!p) return '';
        return crypto.createHash('sha256').update(p).digest('hex').slice(0, 12);
    }
}
