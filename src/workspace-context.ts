import * as vscode from 'vscode';
import { WorkspaceContext, ActiveFileContext } from './types';

/**
 * Reads workspace context from VS Code for inclusion in chat messages
 */
export class WorkspaceContextReader {
    private static instance: WorkspaceContextReader;

    private constructor() {}

    static getInstance(): WorkspaceContextReader {
        if (!WorkspaceContextReader.instance) {
            WorkspaceContextReader.instance = new WorkspaceContextReader();
        }
        return WorkspaceContextReader.instance;
    }

    /**
     * Get the current workspace context
     */
    async getContext(): Promise<WorkspaceContext> {
        const context: WorkspaceContext = {};

        // Get active file
        context.activeFile = await this.getActiveFile();

        // Get workspace folders
        context.workspaceFolders = this.getWorkspaceFolders();

        // Get open files
        context.openFiles = this.getOpenFiles();

        return context;
    }

    /**
     * Get active file context including content and selection
     */
    async getActiveFile(): Promise<ActiveFileContext | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return undefined;
        }

        const document = editor.document;
        const selection = editor.selection;

        const activeFile: ActiveFileContext = {
            path: document.uri.fsPath,
            fileName: document.fileName.split(/[\\/]/).pop() || document.fileName,
            language: document.languageId,
            content: document.getText()
        };

        // Include selection if there is one
        if (!selection.isEmpty) {
            activeFile.selection = {
                startLine: selection.start.line + 1,
                endLine: selection.end.line + 1,
                text: document.getText(selection)
            };
        }

        return activeFile;
    }

    /**
     * Get list of workspace folder names
     */
    getWorkspaceFolders(): string[] {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return [];
        }
        return folders.map(f => f.name);
    }

    /**
     * Get list of open file paths
     */
    getOpenFiles(): string[] {
        // Get all open text documents
        return vscode.workspace.textDocuments
            .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file')
            .map(doc => {
                // Return relative path if in workspace, otherwise just filename
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
                if (workspaceFolder) {
                    return vscode.workspace.asRelativePath(doc.uri);
                }
                return doc.fileName.split(/[\\/]/).pop() || doc.fileName;
            });
    }

    /**
     * Format context for inclusion in a chat message
     */
    formatContextForChat(context: WorkspaceContext): string {
        const parts: string[] = [];

        if (context.activeFile) {
            const file = context.activeFile;
            parts.push(`[Currently viewing: ${file.fileName}]`);
            
            if (file.selection) {
                parts.push(`[Selected lines ${file.selection.startLine}-${file.selection.endLine}]`);
                parts.push('```' + file.language);
                parts.push(file.selection.text);
                parts.push('```');
            } else {
                parts.push('```' + file.language);
                parts.push(file.content);
                parts.push('```');
            }
        }

        if (context.workspaceFolders && context.workspaceFolders.length > 0) {
            parts.push(`[Workspace: ${context.workspaceFolders.join(', ')}]`);
        }

        if (context.openFiles && context.openFiles.length > 1) {
            parts.push(`[Also open: ${context.openFiles.filter(f => f !== context.activeFile?.fileName).join(', ')}]`);
        }

        return parts.join('\n');
    }
}
