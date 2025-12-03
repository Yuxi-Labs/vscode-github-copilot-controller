import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as vscode from 'vscode';
import { CopilotBridge } from './copilot-bridge';
import {
    ClientMessage,
    ControllerMessage,
    AuthMessage,
    AuthResponse,
    ChatPayload,
    CancelPayload,
    StatusPayload,
    ClientConnection
} from './types';

/**
 * Main controller that handles WebSocket and SSE connections for remote Copilot access
 */
export class Controller {
    private httpListener: http.Server | null = null;
    private wsHandler: WebSocketServer | null = null;
    private bridge: CopilotBridge;
    private connections: Map<string, ClientConnection> = new Map();
    private wsClients: Map<string, WebSocket> = new Map();
    private sseClients: Map<string, http.ServerResponse> = new Map();
    private startTime: number = 0;
    private outputChannel: vscode.OutputChannel;

    private port: number;
    private authToken: string;
    private allowedOrigins: string[];

    constructor(
        private context: vscode.ExtensionContext
    ) {
        this.bridge = new CopilotBridge();
        this.outputChannel = vscode.window.createOutputChannel('Copilot Controller');
        
        // Load config
        const config = vscode.workspace.getConfiguration('copilotController');
        this.port = config.get('port', 3712);
        this.allowedOrigins = config.get('allowedOrigins', ['*']);
        
        // Get or generate auth token
        this.authToken = config.get('authToken', '') || this.getOrCreateToken();
    }

    private getOrCreateToken(): string {
        let token = this.context.globalState.get<string>('authToken');
        if (!token) {
            token = crypto.randomBytes(32).toString('hex');
            this.context.globalState.update('authToken', token);
            
            vscode.workspace.getConfiguration('copilotController')
                .update('authToken', token, vscode.ConfigurationTarget.Global);
        }
        return token;
    }

    /**
     * Start the controller
     */
    async start(): Promise<void> {
        if (this.httpListener) {
            this.log('Controller already running');
            return;
        }

        this.startTime = Date.now();

        // Create HTTP listener for SSE and health checks
        this.httpListener = http.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });

        // Create WebSocket handler
        this.wsHandler = new WebSocketServer({ server: this.httpListener });
        this.wsHandler.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
            this.handleWebSocketConnection(ws, req);
        });

        // Start listening
        return new Promise((resolve, reject) => {
            this.httpListener!.listen(this.port, () => {
                this.log(`Controller started on port ${this.port}`);
                this.log(`Auth token: ${this.authToken.substring(0, 8)}...`);
                vscode.window.showInformationMessage(
                    `Copilot Controller running on port ${this.port}`
                );
                resolve();
            });

            this.httpListener!.on('error', (err) => {
                this.log(`Controller error: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Stop the controller
     */
    async stop(): Promise<void> {
        if (!this.httpListener) {
            return;
        }

        // Close all connections
        for (const ws of this.wsClients.values()) {
            ws.close(1000, 'Controller shutting down');
        }
        for (const res of this.sseClients.values()) {
            res.end();
        }

        this.wsClients.clear();
        this.sseClients.clear();
        this.connections.clear();

        this.wsHandler?.close();
        this.wsHandler = null;

        return new Promise((resolve) => {
            this.httpListener!.close(() => {
                this.httpListener = null;
                this.log('Controller stopped');
                vscode.window.showInformationMessage('Copilot Controller stopped');
                resolve();
            });
        });
    }

    /**
     * Check if controller is running
     */
    isRunning(): boolean {
        return this.httpListener !== null;
    }

    /**
     * Get connection info for clients
     */
    getConnectionInfo(): { 
        local: string; 
        tunnel?: string; 
        token: string;
        wsPath: string;
        ssePath: string;
    } {
        const config = vscode.workspace.getConfiguration('copilotController');
        const tunnelUrl = config.get<string>('tunnelUrl', '');
        
        return {
            local: `http://localhost:${this.port}`,
            tunnel: tunnelUrl || undefined,
            token: this.authToken,
            wsPath: '/ws',
            ssePath: '/sse'
        };
    }

    // ============ HTTP Handling ============

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        
        this.setCorsHeaders(req, res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        switch (url.pathname) {
            case '/':
            case '/health':
                this.handleHealth(req, res);
                break;
            case '/sse':
                this.handleSSE(req, res);
                break;
            case '/message':
                this.handleMessage(req, res);
                break;
            case '/status':
                this.handleStatus(req, res);
                break;
            default:
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    private setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
        const origin = req.headers.origin || '*';
        
        if (this.allowedOrigins.includes('*') || this.allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    private handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok',
            uptime: Math.floor((Date.now() - this.startTime) / 1000)
        }));
    }

    private async handleStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this.verifyAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        const bridgeStatus = this.bridge.getStatus();
        const copilotAvailable = await this.bridge.isCopilotAvailable();

        const status: StatusPayload = {
            connected: true,
            copilotAvailable,
            activeRequests: bridgeStatus.activeRequests,
            uptime: Math.floor((Date.now() - this.startTime) / 1000)
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
    }

    // ============ SSE Handling ============

    private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (!this.verifyAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        const clientId = crypto.randomUUID();
        
        this.log(`SSE client connected: ${clientId}`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        this.connections.set(clientId, {
            id: clientId,
            authenticated: true,
            connectedAt: Date.now(),
            lastActivity: Date.now()
        });
        this.sseClients.set(clientId, res);

        this.sendSSE(res, 'connected', { clientId });

        const keepAlive = setInterval(() => {
            if (!res.writable) {
                clearInterval(keepAlive);
                return;
            }
            res.write(': keepalive\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            this.connections.delete(clientId);
            this.sseClients.delete(clientId);
            this.log(`SSE client disconnected: ${clientId}`);
        });
    }

    private sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
        if (!res.writable) {
            return;
        }
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    // ============ Message Handling (for SSE clients) ============

    private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        if (!this.verifyAuth(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body = '';
        for await (const chunk of req) {
            body += chunk;
        }

        try {
            const message: ClientMessage = JSON.parse(body);
            const clientId = this.getClientIdFromAuth(req);
            const sseRes = clientId ? this.sseClients.get(clientId) : null;

            await this.processClientMessage(message, clientId || 'http', (ctrlMsg) => {
                if (sseRes) {
                    this.sendSSE(sseRes, ctrlMsg.type, ctrlMsg);
                }
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, id: message.id }));

        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    }

    // ============ WebSocket Handling ============

    private handleWebSocketConnection(ws: WebSocket, _req: http.IncomingMessage): void {
        const clientId = crypto.randomUUID();
        let authenticated = false;

        this.log(`WebSocket client connecting: ${clientId}`);

        const authTimeout = setTimeout(() => {
            if (!authenticated) {
                ws.close(4001, 'Authentication timeout');
            }
        }, 10000);

        ws.on('message', async (data: RawData) => {
            try {
                const message = JSON.parse(data.toString());

                if (!authenticated) {
                    if (message.type === 'auth') {
                        const authMsg = message as AuthMessage;
                        if (authMsg.token === this.authToken) {
                            authenticated = true;
                            clearTimeout(authTimeout);

                            this.connections.set(clientId, {
                                id: clientId,
                                authenticated: true,
                                connectedAt: Date.now(),
                                lastActivity: Date.now()
                            });
                            this.wsClients.set(clientId, ws);

                            const response: AuthResponse = {
                                type: 'auth_result',
                                success: true
                            };
                            ws.send(JSON.stringify(response));
                            this.log(`WebSocket client authenticated: ${clientId}`);
                        } else {
                            const response: AuthResponse = {
                                type: 'auth_result',
                                success: false,
                                error: 'Invalid token'
                            };
                            ws.send(JSON.stringify(response));
                            ws.close(4003, 'Invalid token');
                        }
                    } else {
                        ws.close(4002, 'Authentication required');
                    }
                    return;
                }

                const conn = this.connections.get(clientId);
                if (conn) {
                    conn.lastActivity = Date.now();
                }

                await this.processClientMessage(message as ClientMessage, clientId, (ctrlMsg) => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(ctrlMsg));
                    }
                });

            } catch (err) {
                this.log(`Error processing message: ${err}`);
            }
        });

        ws.on('close', () => {
            clearTimeout(authTimeout);
            this.connections.delete(clientId);
            this.wsClients.delete(clientId);
            this.log(`WebSocket client disconnected: ${clientId}`);
        });

        ws.on('error', (err: Error) => {
            this.log(`WebSocket error for ${clientId}: ${err.message}`);
        });
    }

    // ============ Message Processing ============

    private async processClientMessage(
        message: ClientMessage, 
        _clientId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        switch (message.type) {
            case 'chat':
                await this.handleChat(message.id, message.payload as ChatPayload, send);
                break;

            case 'cancel':
                this.handleCancel(message.id, message.payload as CancelPayload, send);
                break;

            case 'ping':
                send({
                    id: message.id,
                    type: 'pong',
                    payload: { timestamp: Date.now() }
                });
                break;

            default:
                send({
                    id: message.id,
                    type: 'error',
                    payload: { code: 'UNKNOWN_TYPE', message: 'Unknown message type' }
                });
        }
    }

    private async handleChat(
        requestId: string, 
        payload: ChatPayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        this.log(`Chat request ${requestId}: ${payload.message.substring(0, 50)}...`);

        await this.bridge.sendMessage(
            requestId,
            payload,
            (chunk) => {
                send({
                    id: requestId,
                    type: 'chunk',
                    payload: chunk
                });
            },
            (done) => {
                send({
                    id: requestId,
                    type: 'done',
                    payload: done
                });
                this.log(`Chat request ${requestId} completed`);
            },
            (error) => {
                send({
                    id: requestId,
                    type: 'error',
                    payload: error
                });
                this.log(`Chat request ${requestId} error: ${error.message}`);
            }
        );
    }

    private handleCancel(
        messageId: string,
        payload: CancelPayload,
        send: (msg: ControllerMessage) => void
    ): void {
        const cancelled = this.bridge.cancelRequest(payload.requestId);
        send({
            id: messageId,
            type: cancelled ? 'done' : 'error',
            payload: cancelled 
                ? { requestId: payload.requestId, cancelled: true }
                : { code: 'NOT_FOUND', message: 'Request not found' }
        });
    }

    // ============ Auth Helpers ============

    private verifyAuth(req: http.IncomingMessage): boolean {
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (token === this.authToken) {
                return true;
            }
        }

        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        const tokenParam = url.searchParams.get('token');
        if (tokenParam === this.authToken) {
            return true;
        }

        return false;
    }

    private getClientIdFromAuth(req: http.IncomingMessage): string | undefined {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        return url.searchParams.get('clientId') || undefined;
    }

    // ============ Utilities ============

    private log(message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }
}
