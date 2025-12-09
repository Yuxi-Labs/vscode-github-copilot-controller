import * as vscode from 'vscode';
import * as path from 'path';
import { FileEntry, FilesResponse, FileContentResponse } from './types';

/**
 * Handles file browsing operations for remote clients
 */
export class FileBrowser {
    private static instance: FileBrowser;

    private constructor() {}

    static getInstance(): FileBrowser {
        if (!FileBrowser.instance) {
            FileBrowser.instance = new FileBrowser();
        }
        return FileBrowser.instance;
    }

    /**
     * Get the primary workspace folder
     */
    private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0];
    }

    /**
     * List files in a directory
     */
    async listFiles(relativePath?: string): Promise<FilesResponse> {
        const workspaceFolder = this.getWorkspaceFolder();
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const basePath = workspaceFolder.uri;
        const targetPath = relativePath 
            ? vscode.Uri.joinPath(basePath, relativePath)
            : basePath;

        const entries: FileEntry[] = [];

        try {
            const dirEntries = await vscode.workspace.fs.readDirectory(targetPath);

            for (const [name, type] of dirEntries) {
                // Skip hidden files and common non-essential directories
                if (name.startsWith('.') || 
                    name === 'node_modules' || 
                    name === '__pycache__' ||
                    name === 'target' ||
                    name === 'dist' ||
                    name === 'build') {
                    continue;
                }

                const entryRelativePath = relativePath 
                    ? path.posix.join(relativePath, name)
                    : name;

                const entry: FileEntry = {
                    name,
                    path: entryRelativePath,
                    type: type === vscode.FileType.Directory ? 'directory' : 'file'
                };

                // Get file info for files
                if (type === vscode.FileType.File) {
                    try {
                        const fileUri = vscode.Uri.joinPath(targetPath, name);
                        const stat = await vscode.workspace.fs.stat(fileUri);
                        entry.size = stat.size;
                        entry.language = this.getLanguageFromFileName(name);
                    } catch {
                        // Ignore stat errors
                    }
                }

                entries.push(entry);
            }

            // Sort: directories first, then files, alphabetically
            entries.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'directory' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

        } catch (err) {
            throw new Error(`Failed to list directory: ${err}`);
        }

        return {
            path: relativePath || '',
            entries,
            workspaceName: workspaceFolder.name,
            workspaceId: workspaceFolder.uri.fsPath,
            workspaceUri: workspaceFolder.uri.toString()
        };
    }

    /**
     * Read file content
     */
    async readFile(relativePath: string): Promise<FileContentResponse> {
        const workspaceFolder = this.getWorkspaceFolder();
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);

        try {
            const stat = await vscode.workspace.fs.stat(fileUri);
            
            // Limit file size to 1MB
            if (stat.size > 1024 * 1024) {
                throw new Error('File too large (max 1MB)');
            }

            const contentBytes = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(contentBytes);
            const fileName = path.basename(relativePath);

            return {
                path: relativePath,
                fileName,
                content,
                language: this.getLanguageFromFileName(fileName),
                size: stat.size
            };
        } catch (err) {
            if (err instanceof Error && err.message.includes('File too large')) {
                throw err;
            }
            throw new Error(`Failed to read file: ${err}`);
        }
    }

    /**
     * Guess language from file extension
     */
    private getLanguageFromFileName(fileName: string): string {
        const ext = path.extname(fileName).toLowerCase();
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescriptreact',
            '.js': 'javascript',
            '.jsx': 'javascriptreact',
            '.py': 'python',
            '.rs': 'rust',
            '.go': 'go',
            '.java': 'java',
            '.c': 'c',
            '.cpp': 'cpp',
            '.h': 'c',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.rb': 'ruby',
            '.php': 'php',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'scss',
            '.less': 'less',
            '.json': 'json',
            '.xml': 'xml',
            '.yaml': 'yaml',
            '.yml': 'yaml',
            '.md': 'markdown',
            '.sh': 'shellscript',
            '.bash': 'shellscript',
            '.zsh': 'shellscript',
            '.ps1': 'powershell',
            '.sql': 'sql',
            '.toml': 'toml',
            '.ini': 'ini',
            '.cfg': 'ini',
            '.env': 'dotenv',
        };
        return languageMap[ext] || 'plaintext';
    }
}
