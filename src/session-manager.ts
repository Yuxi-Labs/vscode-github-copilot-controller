import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DeviceSession } from './types';

/**
 * Manages device sessions for pairing-based authentication
 */
export class SessionManager {
    private sessions: Map<string, DeviceSession> = new Map();
    private pendingPairings: Map<string, PendingPairing> = new Map();
    
    constructor(private context: vscode.ExtensionContext) {
        this.loadSessions();
    }

    /**
     * Load saved sessions from storage
     */
    private async loadSessions(): Promise<void> {
        const saved = this.context.globalState.get<DeviceSession[]>('deviceSessions', []);
        for (const session of saved) {
            this.sessions.set(session.deviceId, session);
        }
    }

    /**
     * Save sessions to storage
     */
    private async saveSessions(): Promise<void> {
        const sessions = Array.from(this.sessions.values());
        await this.context.globalState.update('deviceSessions', sessions);
    }

    /**
     * Create a pending pairing request
     */
    createPairingRequest(deviceName: string, deviceId: string): string {
        const pairingId = crypto.randomBytes(16).toString('hex');
        
        this.pendingPairings.set(pairingId, {
            pairingId,
            deviceName,
            deviceId,
            createdAt: Date.now(),
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });

        // Auto-cleanup after expiry
        setTimeout(() => {
            this.pendingPairings.delete(pairingId);
        }, 5 * 60 * 1000);

        return pairingId;
    }

    /**
     * Get pending pairing by ID
     */
    getPendingPairing(pairingId: string): PendingPairing | undefined {
        const pairing = this.pendingPairings.get(pairingId);
        if (!pairing) {
            return undefined;
        }

        // Check expiry
        if (Date.now() > pairing.expiresAt) {
            this.pendingPairings.delete(pairingId);
            return undefined;
        }

        return pairing;
    }

    /**
     * Approve a pairing request and create session
     */
    async approvePairing(pairingId: string): Promise<DeviceSession | null> {
        const pairing = this.getPendingPairing(pairingId);
        if (!pairing) {
            return null;
        }

        // Generate session token
        const sessionToken = crypto.randomBytes(32).toString('hex');

        const session: DeviceSession = {
            deviceId: pairing.deviceId,
            deviceName: pairing.deviceName,
            sessionToken,
            createdAt: Date.now(),
            lastUsed: Date.now()
        };

        this.sessions.set(session.deviceId, session);
        this.pendingPairings.delete(pairingId);
        
        await this.saveSessions();

        return session;
    }

    /**
     * Reject a pairing request
     */
    rejectPairing(pairingId: string): boolean {
        return this.pendingPairings.delete(pairingId);
    }

    /**
     * Validate a session token
     */
    validateSessionToken(sessionToken: string): DeviceSession | null {
        for (const session of this.sessions.values()) {
            if (session.sessionToken === sessionToken) {
                // Update last used timestamp
                session.lastUsed = Date.now();
                this.saveSessions();
                return session;
            }
        }
        return null;
    }

    /**
     * Get session by device ID
     */
    getSession(deviceId: string): DeviceSession | undefined {
        return this.sessions.get(deviceId);
    }

    /**
     * Get all active sessions
     */
    getAllSessions(): DeviceSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Revoke a device session
     */
    async revokeSession(deviceId: string): Promise<boolean> {
        const deleted = this.sessions.delete(deviceId);
        if (deleted) {
            await this.saveSessions();
        }
        return deleted;
    }

    /**
     * Get all pending pairings
     */
    getPendingPairings(): PendingPairing[] {
        return Array.from(this.pendingPairings.values());
    }
}

interface PendingPairing {
    pairingId: string;
    deviceName: string;
    deviceId: string;
    createdAt: number;
    expiresAt: number;
}
