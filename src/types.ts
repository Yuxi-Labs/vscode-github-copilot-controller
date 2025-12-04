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
    | 'models';

export interface ChatPayload {
    message: string;
    model?: string;
}

export interface CancelPayload {
    requestId: string;
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
    | 'models';

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
