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
    | 'auth'           // Legacy auth with token
    | 'pairRequest'    // Request device pairing
    | 'chat'
    | 'cancel'
    | 'ping'
    | 'setBatteryMode'    // Update battery mode for adaptive behavior
    | 'setBandwidthMode'  // Update bandwidth mode for optimization
    | 'getQualityMetrics' // Request connection quality metrics
    | 'models'
    | 'context'
    | 'files'      // List files in a directory
    | 'readFile'   // Read file content
    | 'writeFile'  // Write/create file
    | 'editFile'   // Apply edits to a file
    | 'openFile'   // Open file in VS Code editor
    | 'approveChange'  // Approve a pending file change
    | 'rejectChange'   // Reject a pending file change
    | 'batchApprove'   // Approve multiple changes
    | 'batchReject'    // Reject multiple changes
    | 'terminal'       // Execute terminal command (legacy)
    | 'terminalSpawn'  // Spawn interactive shell
    | 'terminalInput'  // Send input to terminal
    | 'terminalResize' // Resize terminal
    | 'terminalKill';  // Kill a running terminal

// Chat modes
export type ChatMode = 'agent' | 'ask' | 'edit' | 'plan';

export interface ChatPayload {
    message: string;
    model?: string;
    mode?: ChatMode;           // Chat mode (agent, ask, edit, plan)
    includeContext?: boolean;  // Include active file context
    targetFile?: string;       // For edit mode - file to edit
    selection?: {              // For edit mode - selection to edit
        startLine: number;
        endLine: number;
        text: string;
    };
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
    | 'authRequired'    // Auth token required
    | 'authSuccess'     // Legacy auth succeeded
    | 'pairPending'     // Pairing request pending approval
    | 'pairApproved'    // Pairing approved, session token issued
    | 'pairRejected'    // Pairing rejected by user
    | 'chunk'
    | 'done'
    | 'error'
    | 'toolCall'        // Tool call progress update
    | 'pendingChange'   // File change awaiting approval
    | 'changeApproved'  // Change successfully applied
    | 'changeRejected'  // Change rejected
    | 'pong'
    | 'batteryModeSet'     // Battery mode updated
    | 'bandwidthModeSet'   // Bandwidth mode updated
    | 'qualityMetrics'     // Connection quality metrics
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

export interface ToolCallPayload {
    requestId: string;
    toolCall: {
        id: string;
        type: 'file_read' | 'file_write' | 'file_edit' | 'terminal' | 'search' | 'thinking';
        status: 'pending' | 'running' | 'success' | 'error';
        description: string;
        details?: string;
        timestamp: number;
    };
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

// Legacy command execution
export interface TerminalPayload {
    command: string;
    cwd?: string;           // Working directory (relative to workspace)
    env?: Record<string, string>;  // Environment variables
    shell?: string;         // Shell to use (e.g., 'powershell', 'bash')
}

// Spawn an interactive shell
export interface TerminalSpawnPayload {
    terminalId: string;     // Client-assigned terminal ID
    cwd?: string;           // Working directory (relative to workspace)
    shell?: string;         // Shell to use (e.g., 'powershell', 'bash')
    cols?: number;          // Terminal columns
    rows?: number;          // Terminal rows
}

// Send input to terminal
export interface TerminalInputPayload {
    terminalId: string;
    data: string;           // Raw input data (including escape sequences)
}

// Resize terminal
export interface TerminalResizePayload {
    terminalId: string;
    cols: number;
    rows: number;
}

export interface TerminalKillPayload {
    terminalId: string;
}

export interface TerminalOutputResponse {
    terminalId: string;
    output: string;
    shellType?: string;     // Type of shell (pwsh, powershell, bash, cmd, etc)
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

// ============ Device Pairing ============

export interface PairRequestPayload {
    deviceName: string;      // User-friendly device name (e.g., "John's Laptop")
    deviceId: string;        // Unique device identifier
    clientVersion?: string;  // Client app version
}

export interface PairPendingResponse {
    pairingId: string;       // ID to track this pairing request
    status: 'pending';
    message: string;
}

export interface PairApprovedResponse {
    pairingId: string;
    status: 'approved';
    sessionToken: string;    // Permanent session token for this device
    deviceId: string;
}

export interface PairRejectedResponse {
    pairingId: string;
    status: 'rejected';
    reason: string;
}

export interface DeviceSession {
    deviceId: string;
    deviceName: string;
    sessionToken: string;
    createdAt: number;
    lastUsed: number;
}

// ============ Change Approval Types ============

export interface PendingChangePayload {
    changeId: string;
    changeType: 'edit' | 'write';
    path: string;
    diff: string;
    additions: number;
    deletions: number;
    timestamp: number;
}

export interface ApproveChangePayload {
    changeId: string;
}

export interface RejectChangePayload {
    changeId: string;
}

export interface BatchApprovePayload {
    changeIds: string[];
}

export interface BatchRejectPayload {
    changeIds: string[];
}

export interface ChangeApprovedPayload {
    changeId: string;
    path: string;
    success: boolean;
    error?: string;
}

export interface ChangeRejectedPayload {
    changeId: string;
    path: string;
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
    sessionToken?: string;   // Session token if using device pairing
    deviceId?: string;       // Device ID if using device pairing
    deviceName?: string;     // Device name if using device pairing
    connectedAt: number;
    lastActivity: number;
    bytesSent: number;       // Total bytes sent to client
    bytesReceived: number;   // Total bytes received from client
    messagesSent: number;    // Total messages sent to client
    messagesReceived: number; // Total messages received from client
    rateLimitTokens: number; // Token bucket for rate limiting
    rateLimitLastRefill: number; // Last time tokens were refilled
    messageQueue: ControllerMessage[]; // Queued messages when client offline
    // Connection quality metrics
    latency: number;         // Average round-trip latency in ms
    latencySamples: number[]; // Recent latency samples for averaging
    lastPingTime: number;    // When last ping was sent
    packetLoss: number;      // Packet loss percentage (0-100)
    pongReceived: number;    // Total pongs received
    pongExpected: number;    // Total pongs expected
    // Mobile optimization
    batteryMode: 'normal' | 'low' | 'critical'; // Battery-aware mode
    bandwidthMode: 'normal' | 'low';  // Bandwidth mode
    compressionLevel: number; // Dynamic compression level (0-9)
}
