import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// ACTION REGISTRY
// ============================================================================

export const READ_ACTIONS = new Set([
    'get_workspace_state',
    'list_open_files',
    'get_active_file',
    'read_file',
    'get_diagnostics',
    'get_git_status',
    'get_problems',
]);

const WRITE_ACTIONS = new Set([
    'open_file',
    'apply_edit',
    'apply_patch',
    'create_file',
    'rename_file',
    'delete_file',
    'format_document',
    'save_file',
    'save_all',
    'close_file',
]);

const EXECUTE_ACTIONS = new Set([
    'run_task',
    'run_tests',
    'open_terminal',
    'add_workspace_folder',
]);

export const VALID_ACTIONS = new Set([
    ...READ_ACTIONS,
    ...WRITE_ACTIONS,
    ...EXECUTE_ACTIONS,
]);

// ============================================================================
// DISPATCH
// ============================================================================

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
    // Read
    get_workspace_state: handleGetWorkspaceState,
    list_open_files: handleListOpenFiles,
    get_active_file: handleGetActiveFile,
    read_file: handleReadFile,
    get_diagnostics: handleGetDiagnostics,
    get_git_status: handleGetGitStatus,
    get_problems: handleGetProblems,
    // Write
    open_file: handleOpenFile,
    apply_edit: handleApplyEdit,
    apply_patch: handleApplyPatch,
    create_file: handleCreateFile,
    rename_file: handleRenameFile,
    delete_file: handleDeleteFile,
    format_document: handleFormatDocument,
    save_file: handleSaveFile,
    save_all: handleSaveAll,
    close_file: handleCloseFile,
    // Execute
    run_task: handleRunTask,
    run_tests: handleRunTests,
    open_terminal: handleOpenTerminal,
    add_workspace_folder: handleAddWorkspaceFolder,
};

export async function handleAction(
    type: string,
    payload: Record<string, unknown>
): Promise<unknown> {
    const fn = handlers[type];
    if (!fn) throw new Error(`No handler for: ${type}`);
    return fn(payload);
}

// ============================================================================
// PATH CONTAINMENT — all file ops must stay within workspace folders
// ============================================================================

function assertPathInWorkspace(filePath: string, allowNonExistent = false): vscode.Uri {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('Invalid file path');
    }
    const normalized = path.resolve(filePath);

    // Check extra allowed paths from settings (e.g. Pandora's working directory)
    const extraPaths = vscode.workspace
        .getConfiguration('pandoraHands')
        .get<string[]>('allowedPaths', []);

    // Resolve symlinks to physical path to prevent jailbreak
    let realPath: string;
    if (allowNonExistent) {
        const parent = path.dirname(normalized);
        try {
            realPath = path.join(fs.realpathSync(parent), path.basename(normalized));
        } catch {
            throw new Error('Parent directory does not exist');
        }
    } else {
        try {
            realPath = fs.realpathSync(normalized);
        } catch {
            realPath = normalized;
        }
    }

    // Check workspace folders
    const folders = vscode.workspace.workspaceFolders || [];
    const inside = folders.some(f => {
        let folderReal: string;
        try { folderReal = fs.realpathSync(f.uri.fsPath); } catch { folderReal = f.uri.fsPath; }
        const rel = path.relative(folderReal, realPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });

    // Check extra allowed paths
    const inExtra = extraPaths.some(p => {
        const resolved = path.resolve(p);
        const rel = path.relative(resolved, realPath);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });

    if (!inside && !inExtra) {
        throw new Error('Path outside workspace folders');
    }
    return vscode.Uri.file(realPath);
}

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10MB

// ============================================================================
// READ HANDLERS
// ============================================================================

async function handleGetWorkspaceState(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const folders = vscode.workspace.workspaceFolders?.map(f => ({
        name: f.name,
        uri: f.uri.fsPath,
        index: f.index,
    })) || [];

    return {
        name: vscode.workspace.name || null,
        folders,
        trusted: vscode.workspace.isTrusted,
    };
}

async function handleListOpenFiles(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const files = vscode.window.tabGroups.all.flatMap(g =>
        g.tabs
            .filter(tab => tab.input instanceof vscode.TabInputText)
            .map(tab => {
                const input = tab.input as vscode.TabInputText;
                return {
                    uri: input.uri.fsPath,
                    isActive: tab.isActive,
                    isDirty: tab.isDirty,
                    group: g.viewColumn,
                };
            })
    );
    return { files };
}

async function handleGetActiveFile(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { active: null };
    return {
        active: {
            uri: editor.document.uri.fsPath,
            languageId: editor.document.languageId,
            lineCount: editor.document.lineCount,
            isDirty: editor.document.isDirty,
            selection: {
                start: {
                    line: editor.selection.start.line,
                    character: editor.selection.start.character,
                },
                end: {
                    line: editor.selection.end.line,
                    character: editor.selection.end.character,
                },
            },
        },
    };
}

async function handleReadFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');
    const uri = assertPathInWorkspace(filePath);

    // OOM prevention: check file size before reading
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_READ_FILE_BYTES) {
        throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 5MB)`);
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    return {
        content: doc.getText(),
        languageId: doc.languageId,
        lineCount: doc.lineCount,
        uri: doc.uri.fsPath,
    };
}

async function handleGetDiagnostics(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const all = vscode.languages.getDiagnostics();
    const entries = all
        .map(([uri, diags]) => ({
            uri: uri.fsPath,
            diagnostics: diags.map(d => ({
                message: d.message,
                severity: d.severity, // 0=Error, 1=Warning, 2=Info, 3=Hint
                range: {
                    start: { line: d.range.start.line, character: d.range.start.character },
                    end: { line: d.range.end.line, character: d.range.end.character },
                },
                source: d.source || null,
                code: d.code != null ? String(typeof d.code === 'object' ? (d.code as { value: string | number }).value : d.code) : null,
            })),
        }))
        .filter(e => e.diagnostics.length > 0);

    return { entries };
}

async function handleGetGitStatus(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return { available: false, reason: 'Git extension not found' };

    const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
    const api = git.getAPI(1);
    if (!api || api.repositories.length === 0) {
        return { available: false, reason: 'No git repositories' };
    }

    const repo = api.repositories[0];
    const state = repo.state;
    return {
        available: true,
        branch: state.HEAD?.name || null,
        commit: state.HEAD?.commit || null,
        changes: {
            staged: state.indexChanges?.length || 0,
            unstaged: state.workingTreeChanges?.length || 0,
            untracked: state.untrackedChanges?.length || 0,
        },
    };
}

async function handleGetProblems(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const all = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;
    let info = 0;

    for (const [, diags] of all) {
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
            else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
            else info++;
        }
    }

    return { errors, warnings, info, total: errors + warnings + info };
}

// ============================================================================
// WRITE HANDLERS
// ============================================================================

async function handleOpenFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');
    const uri = assertPathInWorkspace(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    return { opened: true, uri: doc.uri.fsPath };
}

async function handleApplyEdit(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    const edits = payload.edits as Array<{
        range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
        text: string;
    }>;
    if (!filePath) throw new Error('Missing path');
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('Missing or empty edits array');
    }

    // Write size cap — total edit text size
    let totalBytes = 0;
    for (const edit of edits) {
        totalBytes += (edit.text || '').length;
    }
    if (totalBytes > MAX_WRITE_BYTES) {
        throw new Error(`Total edit content too large (${(totalBytes / 1024 / 1024).toFixed(1)}MB, max 10MB)`);
    }

    const uri = assertPathInWorkspace(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);

    const wsEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
        if (!edit.range || !edit.range.start || !edit.range.end) {
            throw new Error('Invalid edit: missing range');
        }
        const { start, end } = edit.range;
        // Validate range values are sane integers
        if (!Number.isInteger(start.line) || !Number.isInteger(start.character) ||
            !Number.isInteger(end.line) || !Number.isInteger(end.character) ||
            start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) {
            throw new Error('Invalid edit: range values must be non-negative integers');
        }
        const range = doc.validateRange(new vscode.Range(
            start.line, start.character, end.line, end.character
        ));
        wsEdit.replace(uri, range, edit.text);
    }

    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (!applied) throw new Error('Edit rejected by VS Code');

    // Brief delay for language services to update diagnostics
    await new Promise(r => setTimeout(r, 200));
    const diagnostics = vscode.languages.getDiagnostics(uri);

    return {
        applied: true,
        diagnosticsAfter: diagnostics.map(d => ({
            message: d.message,
            severity: d.severity,
            range: {
                start: { line: d.range.start.line, character: d.range.start.character },
                end: { line: d.range.end.line, character: d.range.end.character },
            },
        })),
    };
}

async function handleApplyPatch(
    payload: Record<string, unknown>
): Promise<unknown> {
    const diff = payload.diff as string;
    if (!diff || typeof diff !== 'string') throw new Error('Missing diff');

    // Parse file targets from unified diff
    const fileTargets: string[] = [];
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            fileTargets.push(line.slice(6));
        }
    }
    if (fileTargets.length === 0) {
        throw new Error('No file targets found in diff — use apply_edit for structured edits');
    }

    // Validate all target files are in workspace
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folders');
    for (const rel of fileTargets) {
        const abs = path.join(folders[0].uri.fsPath, rel);
        assertPathInWorkspace(abs);
    }

    // Apply via git apply if git extension available
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt) {
        const git = gitExt.isActive ? gitExt.exports : await gitExt.activate();
        const api = git.getAPI(1);
        if (api && api.repositories.length > 0) {
            await api.repositories[0].apply(diff);
            return { applied: true, method: 'git_apply', filesPatched: fileTargets.length };
        }
    }

    return {
        applied: false,
        reason: 'Git extension unavailable — use apply_edit for structured edits',
        filesTargeted: fileTargets,
    };
}

async function handleCreateFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    const content = (payload.content as string) ?? '';
    if (!filePath) throw new Error('Missing path');
    if (content.length > MAX_WRITE_BYTES) {
        throw new Error(`Content too large (${(content.length / 1024 / 1024).toFixed(1)}MB, max 10MB)`);
    }

    const uri = assertPathInWorkspace(filePath, true);

    // Atomic create — use wx flag to fail if file exists (no TOCTOU race)
    try {
        await fs.promises.writeFile(uri.fsPath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('File already exists');
        }
        throw err;
    }
    return { created: true, uri: uri.fsPath };
}

async function handleRenameFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const oldPath = payload.oldPath as string;
    const newPath = payload.newPath as string;
    if (!oldPath || !newPath) throw new Error('Missing oldPath or newPath');

    const oldUri = assertPathInWorkspace(oldPath);
    const newUri = assertPathInWorkspace(newPath);

    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.renameFile(oldUri, newUri);
    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (!applied) throw new Error('Rename rejected by VS Code');

    return { renamed: true, from: oldUri.fsPath, to: newUri.fsPath };
}

async function handleDeleteFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');

    const uri = assertPathInWorkspace(filePath);
    await vscode.workspace.fs.delete(uri, { recursive: false });

    return { deleted: true, uri: uri.fsPath };
}

async function handleFormatDocument(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');

    const uri = assertPathInWorkspace(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        uri,
        { tabSize: 4, insertSpaces: true }
    );

    if (edits && edits.length > 0) {
        const wsEdit = new vscode.WorkspaceEdit();
        for (const edit of edits) {
            wsEdit.replace(uri, edit.range, edit.newText);
        }
        await vscode.workspace.applyEdit(wsEdit);
    }

    return { formatted: true, editsApplied: edits?.length || 0 };
}

async function handleSaveFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');

    assertPathInWorkspace(filePath);
    const uri = vscode.Uri.file(path.resolve(filePath));
    const doc = await vscode.workspace.openTextDocument(uri);
    const saved = await doc.save();

    return { saved, uri: doc.uri.fsPath };
}

async function handleSaveAll(
    _payload: Record<string, unknown>
): Promise<unknown> {
    const saved = await vscode.workspace.saveAll(false);
    return { saved };
}

async function handleCloseFile(
    payload: Record<string, unknown>
): Promise<unknown> {
    const filePath = payload.path as string;
    if (!filePath) throw new Error('Missing path');

    const normalized = path.resolve(filePath);
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.fsPath === normalized
            ) {
                await vscode.window.tabGroups.close(tab);
                return { closed: true, uri: normalized };
            }
        }
    }

    return { closed: false, reason: 'File not open' };
}

// ============================================================================
// EXECUTE HANDLERS
// ============================================================================

const TASK_TIMEOUT_MS = 60_000;

async function handleRunTask(
    payload: Record<string, unknown>
): Promise<unknown> {
    const taskName = payload.task as string;
    if (!taskName) throw new Error('Missing task name');

    const tasks = await vscode.tasks.fetchTasks();
    const match = tasks.find(
        t => t.name === taskName || `${t.source}: ${t.name}` === taskName
    );
    if (!match) throw new Error(`Task not found: ${taskName}`);

    const execution = await vscode.tasks.executeTask(match);

    return new Promise(resolve => {
        let settled = false;

        const disposable = vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === execution && !settled) {
                settled = true;
                disposable.dispose();
                resolve({
                    task: taskName,
                    exitCode: e.exitCode,
                    completed: true,
                });
            }
        });

        setTimeout(() => {
            if (!settled) {
                settled = true;
                disposable.dispose();
                resolve({
                    task: taskName,
                    exitCode: null,
                    completed: false,
                    reason: 'timeout',
                });
            }
        }, TASK_TIMEOUT_MS);
    });
}

async function handleRunTests(
    payload: Record<string, unknown>
): Promise<unknown> {
    const target = (payload.target as string) || 'test';
    // Delegate to task runner — test frameworks register as VS Code tasks
    return handleRunTask({ task: target });
}

async function handleOpenTerminal(
    payload: Record<string, unknown>
): Promise<unknown> {
    // Shell execution requires explicit opt-in — disabled by default
    const allowShell = vscode.workspace
        .getConfiguration('pandoraHands')
        .get<boolean>('allowShellExecution', false);
    if (!allowShell) {
        throw new Error('Terminal execution disabled — enable pandoraHands.allowShellExecution in settings');
    }

    const command = payload.command as string;
    if (!command) throw new Error('Missing command');

    const terminal = vscode.window.createTerminal('Pandora');
    terminal.show();
    terminal.sendText(command);

    return { opened: true, command };
}

async function handleAddWorkspaceFolder(
    payload: Record<string, unknown>
): Promise<unknown> {
    const folderPath = payload.path as string;
    if (!folderPath) throw new Error('Missing path');

    const uri = vscode.Uri.file(path.resolve(folderPath));

    // Check if already in workspace
    const existing = vscode.workspace.workspaceFolders || [];
    const alreadyAdded = existing.some(f => {
        try {
            const rel = path.relative(f.uri.fsPath, uri.fsPath);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        } catch { return false; }
    });
    if (alreadyAdded) {
        return { added: false, reason: 'Already in workspace', folders: existing.length };
    }

    const success = vscode.workspace.updateWorkspaceFolders(
        existing.length, 0,
        { uri, name: payload.name as string || path.basename(folderPath) }
    );

    return {
        added: success,
        path: uri.fsPath,
        folders: (vscode.workspace.workspaceFolders || []).length,
    };
}
