import * as vscode from 'vscode';
import { Controller } from './controller';
import { ClientConnection } from './types';

export class ConnectionsTreeDataProvider implements vscode.TreeDataProvider<ConnectionTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ConnectionTreeItem | undefined | void> = new vscode.EventEmitter<ConnectionTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ConnectionTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private controller: Controller) {
        // Listen to connection changes and refresh the tree
        controller.onConnectionCountChange(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ConnectionTreeItem): Promise<ConnectionTreeItem[]> {
        if (!this.controller.isRunning()) {
            return [];
        }

        if (!element) {
            // Root level - show active connections
            const connections = this.controller.getActiveConnections();
            return connections.map((conn: ClientConnection) => new ConnectionTreeItem(conn));
        }

        return [];
    }
}

class ConnectionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly connection: {
            id: string;
            deviceName?: string;
            deviceId?: string;
            connectedAt: number;
            lastActivity: number;
            authenticated: boolean;
            bytesSent: number;
            bytesReceived: number;
            messagesSent: number;
            messagesReceived: number;
        }
    ) {
        super(
            connection.deviceName || connection.id.substring(0, 8),
            vscode.TreeItemCollapsibleState.None
        );

        const connectedAgo = formatDuration(Date.now() - connection.connectedAt);
        const lastActivityAgo = formatDuration(Date.now() - connection.lastActivity);
        const totalBytes = connection.bytesSent + connection.bytesReceived;

        this.description = `${formatBytes(totalBytes)} • ${connectedAgo}`;
        this.tooltip = new vscode.MarkdownString(
            `**Device:** ${connection.deviceName || 'Unknown'}\n\n` +
            `**Client ID:** \`${connection.id}\`\n\n` +
            `**Connected:** ${connectedAgo} ago\n\n` +
            `**Last Activity:** ${lastActivityAgo} ago\n\n` +
            `**Status:** ${connection.authenticated ? '✅ Authenticated' : '⏳ Pending auth'}\n\n` +
            `---\n\n` +
            `**Bandwidth:**\n` +
            `- Sent: ${formatBytes(connection.bytesSent)} (${connection.messagesSent} msgs)\n` +
            `- Received: ${formatBytes(connection.bytesReceived)} (${connection.messagesReceived} msgs)\n` +
            `- Total: ${formatBytes(totalBytes)}`
        );

        this.iconPath = new vscode.ThemeIcon(
            connection.authenticated ? 'device-mobile' : 'clock',
            connection.authenticated ? undefined : new vscode.ThemeColor('charts.yellow')
        );

        this.contextValue = 'connection';
    }
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${seconds}s`;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) {
        return '0 B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
