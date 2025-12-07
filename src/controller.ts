import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import * as vscode from 'vscode';
import { CopilotBridge } from './copilot-bridge';
import { ModelTracker } from './model-tracker';
import { WorkspaceContextReader } from './workspace-context';
import { FileBrowser } from './file-browser';
import { FileEditor } from './file-editor';
import { TerminalManager } from './terminal-manager';
import { SessionManager } from './session-manager';
import {
    ClientMessage,
    ControllerMessage,
    AuthMessage,
    AuthResponse,
    ChatPayload,
    CancelPayload,
    StatusPayload,
    ClientConnection,
    FilesPayload,
    ReadFilePayload,
    WriteFilePayload,
    EditFilePayload,
    OpenFilePayload,
    TerminalPayload,
    TerminalSpawnPayload,
    TerminalInputPayload,
    TerminalResizePayload,
    TerminalKillPayload
} from './types';

/**
 * Main controller that handles WebSocket and SSE connections for remote Copilot access
 */
export class Controller {
    private httpListener: http.Server | null = null;
    private wsHandler: WebSocketServer | null = null;
    private bridge: CopilotBridge;
    private contextReader: WorkspaceContextReader;
    private fileBrowser: FileBrowser;
    private fileEditor: FileEditor;
    private terminalManager: TerminalManager;
    private sessionManager: SessionManager;
    private connections: Map<string, ClientConnection> = new Map();
    private wsClients: Map<string, WebSocket> = new Map();
    private sseClients: Map<string, http.ServerResponse> = new Map();
    private pingIntervals: Map<string, NodeJS.Timeout> = new Map();
    private startTime: number = 0;
    private outputChannel: vscode.OutputChannel;
    private connectionChangeEmitter = new vscode.EventEmitter<number>();
    public readonly onConnectionCountChange = this.connectionChangeEmitter.event;

    private port: number;
    private authToken: string;
    private allowedOrigins: string[];
    private logLevel: 'error' | 'warn' | 'info' | 'debug';
    private rateLimitEnabled: boolean;
    private rateLimitMax: number;
    private rateLimitWindow: number;
    private maxQueueSize: number;
    private ipAllowlist: string[];
    private ipBlocklist: string[];
    private encryptionEnabled: boolean;
    private encryptionKey: string | null;

    constructor(
        private context: vscode.ExtensionContext
    ) {
        this.bridge = new CopilotBridge();
        this.contextReader = WorkspaceContextReader.getInstance();
        this.fileBrowser = FileBrowser.getInstance();
        this.fileEditor = new FileEditor();
        this.terminalManager = TerminalManager.getInstance();
        this.sessionManager = new SessionManager(context);
        this.outputChannel = vscode.window.createOutputChannel('Controller for GitHub Copilot');
        
        // Share output channel with terminal manager for unified logging
        this.terminalManager.setOutputChannel(this.outputChannel);
        
        // Load config
        const config = vscode.workspace.getConfiguration('copilotController');
        this.port = config.get('port', 3712);
        this.allowedOrigins = config.get('allowedOrigins', ['*']);
        this.logLevel = config.get('logLevel', 'info') as 'error' | 'warn' | 'info' | 'debug';
        this.maxQueueSize = config.get('maxQueueSize', 100);
        this.ipAllowlist = config.get('ipAllowlist', []);
        this.ipBlocklist = config.get('ipBlocklist', []);
        
        const encryption = config.get('encryption', { enabled: false, key: null }) as any;
        this.encryptionEnabled = encryption.enabled ?? false;
        this.encryptionKey = encryption.key || null;
        
        if (this.encryptionEnabled && !this.encryptionKey) {
            this.logWarn('Encryption enabled but no key provided, disabling encryption');
            this.encryptionEnabled = false;
        }
        
        const rateLimit = config.get('rateLimit', { enabled: true, maxRequests: 60, windowSeconds: 60 }) as any;
        this.rateLimitEnabled = rateLimit.enabled ?? true;
        this.rateLimitMax = rateLimit.maxRequests ?? 60;
        this.rateLimitWindow = rateLimit.windowSeconds ?? 60;
        
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

        // Create WebSocket handler with compression
        this.wsHandler = new WebSocketServer({ 
            server: this.httpListener,
            perMessageDeflate: {
                zlibDeflateOptions: {
                    chunkSize: 1024,
                    memLevel: 7,
                    level: 3
                },
                zlibInflateOptions: {
                    chunkSize: 10 * 1024
                },
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
                serverMaxWindowBits: 10,
                concurrencyLimit: 10,
                threshold: 1024
            },
            // Allow connections from Cloudflare and other reverse proxies
            verifyClient: (info: { origin: string; secure: boolean; req: http.IncomingMessage }) => {
                // Log connection attempt for debugging
                const origin = info.req.headers.origin || 'unknown';
                const forwarded = info.req.headers['x-forwarded-for'] || info.req.socket.remoteAddress;
                this.logDebug(`WebSocket connection attempt from: ${forwarded} (origin: ${origin})`);
                
                // Check IP filtering
                const ipCheck = this.isIpAllowed(info.req);
                if (!ipCheck.allowed) {
                    this.logWarn(`Rejected WebSocket from ${forwarded}: ${ipCheck.reason}`);
                    return false;
                }
                
                return true;
            }
        });
        this.wsHandler.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
            this.handleWebSocketConnection(ws, req);
        });

        // Start listening
        return new Promise((resolve, reject) => {
            this.httpListener!.listen(this.port, () => {
                this.log(`Controller started on port ${this.port}`);
                this.log(`Auth token: ${this.authToken.substring(0, 8)}...`);
                vscode.window.showInformationMessage(
                    `Controller for GitHub Copilot running on port ${this.port}`
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
        encryption?: { enabled: boolean; keyLength?: number };
    } {
        const config = vscode.workspace.getConfiguration('copilotController');
        const tunnelUrl = config.get<string>('tunnelUrl', '');
        
        return {
            local: `http://localhost:${this.port}`,
            tunnel: tunnelUrl || undefined,
            token: this.authToken,
            wsPath: '/ws',
            ssePath: '/sse',
            encryption: this.encryptionEnabled ? { 
                enabled: true, 
                keyLength: this.encryptionKey ? Buffer.from(this.encryptionKey, 'hex').length : 0 
            } : undefined
        };
    }

    /**
     * Get all connected devices
     */
    getConnectedDevices() {
        return this.sessionManager.getAllSessions();
    }

    /**
     * Get active connection count
     */
    getActiveConnectionCount(): number {
        return this.connections.size;
    }

    /**
     * Get all active connections
     */
    getActiveConnections(): ClientConnection[] {
        return Array.from(this.connections.values());
    }

    /**
     * Notify listeners of connection count change
     */
    private notifyConnectionChange(): void {
        this.connectionChangeEmitter.fire(this.connections.size);
    }

    /**
     * Track message received from client
     */
    private trackMessageReceived(clientId: string, messageBytes: number): void {
        const conn = this.connections.get(clientId);
        if (conn) {
            conn.bytesReceived += messageBytes;
            conn.messagesReceived++;
            conn.lastActivity = Date.now();
        }
    }

    /**
     * Track message sent to client
     */
    private trackMessageSent(clientId: string, messageBytes: number): void {
        const conn = this.connections.get(clientId);
        if (conn) {
            conn.bytesSent += messageBytes;
            conn.messagesSent++;
        }
    }

    /**
     * Queue a message for offline client
     */
    private queueMessage(clientId: string, message: ControllerMessage): void {
        const conn = this.connections.get(clientId);
        if (conn) {
            // Check queue size limit
            if (conn.messageQueue.length >= this.maxQueueSize) {
                // Drop oldest message (FIFO)
                conn.messageQueue.shift();
                this.logWarn(`Message queue full for ${clientId}, dropping oldest message`);
            }
            conn.messageQueue.push(message);
            this.logDebug(`Queued message for ${clientId}, queue size: ${conn.messageQueue.length}`);
        }
    }

    /**
     * Flush queued messages when client reconnects
     */
    private flushMessageQueue(clientId: string): void {
        const conn = this.connections.get(clientId);
        if (!conn || conn.messageQueue.length === 0) {
            return;
        }

        const ws = this.wsClients.get(clientId);
        const sse = this.sseClients.get(clientId);

        this.logInfo(`Flushing ${conn.messageQueue.length} queued messages for ${clientId}`);

        while (conn.messageQueue.length > 0) {
            const message = conn.messageQueue.shift()!;
            if (ws && ws.readyState === WebSocket.OPEN) {
                this.sendWebSocketMessage(clientId, ws, message);
            } else if (sse && sse.writable) {
                this.sendSSE(sse, message.type, message, clientId);
            } else {
                // Client disconnected again, put message back
                conn.messageQueue.unshift(message);
                break;
            }
        }
    }

    /**
     * Send JSON message via WebSocket and track stats
     */
    private sendWebSocketMessage(clientId: string, ws: WebSocket, message: unknown): void {
        let json = JSON.stringify(message);
        
        // Encrypt if encryption enabled and connection authenticated
        const conn = this.connections.get(clientId);
        if (conn?.authenticated && this.encryptionEnabled) {
            json = this.encryptPayload(json);
        }
        
        const bytes = Buffer.byteLength(json, 'utf8');
        ws.send(json);
        this.trackMessageSent(clientId, bytes);
    }

    /**
     * Revoke device access
     */
    async revokeDevice(deviceId: string): Promise<boolean> {
        // Revoke session
        const revoked = await this.sessionManager.revokeSession(deviceId);
        
        // Disconnect any active connections from this device
        for (const [clientId, connection] of this.connections.entries()) {
            if (connection.deviceId === deviceId) {
                const ws = this.wsClients.get(clientId);
                if (ws) {
                    ws.close(1000, 'Device access revoked');
                }
                this.connections.delete(clientId);
                this.wsClients.delete(clientId);
            }
        }
        
        if (revoked) {
            this.notifyConnectionChange();
        }
        
        return revoked;
    }

    // ============ HTTP Handling ============

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Check IP filtering first
        const ipCheck = this.isIpAllowed(req);
        if (!ipCheck.allowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: ipCheck.reason || 'Access denied' }));
            return;
        }

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
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Forwarded-For, X-Forwarded-Proto');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        
        // Support proxied connections (Cloudflare Tunnel, ngrok, etc.)
        if (req.headers['x-forwarded-proto'] === 'https') {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
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
        
        this.logInfo(`SSE client connected: ${clientId}`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        this.connections.set(clientId, {
            id: clientId,
            authenticated: true,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            bytesSent: 0,
            bytesReceived: 0,
            messagesSent: 0,
            messagesReceived: 0,
            rateLimitTokens: this.rateLimitMax,
            rateLimitLastRefill: Date.now(),
            messageQueue: [],
            // Quality metrics
            latency: 0,
            latencySamples: [],
            lastPingTime: 0,
            packetLoss: 0,
            pongReceived: 0,
            pongExpected: 0,
            // Mobile optimization
            batteryMode: 'normal',
            bandwidthMode: 'normal',
            compressionLevel: 3
        });
        this.sseClients.set(clientId, res);
        this.notifyConnectionChange();

        this.sendSSE(res, 'connected', { clientId }, clientId);
        
        // Flush any queued messages
        this.flushMessageQueue(clientId);

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
            this.notifyConnectionChange();
            this.logInfo(`SSE client disconnected: ${clientId}`);
        });
    }

    private sendSSE(res: http.ServerResponse, event: string, data: unknown, clientId?: string): void {
        if (!res.writable) {
            return;
        }
        const eventLine = `event: ${event}\n`;
        const dataLine = `data: ${JSON.stringify(data)}\n\n`;
        res.write(eventLine + dataLine);
        
        // Track stats if clientId provided
        if (clientId) {
            const bytes = Buffer.byteLength(eventLine + dataLine, 'utf8');
            this.trackMessageSent(clientId, bytes);
        }
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

        // Track received bytes for SSE client
        const bodyBytes = Buffer.byteLength(body, 'utf8');
        const clientId = this.getClientIdFromAuth(req);
        if (clientId) {
            this.trackMessageReceived(clientId, bodyBytes);
        }

        try {
            const message: ClientMessage = JSON.parse(body);
            const sseRes = clientId ? this.sseClients.get(clientId) : null;

            await this.processClientMessage(message, clientId || 'http', (ctrlMsg) => {
                if (sseRes && sseRes.writable) {
                    this.sendSSE(sseRes, ctrlMsg.type, ctrlMsg, clientId);
                } else if (clientId) {
                    // Client disconnected, queue message
                    this.queueMessage(clientId, ctrlMsg);
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
                this.log(`WebSocket auth timeout; closing ${clientId}`);
                ws.close(4001, 'Authentication timeout');
            }
        }, 10000);

        // Message queue to ensure sequential processing (prevents race conditions)
        const messageQueue: RawData[] = [];
        let processing = false;

        const handleMessage = async (data: RawData) => {
            this.log(`handleMessage called, authenticated=${authenticated}`);
            try {
            let raw = data.toString();
            const rawBytes = Buffer.byteLength(raw, 'utf8');
            
            // Decrypt if encryption enabled (after auth)
            if (authenticated && this.encryptionEnabled) {
                raw = this.decryptPayload(raw);
            }
            
            this.log(`WebSocket message from ${clientId}: ${raw}`);
            const message = JSON.parse(raw);
            
            // Track received message
            this.trackMessageReceived(clientId, rawBytes);

                if (!authenticated) {
                    this.log(`Not authenticated yet, checking for auth message`);
                    if (message.type === 'auth') {
                        const authMsg = message as AuthMessage;
                        if (authMsg.token === this.authToken) {
                            authenticated = true;
                            clearTimeout(authTimeout);

                            this.connections.set(clientId, {
                                id: clientId,
                                authenticated: true,
                                connectedAt: Date.now(),
                                lastActivity: Date.now(),
                                bytesSent: 0,
                                bytesReceived: 0,
                                messagesSent: 0,
                                messagesReceived: 0,
                                rateLimitTokens: this.rateLimitMax,
                                rateLimitLastRefill: Date.now(),
                                messageQueue: [],
                                // Quality metrics
                                latency: 0,
                                latencySamples: [],
                                lastPingTime: 0,
                                packetLoss: 0,
                                pongReceived: 0,
                                pongExpected: 0,
                                // Mobile optimization
                                batteryMode: 'normal',
                                bandwidthMode: 'normal',
                                compressionLevel: 3
                            });
                            this.wsClients.set(clientId, ws);
                            this.notifyConnectionChange();

                            const response: AuthResponse = {
                                type: 'auth_result',
                                success: true
                            };
                            this.sendWebSocketMessage(clientId, ws, response);
                            this.logInfo(`WebSocket client authenticated: ${clientId}`);
                            
                            // Flush any queued messages
                            this.flushMessageQueue(clientId);
                            
                            // Start ping/pong health check
                            this.startPingPong(clientId, ws);
                        } else {
                            const response: AuthResponse = {
                                type: 'auth_result',
                                success: false,
                                error: 'Invalid token'
                            };
                            this.sendWebSocketMessage(clientId, ws, response);
                            this.logWarn(`WebSocket invalid token for ${clientId}`);
                            ws.close(4003, 'Invalid token');
                        }
                    } else {
                        this.log(`WebSocket ${clientId} sent non-auth before authentication: ${JSON.stringify(message)}`);
                        ws.close(4002, 'Authentication required');
                    }
                    return;
                }

                const conn = this.connections.get(clientId);
                if (conn) {
                    conn.lastActivity = Date.now();
                }

                this.log(`About to process message type: ${message.type}`);
                try {
                    await this.processClientMessage(message as ClientMessage, clientId, (ctrlMsg) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            this.sendWebSocketMessage(clientId, ws, ctrlMsg);
                        } else {
                            // Client disconnected, queue message
                            this.queueMessage(clientId, ctrlMsg);
                        }
                    });
                } catch (processError) {
                    this.logError(`Error in processClientMessage: ${processError}`);
                }

            } catch (err) {
                this.logError(`Error processing message: ${err}`);
            }
        };

        const processQueue = async () => {
            this.log(`processQueue called: processing=${processing}, queueLen=${messageQueue.length}`);
            if (processing || messageQueue.length === 0) {
                return;
            }
            processing = true;

            while (messageQueue.length > 0) {
                const data = messageQueue.shift()!;
                this.log(`About to call handleMessage`);
                await handleMessage(data);
                this.log(`handleMessage finished`);
            }

            processing = false;
        };

        ws.on('message', (data: RawData) => {
            this.log(`ws.on message event received`);
            messageQueue.push(data);
            void processQueue();
        });

        ws.on('close', (code: number, reason: Buffer) => {
            clearTimeout(authTimeout);
            this.stopPingPong(clientId);
            this.connections.delete(clientId);
            this.wsClients.delete(clientId);
            this.notifyConnectionChange();
            const reasonText = reason?.toString() || '';
            this.logInfo(`WebSocket client disconnected: ${clientId} code=${code} reason='${reasonText}'`);
        });

        ws.on('error', (err: Error) => {
            this.logError(`WebSocket error for ${clientId}: ${err.message}`);
        });

        // Handle pong responses
        ws.on('pong', () => {
            const conn = this.connections.get(clientId);
            if (conn && conn.lastPingTime > 0) {
                // Calculate latency
                const latency = Date.now() - conn.lastPingTime;
                conn.latencySamples.push(latency);
                
                // Keep only last 10 samples
                if (conn.latencySamples.length > 10) {
                    conn.latencySamples.shift();
                }
                
                // Update average latency
                conn.latency = Math.round(
                    conn.latencySamples.reduce((a, b) => a + b, 0) / conn.latencySamples.length
                );
                
                // Track pong received
                conn.pongReceived++;
                
                // Update packet loss percentage
                conn.packetLoss = Math.round(
                    ((conn.pongExpected - conn.pongReceived) / conn.pongExpected) * 100
                );
                
                conn.lastActivity = Date.now();
                this.logDebug(`Client ${clientId} latency: ${latency}ms (avg: ${conn.latency}ms, loss: ${conn.packetLoss}%)`);
            }
        });
    }

    /**
     * Start ping/pong health monitoring for a WebSocket
     */
    private startPingPong(clientId: string, ws: WebSocket): void {
        const conn = this.connections.get(clientId);
        if (!conn) {return;}
        
        // Battery-aware ping interval
        const getPingInterval = () => {
            switch (conn.batteryMode) {
                case 'low': return 60000;      // 60s for low battery
                case 'critical': return 120000; // 120s for critical battery
                default: return 30000;          // 30s normal
            }
        };
        
        const doPing = () => {
            if (ws.readyState === WebSocket.OPEN) {
                conn.lastPingTime = Date.now();
                conn.pongExpected++;
                ws.ping();
                this.logDebug(`Sent ping to ${clientId} (battery: ${conn.batteryMode})`);
                
                // Schedule next ping with current battery mode
                const interval = this.pingIntervals.get(clientId);
                if (interval) {
                    clearTimeout(interval);
                }
                this.pingIntervals.set(clientId, setTimeout(doPing, getPingInterval()) as any);
            } else {
                this.stopPingPong(clientId);
            }
        };
        
        // Start first ping
        doPing();
    }

    /**
     * Stop ping/pong for a client
     */
    private stopPingPong(clientId: string): void {
        const interval = this.pingIntervals.get(clientId);
        if (interval) {
            clearInterval(interval);
            this.pingIntervals.delete(clientId);
        }
    }

    // ============ Message Processing ============

    /**
     * Check rate limit for a client using token bucket algorithm
     */
    private checkRateLimit(clientId: string): boolean {
        if (!this.rateLimitEnabled) {
            return true;
        }

        const conn = this.connections.get(clientId);
        if (!conn) {
            return false;
        }

        const now = Date.now();
        const elapsed = (now - conn.rateLimitLastRefill) / 1000; // seconds
        
        // Refill tokens based on elapsed time
        const tokensToAdd = (elapsed / this.rateLimitWindow) * this.rateLimitMax;
        conn.rateLimitTokens = Math.min(this.rateLimitMax, conn.rateLimitTokens + tokensToAdd);
        conn.rateLimitLastRefill = now;

        // Check if we have tokens available
        if (conn.rateLimitTokens >= 1) {
            conn.rateLimitTokens -= 1;
            return true;
        }

        return false;
    }

    /**
     * Check if IP is allowed based on allowlist/blocklist
     */
    private isIpAllowed(req: http.IncomingMessage): { allowed: boolean; reason?: string } {
        // Get client IP (handle proxies)
        const forwarded = req.headers['x-forwarded-for'];
        const clientIp = forwarded 
            ? (Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim())
            : req.socket.remoteAddress || 'unknown';

        this.logDebug(`Checking IP: ${clientIp}`);

        // Check blocklist first (takes precedence)
        if (this.ipBlocklist.length > 0) {
            for (const pattern of this.ipBlocklist) {
                if (this.matchIpPattern(clientIp, pattern)) {
                    this.logWarn(`Blocked IP: ${clientIp} (matches ${pattern})`);
                    return { allowed: false, reason: 'IP blocked' };
                }
            }
        }

        // If allowlist exists, check if IP is allowed
        if (this.ipAllowlist.length > 0) {
            let allowed = false;
            for (const pattern of this.ipAllowlist) {
                if (this.matchIpPattern(clientIp, pattern)) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) {
                this.logWarn(`Rejected IP: ${clientIp} (not in allowlist)`);
                return { allowed: false, reason: 'IP not allowed' };
            }
        }

        return { allowed: true };
    }

    /**
     * Match IP against pattern (supports wildcards and CIDR)
     */
    private matchIpPattern(ip: string, pattern: string): boolean {
        // Exact match
        if (ip === pattern) {
            return true;
        }

        // Wildcard match (e.g., 192.168.*.*)
        if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
            return regex.test(ip);
        }

        // CIDR match (basic IPv4 support)
        if (pattern.includes('/')) {
            return this.matchCidr(ip, pattern);
        }

        return false;
    }

    /**
     * Match IP against CIDR notation
     */
    private matchCidr(ip: string, cidr: string): boolean {
        const [network, prefixStr] = cidr.split('/');
        const prefix = parseInt(prefixStr, 10);

        if (isNaN(prefix) || prefix < 0 || prefix > 32) {
            return false;
        }

        const ipToNumber = (ipStr: string): number => {
            const parts = ipStr.split('.').map(p => parseInt(p, 10));
            if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
                return 0;
            }
            return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
        };

        const ipNum = ipToNumber(ip);
        const networkNum = ipToNumber(network);
        const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;

        return (ipNum & mask) === (networkNum & mask);
    }

    /**
     * Encrypt message payload using AES-256-GCM
     */
    private encryptPayload(data: string): string {
        if (!this.encryptionEnabled || !this.encryptionKey) {
            return data;
        }

        try {
            const key = Buffer.from(this.encryptionKey, 'hex');
            if (key.length !== 32) {
                this.logError('Invalid encryption key length, must be 32 bytes (64 hex chars)');
                return data;
            }

            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            
            let encrypted = cipher.update(data, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();

            // Format: iv:authTag:encrypted
            return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
        } catch (err) {
            this.logError(`Encryption error: ${err}`);
            return data;
        }
    }

    /**
     * Decrypt message payload using AES-256-GCM
     */
    private decryptPayload(encrypted: string): string {
        if (!this.encryptionEnabled || !this.encryptionKey) {
            return encrypted;
        }

        try {
            const parts = encrypted.split(':');
            if (parts.length !== 3) {
                this.logError('Invalid encrypted format');
                return encrypted;
            }

            const [ivHex, authTagHex, encryptedData] = parts;
            const key = Buffer.from(this.encryptionKey, 'hex');
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            return decrypted;
        } catch (err) {
            this.logError(`Decryption error: ${err}`);
            return encrypted;
        }
    }

    private async processClientMessage(
        message: ClientMessage, 
        clientId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        this.log(`Processing message type: "${message.type}" id: ${message.id}`);
        
        // Handle pairing request (no auth required)
        if (message.type === 'pairRequest') {
            await this.handlePairRequest(message.id, message.payload as any, clientId, send);
            return;
        }

        // All other messages require authentication
        const connection = this.connections.get(clientId);
        if (!connection?.authenticated) {
            send({
                id: message.id,
                type: 'error',
                payload: { error: 'Not authenticated. Send pairRequest first.' }
            });
            return;
        }

        // Check rate limit
        if (!this.checkRateLimit(clientId)) {
            this.logWarn(`Rate limit exceeded for ${clientId}`);
            send({
                id: message.id,
                type: 'error',
                payload: { error: 'Rate limit exceeded. Please slow down.' }
            });
            return;
        }

        // Wrap in try-catch for graceful error recovery
        try {
            await this.processMessageType(message, send);
        } catch (error) {
            this.logError(`Error processing ${message.type}: ${error}`);
            send({
                id: message.id,
                type: 'error',
                payload: { 
                    error: `Failed to process ${message.type}`,
                    details: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    /**
     * Process message by type with error handling
     */
    private async processMessageType(message: ClientMessage, send: (msg: ControllerMessage) => void): Promise<void> {
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

            case 'setBatteryMode':
                await this.handleSetBatteryMode(message.id, message.payload as any, send);
                break;

            case 'setBandwidthMode':
                await this.handleSetBandwidthMode(message.id, message.payload as any, send);
                break;

            case 'getQualityMetrics':
                await this.handleGetQualityMetrics(message.id, send);
                break;

            case 'models':
                await this.handleModels(message.id, send);
                break;

            case 'context':
                await this.handleContext(message.id, send);
                break;

            case 'files':
                await this.handleFiles(message.id, message.payload as FilesPayload, send);
                break;

            case 'readFile':
                await this.handleReadFile(message.id, message.payload as ReadFilePayload, send);
                break;

            case 'writeFile':
                await this.handleWriteFile(message.id, message.payload as WriteFilePayload, send);
                break;

            case 'editFile':
                await this.handleEditFile(message.id, message.payload as EditFilePayload, send);
                break;

            case 'openFile':
                await this.handleOpenFile(message.id, message.payload as OpenFilePayload, send);
                break;

            case 'terminal':
                await this.handleTerminal(message.id, message.payload as TerminalPayload, send);
                break;

            case 'terminalSpawn':
                this.log(`Processing terminalSpawn message: ${JSON.stringify(message.payload)}`);
                this.handleTerminalSpawn(message.id, message.payload as TerminalSpawnPayload, send);
                break;

            case 'terminalInput':
                this.handleTerminalInput(message.id, message.payload as TerminalInputPayload, send);
                break;

            case 'terminalResize':
                this.handleTerminalResize(message.id, message.payload as TerminalResizePayload, send);
                break;

            case 'terminalKill':
                this.handleTerminalKill(message.id, message.payload as TerminalKillPayload, send);
                break;

            default:
                send({
                    id: message.id,
                    type: 'error',
                    payload: { code: 'UNKNOWN_TYPE', message: 'Unknown message type' }
                });
        }
    }

    // ============ Device Pairing ============

    private async handlePairRequest(
        requestId: string,
        payload: { deviceName: string; deviceId: string; sessionToken?: string },
        clientId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        this.log(`Pairing request from device: ${payload.deviceName} (${payload.deviceId})`);

        // Check if session token provided (existing device reconnecting)
        if (payload.sessionToken) {
            const session = this.sessionManager.validateSessionToken(payload.sessionToken);
            if (session) {
                // Valid session, authenticate immediately
                const connection = this.connections.get(clientId);
                if (connection) {
                    connection.authenticated = true;
                    connection.sessionToken = payload.sessionToken;
                    connection.deviceId = session.deviceId;
                    connection.deviceName = session.deviceName;
                }

                send({
                    id: requestId,
                    type: 'pairApproved',
                    payload: {
                        pairingId: requestId,
                        status: 'approved',
                        sessionToken: payload.sessionToken,
                        deviceId: session.deviceId
                    }
                });

                this.log(`Device ${session.deviceName} reconnected with existing session`);
                return;
            }
        }

        // New device - create pairing request
        const pairingId = this.sessionManager.createPairingRequest(payload.deviceName, payload.deviceId);

        // Send pending response
        send({
            id: requestId,
            type: 'pairPending',
            payload: {
                pairingId,
                status: 'pending',
                message: 'Waiting for approval on desktop...'
            }
        });

        // Show approval notification in VS Code
        const action = await vscode.window.showInformationMessage(
            `Device "${payload.deviceName}" wants to connect to Copilot Controller`,
            { modal: false },
            'Allow',
            'Deny'
        );

        if (action === 'Allow') {
            // Approve pairing
            const session = await this.sessionManager.approvePairing(pairingId);
            if (session) {
                // Update connection
                const connection = this.connections.get(clientId);
                if (connection) {
                    connection.authenticated = true;
                    connection.sessionToken = session.sessionToken;
                    connection.deviceId = session.deviceId;
                    connection.deviceName = session.deviceName;
                }

                send({
                    id: requestId,
                    type: 'pairApproved',
                    payload: {
                        pairingId,
                        status: 'approved',
                        sessionToken: session.sessionToken,
                        deviceId: session.deviceId
                    }
                });

                this.log(`Device ${payload.deviceName} paired successfully`);
            }
        } else {
            // Reject pairing
            this.sessionManager.rejectPairing(pairingId);
            send({
                id: requestId,
                type: 'pairRejected',
                payload: {
                    pairingId,
                    status: 'rejected',
                    reason: 'User denied the pairing request'
                }
            });

            this.log(`Device ${payload.deviceName} pairing rejected`);
        }
    }

    // ============ Mobile Optimization Handlers ============

    private async handleSetBatteryMode(
        requestId: string,
        payload: { mode: 'normal' | 'low' | 'critical' },
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        const conn = this.connections.get(requestId);
        if (conn) {
            const oldMode = conn.batteryMode;
            conn.batteryMode = payload.mode;
            this.logInfo(`Client battery mode changed: ${oldMode} -> ${payload.mode}`);
            
            // Adjust compression based on battery mode
            conn.compressionLevel = payload.mode === 'critical' ? 1 : payload.mode === 'low' ? 2 : 3;
            
            send({
                id: requestId,
                type: 'batteryModeSet',
                payload: { mode: payload.mode, compressionLevel: conn.compressionLevel }
            });
        }
    }

    private async handleSetBandwidthMode(
        requestId: string,
        payload: { mode: 'normal' | 'low' },
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        const conn = this.connections.get(requestId);
        if (conn) {
            const oldMode = conn.bandwidthMode;
            conn.bandwidthMode = payload.mode;
            this.logInfo(`Client bandwidth mode changed: ${oldMode} -> ${payload.mode}`);
            
            // Adjust compression for low bandwidth
            if (payload.mode === 'low') {
                conn.compressionLevel = Math.max(1, conn.compressionLevel - 1);
            }
            
            send({
                id: requestId,
                type: 'bandwidthModeSet',
                payload: { mode: payload.mode, compressionLevel: conn.compressionLevel }
            });
        }
    }

    private async handleGetQualityMetrics(
        requestId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        const conn = this.connections.get(requestId);
        if (conn) {
            send({
                id: requestId,
                type: 'qualityMetrics',
                payload: {
                    latency: conn.latency,
                    packetLoss: conn.packetLoss,
                    bytesSent: conn.bytesSent,
                    bytesReceived: conn.bytesReceived,
                    messagesSent: conn.messagesSent,
                    messagesReceived: conn.messagesReceived,
                    batteryMode: conn.batteryMode,
                    bandwidthMode: conn.bandwidthMode,
                    compressionLevel: conn.compressionLevel,
                    uptime: Math.floor((Date.now() - conn.connectedAt) / 1000)
                }
            });
        }
    }

    // ============ Chat Handler ============

    private async handleChat(
        requestId: string, 
        payload: ChatPayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        this.log(`Chat request ${requestId}: ${payload.message.substring(0, 50)}... (includeContext: ${payload.includeContext})`);

        // If context is requested, prepend it to the message
        let messageWithContext = payload.message;
        if (payload.includeContext) {
            try {
                const context = await this.contextReader.getContext();
                const contextText = this.contextReader.formatContextForChat(context);
                if (contextText) {
                    messageWithContext = `${contextText}\n\n${payload.message}`;
                    this.log(`Chat request ${requestId}: Added context (${context.activeFile?.fileName || 'no file'})`);
                }
            } catch (err) {
                this.log(`Chat request ${requestId}: Failed to get context: ${err}`);
            }
        }

        // Create a modified payload with the context-enhanced message
        const payloadWithContext = {
            ...payload,
            message: messageWithContext
        };

        await this.bridge.sendMessage(
            requestId,
            payloadWithContext,
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

    private async handleModels(
        messageId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            const modelTracker = ModelTracker.getInstance();
            const models = await modelTracker.listModels();
            this.log(`Models request: returning ${models.length} models`);
            send({
                id: messageId,
                type: 'models',
                payload: { models }
            });
        } catch (err) {
            this.log(`Models request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'MODELS_ERROR', message: `Failed to get models: ${err}` }
            });
        }
    }

    private async handleContext(
        messageId: string,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            const context = await this.contextReader.getContext();
            this.log(`Context request: activeFile=${context.activeFile?.fileName || 'none'}, openFiles=${context.openFiles?.length || 0}`);
            send({
                id: messageId,
                type: 'context',
                payload: context
            });
        } catch (err) {
            this.log(`Context request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'CONTEXT_ERROR', message: `Failed to get context: ${err}` }
            });
        }
    }

    private async handleFiles(
        messageId: string,
        payload: FilesPayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            const result = await this.fileBrowser.listFiles(payload?.path);
            this.log(`Files request: path="${payload?.path || '/'}", entries=${result.entries.length}`);
            send({
                id: messageId,
                type: 'files',
                payload: result
            });
        } catch (err) {
            this.log(`Files request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'FILES_ERROR', message: `${err}` }
            });
        }
    }

    private async handleReadFile(
        messageId: string,
        payload: ReadFilePayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            if (!payload?.path) {
                throw new Error('File path is required');
            }
            const result = await this.fileBrowser.readFile(payload.path);
            this.log(`ReadFile request: path="${payload.path}", size=${result.size}`);
            send({
                id: messageId,
                type: 'fileContent',
                payload: result
            });
        } catch (err) {
            this.log(`ReadFile request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'READ_FILE_ERROR', message: `${err}` }
            });
        }
    }

    private async handleWriteFile(
        messageId: string,
        payload: WriteFilePayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            if (!payload?.path) {
                throw new Error('File path is required');
            }
            if (payload.content === undefined) {
                throw new Error('File content is required');
            }
            const result = await this.fileEditor.writeFile(payload);
            this.log(`WriteFile request: path="${payload.path}", success=${result.success}`);
            send({
                id: messageId,
                type: 'writeResult',
                payload: result
            });
        } catch (err) {
            this.log(`WriteFile request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'WRITE_FILE_ERROR', message: `${err}` }
            });
        }
    }

    private async handleEditFile(
        messageId: string,
        payload: EditFilePayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            if (!payload?.path) {
                throw new Error('File path is required');
            }
            if (!payload?.edits || !Array.isArray(payload.edits)) {
                throw new Error('Edits array is required');
            }
            const result = await this.fileEditor.editFile(payload);
            this.log(`EditFile request: path="${payload.path}", edits=${payload.edits.length}, success=${result.success}`);
            send({
                id: messageId,
                type: 'editResult',
                payload: result
            });
        } catch (err) {
            this.log(`EditFile request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'EDIT_FILE_ERROR', message: `${err}` }
            });
        }
    }

    private async handleOpenFile(
        messageId: string,
        payload: OpenFilePayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            if (!payload?.path) {
                throw new Error('File path is required');
            }
            const result = await this.fileEditor.openFile(payload);
            this.log(`OpenFile request: path="${payload.path}", line=${payload.line || 'none'}, success=${result.success}`);
            send({
                id: messageId,
                type: 'openResult',
                payload: result
            });
        } catch (err) {
            this.log(`OpenFile request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'OPEN_FILE_ERROR', message: `${err}` }
            });
        }
    }

    private async handleTerminal(
        messageId: string,
        payload: TerminalPayload,
        send: (msg: ControllerMessage) => void
    ): Promise<void> {
        try {
            if (!payload?.command) {
                throw new Error('Command is required');
            }
            this.log(`Terminal request: command="${payload.command.substring(0, 50)}..."`);
            
            await this.terminalManager.executeCommand(
                messageId,
                payload,
                (output) => {
                    send({
                        id: messageId,
                        type: 'terminalOutput',
                        payload: output
                    });
                },
                (exit) => {
                    send({
                        id: messageId,
                        type: 'terminalExit',
                        payload: exit
                    });
                }
            );
        } catch (err) {
            this.log(`Terminal request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'TERMINAL_ERROR', message: `${err}` }
            });
        }
    }

    private handleTerminalKill(
        messageId: string,
        payload: TerminalKillPayload,
        send: (msg: ControllerMessage) => void
    ): void {
        try {
            if (!payload?.terminalId) {
                throw new Error('Terminal ID is required');
            }
            const killed = this.terminalManager.killTerminal(payload.terminalId);
            this.log(`TerminalKill request: id="${payload.terminalId}", killed=${killed}`);
            send({
                id: messageId,
                type: 'terminalExit',
                payload: {
                    terminalId: payload.terminalId,
                    exitCode: killed ? -1 : undefined,
                    success: killed
                }
            });
        } catch (err) {
            this.log(`TerminalKill request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'TERMINAL_KILL_ERROR', message: `${err}` }
            });
        }
    }

    private handleTerminalSpawn(
        messageId: string,
        payload: TerminalSpawnPayload,
        send: (msg: ControllerMessage) => void
    ): void {
        try {
            if (!payload?.terminalId) {
                throw new Error('Terminal ID is required');
            }
            this.log(`TerminalSpawn request: id="${payload.terminalId}", shell="${payload.shell || 'default'}"`);
            
            const success = this.terminalManager.spawnInteractiveShell(
                payload,
                (output) => {
                    this.log(`Sending terminalOutput to client: terminalId=${payload.terminalId}, outputLen=${output.output?.length}`);
                    send({
                        id: payload.terminalId, // Use terminal ID for routing
                        type: 'terminalOutput',
                        payload: output
                    });
                },
                (exit) => {
                    this.log(`Sending terminalExit to client: terminalId=${payload.terminalId}`);
                    send({
                        id: payload.terminalId,
                        type: 'terminalExit',
                        payload: exit
                    });
                }
            );

            if (success) {
                send({
                    id: messageId,
                    type: 'done',
                    payload: { terminalId: payload.terminalId, spawned: true }
                });
            }
        } catch (err) {
            this.log(`TerminalSpawn request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'TERMINAL_SPAWN_ERROR', message: `${err}` }
            });
        }
    }

    private handleTerminalInput(
        messageId: string,
        payload: TerminalInputPayload,
        send: (msg: ControllerMessage) => void
    ): void {
        try {
            if (!payload?.terminalId || payload.data === undefined) {
                throw new Error('Terminal ID and data are required');
            }
            this.log(`TerminalInput: terminalId=${payload.terminalId}, dataLen=${payload.data.length}, data="${payload.data.substring(0, 20)}"`);
            const success = this.terminalManager.writeToTerminal(payload.terminalId, payload.data);
            if (!success) {
                this.log(`TerminalInput: terminal "${payload.terminalId}" not found`);
            }
            // No response needed for input - output will come via terminalOutput
        } catch (err) {
            this.log(`TerminalInput request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'TERMINAL_INPUT_ERROR', message: `${err}` }
            });
        }
    }

    private handleTerminalResize(
        messageId: string,
        payload: TerminalResizePayload,
        send: (msg: ControllerMessage) => void
    ): void {
        try {
            if (!payload?.terminalId || !payload.cols || !payload.rows) {
                throw new Error('Terminal ID, cols, and rows are required');
            }
            const success = this.terminalManager.resizeTerminal(payload.terminalId, payload.cols, payload.rows);
            this.log(`TerminalResize: id="${payload.terminalId}", cols=${payload.cols}, rows=${payload.rows}, success=${success}`);
            // No response needed for resize
        } catch (err) {
            this.log(`TerminalResize request error: ${err}`);
            send({
                id: messageId,
                type: 'error',
                payload: { code: 'TERMINAL_RESIZE_ERROR', message: `${err}` }
            });
        }
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

    private log(message: string, level: 'error' | 'warn' | 'info' | 'debug' = 'debug'): void {
        // Check if this log level should be shown
        const levels = { error: 0, warn: 1, info: 2, debug: 3 };
        if (levels[level] > levels[this.logLevel]) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = level === 'debug' ? '' : `[${level.toUpperCase()}] `;
        this.outputChannel.appendLine(`[${timestamp}] ${prefix}${message}`);
    }

    private logError(message: string): void {
        this.log(message, 'error');
    }

    private logWarn(message: string): void {
        this.log(message, 'warn');
    }

    private logInfo(message: string): void {
        this.log(message, 'info');
    }

    private logDebug(message: string): void {
        this.log(message, 'debug');
    }

    getOutputChannel(): vscode.OutputChannel {
        return this.outputChannel;
    }
}
