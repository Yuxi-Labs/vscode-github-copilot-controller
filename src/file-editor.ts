import * as vscode from 'vscode';
import { 
    WriteFilePayload, 
    EditFilePayload, 
    OpenFilePayload,
    WriteResultResponse,
    EditResultResponse,
    OpenResultResponse
} from './types';

/**
 * Handles remote file editing operations
 */
export class FileEditor {
    
    /**
     * Write content to a file (create or overwrite)
     */
    async writeFile(payload: WriteFilePayload): Promise<WriteResultResponse> {
        const { path, content, createDirs = true } = payload;
        
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path,
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            // Create parent directories if needed
            if (createDirs) {
                const parentUri = vscode.Uri.joinPath(fileUri, '..');
                try {
                    await vscode.workspace.fs.stat(parentUri);
                } catch {
                    // Parent doesn't exist, create it
                    await vscode.workspace.fs.createDirectory(parentUri);
                }
            }

            // Write the file
            const encoder = new TextEncoder();
            await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));

            return {
                path,
                success: true
            };
        } catch (error) {
            return {
                path,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Apply edits to an existing file
     */
    async editFile(payload: EditFilePayload): Promise<EditResultResponse> {
        const { path, edits } = payload;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path,
                    success: false,
                    appliedEdits: 0,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            // Open the document
            const document = await vscode.workspace.openTextDocument(fileUri);
            
            // Create a workspace edit
            const workspaceEdit = new vscode.WorkspaceEdit();

            // Apply each edit (in reverse order to maintain line numbers)
            const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);
            
            for (const edit of sortedEdits) {
                // Convert 1-based to 0-based line numbers
                const startLine = Math.max(0, edit.startLine - 1);
                const endLine = Math.min(document.lineCount - 1, edit.endLine - 1);
                
                const range = new vscode.Range(
                    startLine, 0,
                    endLine, document.lineAt(endLine).text.length
                );
                
                workspaceEdit.replace(fileUri, range, edit.newText);
            }

            // Apply the edits
            const success = await vscode.workspace.applyEdit(workspaceEdit);

            if (success) {
                // Save the document
                await document.save();
            }

            return {
                path,
                success,
                appliedEdits: success ? edits.length : 0,
                error: success ? undefined : 'Failed to apply edits'
            };
        } catch (error) {
            return {
                path,
                success: false,
                appliedEdits: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Open a file in VS Code editor
     */
    async openFile(payload: OpenFilePayload): Promise<OpenResultResponse> {
        const { path, line, column, preview = false } = payload;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path,
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            // Open the document
            const document = await vscode.workspace.openTextDocument(fileUri);
            
            // Show in editor
            const editor = await vscode.window.showTextDocument(document, {
                preview,
                preserveFocus: false
            });

            // Navigate to line/column if specified
            if (line !== undefined) {
                const lineNum = Math.max(0, line - 1);
                const colNum = column !== undefined ? Math.max(0, column - 1) : 0;
                
                const position = new vscode.Position(lineNum, colNum);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(
                    new vscode.Range(position, position),
                    vscode.TextEditorRevealType.InCenter
                );
            }

            return {
                path,
                success: true
            };
        } catch (error) {
            return {
                path,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Delete a file
     */
    async deleteFile(path: string): Promise<WriteResultResponse> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path,
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const fileUri = vscode.Uri.joinPath(workspaceRoot, path);

            await vscode.workspace.fs.delete(fileUri, { recursive: false });

            return {
                path,
                success: true
            };
        } catch (error) {
            return {
                path,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Rename/move a file
     */
    async renameFile(oldPath: string, newPath: string): Promise<WriteResultResponse> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return {
                    path: oldPath,
                    success: false,
                    error: 'No workspace folder open'
                };
            }

            const workspaceRoot = workspaceFolders[0].uri;
            const oldUri = vscode.Uri.joinPath(workspaceRoot, oldPath);
            const newUri = vscode.Uri.joinPath(workspaceRoot, newPath);

            await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });

            return {
                path: newPath,
                success: true
            };
        } catch (error) {
            return {
                path: oldPath,
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
