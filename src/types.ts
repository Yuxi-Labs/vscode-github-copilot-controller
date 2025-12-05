/**
 * Message types for client-controller communication
 */

// ============ Client → Controller Messages ============

export interface ClientMessage {
    id: string;
    type: ClientMessageType;
    payload: unknown;
}

export type ClientMessageType = 
    | 'chat'
    | 'cancel'
    | 'ping'
    | 'models'
    | 'context'
    | 'files'      // List files in a directory
    | 'readFile'   // Read file content
    | 'writeFile'  // Write/create file
    | 'editFile'   // Apply edits to a file
    | 'openFile'   // Open file in VS Code editor
    | 'terminal'   // Execute terminal command
    | 'terminalKill';  // Kill a running terminal

export interface ChatPayload {
    message: string;
    model?: string;
    includeContext?: boolean;  // Include active file context
}

export interface CancelPayload {
    requestId: string;
}

// ============ Workspace Context ============

export interface WorkspaceContext {
    activeFile?: ActiveFileContext;
    workspaceFolders?: string[];
    openFiles?: string[];
}

export interface ActiveFileContext {
    path: string;
    fileName: string;
    language: string;
    content: string;
    selection?: {
        startLine: number;
        endLine: number;
        text: string;
    };
}

// ============ Controller → Client Messages ============

export interface ControllerMessage {
    id: string;
    type: ControllerMessageType;
    payload: unknown;
}

export type ControllerMessageType =
    | 'chunk'
    | 'done'
    | 'error'
    | 'pong'
    | 'status'
    | 'models'
    | 'context'
    | 'files'        // File listing response
    | 'fileContent'  // File content response
    | 'writeResult'  // Write file result
    | 'editResult'   // Edit file result
    | 'openResult'   // Open file result
    | 'terminalOutput'  // Terminal output (streaming)
    | 'terminalExit';   // Terminal command completed

export interface ChunkPayload {
    requestId: string;
    content: string;
    index: number;
}

export interface DonePayload {
    requestId: string;
    fullContent: string;
}

export interface ErrorPayload {
    requestId?: string;
    code: string;
    message: string;
}

export interface StatusPayload {
    connected: boolean;
    copilotAvailable: boolean;
    activeRequests: number;
    uptime: number;
}

// ============ File Browser Types ============

export interface FilesPayload {
    path?: string;  // Path to list, empty = workspace root
}

export interface ReadFilePayload {
    path: string;  // Relative path from workspace root
}

export interface FileEntry {
    name: string;
    path: string;  // Relative path from workspace
    type: 'file' | 'directory';
    size?: number;
    language?: string;  // For files
}

export interface FilesResponse {
    path: string;
    entries: FileEntry[];
    workspaceName: string;
}

export interface FileContentResponse {
    path: string;
    fileName: string;
    content: string;
    language: string;
    size: number;
}

// ============ File Editing Types ============

export interface WriteFilePayload {
    path: string;           // Relative path from workspace root
    content: string;        // Full file content
    createDirs?: boolean;   // Create parent directories if needed
}

export interface EditFilePayload {
    path: string;           // Relative path from workspace root
    edits: FileEdit[];      // Array of edits to apply
}

export interface FileEdit {
    startLine: number;      // 1-based line number
    endLine: number;        // 1-based line number (inclusive)
    newText: string;        // Text to replace with
}

export interface OpenFilePayload {
    path: string;           // Relative path from workspace root
    line?: number;          // Optional line to navigate to
    column?: number;        // Optional column to navigate to
    preview?: boolean;      // Open in preview mode (default: false)
}

export interface WriteResultResponse {
    path: string;
    success: boolean;
    error?: string;
}

export interface EditResultResponse {
    path: string;
    success: boolean;
    appliedEdits: number;
    error?: string;
}

export interface OpenResultResponse {
    path: string;
    success: boolean;
    error?: string;
}

// ============ Terminal Types ============

export interface TerminalPayload {
    command: string;
    cwd?: string;           // Working directory (relative to workspace)
    env?: Record<string, string>;  // Environment variables
    shell?: string;         // Shell to use (e.g., 'powershell', 'bash')
}

export interface TerminalKillPayload {
    terminalId: string;
}

export interface TerminalOutputResponse {
    terminalId: string;
    output: string;
    isError: boolean;       // stderr vs stdout
}

export interface TerminalExitResponse {
    terminalId: string;
    exitCode: number | undefined;
    success: boolean;
}

// ============ Authentication ============

export interface AuthMessage {
    type: 'auth';
    token: string;
}

export interface AuthResponse {
    type: 'auth_result';
    success: boolean;
    error?: string;
}

// ============ Internal Types ============

export interface PendingRequest {
    id: string;
    startTime: number;
    cancellationToken: { cancel: () => void };
    chunks: string[];
}

export interface ClientConnection {
    id: string;
    authenticated: boolean;
    connectedAt: number;
    lastActivity: number;
}
