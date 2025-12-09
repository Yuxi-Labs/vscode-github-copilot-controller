import * as vscode from 'vscode';
import { 
    WriteFilePayload, 
    EditFilePayload, 
    WriteResultResponse, 
    EditResultResponse,
    FileEdit 
} from './types';

/**
 * Represents a pending file change awaiting user approval
 */
export interface PendingChange {
    id: string;
    sessionId: string;
    type: 'edit' | 'write';
    path: string;
    originalContent?: string;      // Original file content for diff generation
    newContent?: string;            // New content for write operations
    edits?: FileEdit[];             // Edit operations for edit mode
    diff?: string;                  // Generated unified diff
    additions: number;              // Lines added
    deletions: number;              // Lines deleted
    timestamp: number;
    status: 'pending' | 'approved' | 'rejected';
}

/**
 * Manages pending file changes with buffering and approval workflow
 */
export class ChangeBuffer {
    private changes: Map<string, PendingChange> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Buffer a write file operation and generate diff
     */
    async bufferWriteFile(
        sessionId: string,
        payload: WriteFilePayload
    ): Promise<PendingChange> {
        const changeId = this.generateChangeId();
        const { path, content } = payload;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder open');
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            // Try to read existing content for diff
            let originalContent = '';
            let isNewFile = false;
            try {
                const fileData = await vscode.workspace.fs.readFile(fileUri);
                originalContent = new TextDecoder().decode(fileData);
            } catch {
                // File doesn't exist - this is a new file
                isNewFile = true;
            }

            // Generate diff
            const { diff, additions, deletions } = this.generateDiff(
                originalContent,
                content,
                path,
                isNewFile
            );

            const change: PendingChange = {
                id: changeId,
                sessionId,
                type: 'write',
                path,
                originalContent,
                newContent: content,
                diff,
                additions,
                deletions,
                timestamp: Date.now(),
                status: 'pending'
            };

            this.changes.set(changeId, change);
            this.log(`Buffered write operation: ${path} (+${additions} -${deletions})`);

            return change;
        } catch (error) {
            this.log(`Error buffering write: ${error}`);
            throw error;
        }
    }

    /**
     * Buffer an edit file operation and generate diff
     */
    async bufferEditFile(
        sessionId: string,
        payload: EditFilePayload
    ): Promise<PendingChange> {
        const changeId = this.generateChangeId();
        const { path, edits } = payload;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder open');
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            // Read original content
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const originalContent = new TextDecoder().decode(fileData);

            // Apply edits to generate new content
            const newContent = this.applyEditsToContent(originalContent, edits);

            // Generate diff
            const { diff, additions, deletions } = this.generateDiff(
                originalContent,
                newContent,
                path
            );

            const change: PendingChange = {
                id: changeId,
                sessionId,
                type: 'edit',
                path,
                originalContent,
                edits,
                diff,
                additions,
                deletions,
                timestamp: Date.now(),
                status: 'pending'
            };

            this.changes.set(changeId, change);
            this.log(`Buffered edit operation: ${path} (${edits.length} edits, +${additions} -${deletions})`);

            return change;
        } catch (error) {
            this.log(`Error buffering edit: ${error}`);
            throw error;
        }
    }

    /**
     * Apply an approved change to the workspace
     */
    async approveChange(changeId: string): Promise<WriteResultResponse | EditResultResponse> {
        const change = this.changes.get(changeId);
        if (!change) {
            throw new Error(`Change ${changeId} not found`);
        }

        if (change.status !== 'pending') {
            throw new Error(`Change ${changeId} is not pending (status: ${change.status})`);
        }

        try {
            change.status = 'approved';

            if (change.type === 'write') {
                return await this.applyWriteChange(change);
            } else {
                return await this.applyEditChange(change);
            }
        } catch (error) {
            change.status = 'pending'; // Revert status on error
            throw error;
        }
    }

    /**
     * Reject a pending change
     */
    rejectChange(changeId: string): void {
        const change = this.changes.get(changeId);
        if (!change) {
            throw new Error(`Change ${changeId} not found`);
        }

        change.status = 'rejected';
        this.log(`Rejected change: ${change.path}`);
    }

    /**
     * Approve multiple changes at once
     */
    async batchApprove(changeIds: string[]): Promise<Map<string, WriteResultResponse | EditResultResponse>> {
        const results = new Map<string, WriteResultResponse | EditResultResponse>();

        for (const id of changeIds) {
            try {
                const result = await this.approveChange(id);
                results.set(id, result);
            } catch (error) {
                results.set(id, {
                    path: this.changes.get(id)?.path || 'unknown',
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return results;
    }

    /**
     * Reject multiple changes at once
     */
    batchReject(changeIds: string[]): void {
        for (const id of changeIds) {
            try {
                this.rejectChange(id);
            } catch (error) {
                this.log(`Error rejecting change ${id}: ${error}`);
            }
        }
    }

    /**
     * Get all pending changes for a session
     */
    getPendingChanges(sessionId?: string): PendingChange[] {
        const changes = Array.from(this.changes.values());
        if (sessionId) {
            return changes.filter(c => c.sessionId === sessionId && c.status === 'pending');
        }
        return changes.filter(c => c.status === 'pending');
    }

    /**
     * Get a specific change
     */
    getChange(changeId: string): PendingChange | undefined {
        return this.changes.get(changeId);
    }

    /**
     * Clear all changes for a session
     */
    clearSession(sessionId: string): void {
        for (const [id, change] of this.changes.entries()) {
            if (change.sessionId === sessionId) {
                this.changes.delete(id);
            }
        }
        this.log(`Cleared all changes for session ${sessionId}`);
    }

    /**
     * Clear all approved/rejected changes (cleanup)
     */
    clearProcessedChanges(): void {
        for (const [id, change] of this.changes.entries()) {
            if (change.status !== 'pending') {
                this.changes.delete(id);
            }
        }
    }

    // ==================== Private Methods ====================

    private async applyWriteChange(change: PendingChange): Promise<WriteResultResponse> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path: change.path,
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, change.path);

            // Create parent directories if needed
            const parentUri = vscode.Uri.joinPath(fileUri, '..');
            try {
                await vscode.workspace.fs.stat(parentUri);
            } catch {
                await vscode.workspace.fs.createDirectory(parentUri);
            }

            // Write the file
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(fileUri, encoder.encode(change.newContent!));

            this.log(`Applied write change: ${change.path}`);

            return {
                path: change.path,
                success: true
            };
        } catch (error) {
            return {
                path: change.path,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private async applyEditChange(change: PendingChange): Promise<EditResultResponse> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path: change.path,
                    success: false,
                    appliedEdits: 0,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, change.path);

            // Open the document
            const document = await vscode.workspace.openTextDocument(fileUri);
            
            // Create a workspace edit
            const workspaceEdit = new vscode.WorkspaceEdit();

            // Apply each edit (in reverse order to maintain line numbers)
            const sortedEdits = [...change.edits!].sort((a, b) => b.startLine - a.startLine);
            
            for (const edit of sortedEdits) {
                const startLine = Math.max(0, edit.startLine - 1);
                const endLine = Math.min(document.lineCount - 1, edit.endLine - 1);
                
                const range = new vscode.Range(
                    startLine, 0,
                    endLine, document.lineAt(endLine).text.length
                );
                
                workspaceEdit.replace(fileUri, range, edit.newText);
            }

            // Apply the edit
            const success = await vscode.workspace.applyEdit(workspaceEdit);

            if (success) {
                // Save the document
                await document.save();
                this.log(`Applied edit change: ${change.path} (${change.edits!.length} edits)`);
            }

            return {
                path: change.path,
                success,
                appliedEdits: success ? change.edits!.length : 0
            };
        } catch (error) {
            return {
                path: change.path,
                success: false,
                appliedEdits: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Generate unified diff between original and new content
     */
    private generateDiff(
        original: string,
        modified: string,
        filename: string,
        isNewFile = false
    ): { diff: string; additions: number; deletions: number } {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');

        let additions = 0;
        let deletions = 0;
        const diffLines: string[] = [];

        if (isNewFile) {
            // New file - all lines are additions
            additions = modifiedLines.length;
            diffLines.push(`--- /dev/null`);
            diffLines.push(`+++ ${filename}`);
            diffLines.push(`@@ -0,0 +1,${modifiedLines.length} @@`);
            modifiedLines.forEach(line => {
                diffLines.push(`+${line}`);
            });
        } else {
            // Simple line-by-line diff (can be enhanced with proper diff algorithm)
            diffLines.push(`--- ${filename}`);
            diffLines.push(`+++ ${filename}`);

            const maxLines = Math.max(originalLines.length, modifiedLines.length);
            let hunkStart = -1;
            const hunkLines: string[] = [];

            for (let i = 0; i < maxLines; i++) {
                const origLine = originalLines[i];
                const modLine = modifiedLines[i];

                if (origLine !== modLine) {
                    if (hunkStart === -1) {
                        hunkStart = i;
                    }

                    if (origLine !== undefined && modLine !== undefined) {
                        // Changed line
                        hunkLines.push(`-${origLine}`);
                        hunkLines.push(`+${modLine}`);
                        deletions++;
                        additions++;
                    } else if (origLine !== undefined) {
                        // Deleted line
                        hunkLines.push(`-${origLine}`);
                        deletions++;
                    } else {
                        // Added line
                        hunkLines.push(`+${modLine}`);
                        additions++;
                    }
                } else {
                    // Context line
                    if (hunkStart !== -1 && hunkLines.length > 0) {
                        hunkLines.push(` ${origLine}`);
                    }
                }
            }

            if (hunkLines.length > 0) {
                diffLines.push(`@@ -${hunkStart + 1},${originalLines.length - hunkStart} +${hunkStart + 1},${modifiedLines.length - hunkStart} @@`);
                diffLines.push(...hunkLines);
            }
        }

        return {
            diff: diffLines.join('\n'),
            additions,
            deletions
        };
    }

    /**
     * Apply edits to content string to generate preview
     */
    private applyEditsToContent(content: string, edits: FileEdit[]): string {
        const lines = content.split('\n');
        
        // Sort edits in reverse order to maintain line numbers
        const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);
        
        for (const edit of sortedEdits) {
            const startLine = Math.max(0, edit.startLine - 1);
            const endLine = Math.min(lines.length - 1, edit.endLine - 1);
            
            // Replace lines
            const newLines = edit.newText.split('\n');
            lines.splice(startLine, endLine - startLine + 1, ...newLines);
        }
        
        return lines.join('\n');
    }

    private generateChangeId(): string {
        return `change-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[ChangeBuffer] ${message}`);
    }
}
