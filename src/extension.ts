import * as vscode from 'vscode';
import { Controller } from './controller';
import { ModelTracker } from './model-tracker';
import { ConnectionsTreeDataProvider } from './connections-view';

let controller: Controller | null = null;
let statusBarItem: vscode.StatusBarItem;
let modelTracker: ModelTracker;
let connectionsTreeDataProvider: ConnectionsTreeDataProvider;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Controller for GitHub Copilot extension activating...');

    // Initialize the model tracker
    modelTracker = ModelTracker.getInstance();

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'copilot-controller.showStatus';
    updateStatusBar(false);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Create controller instance
    controller = new Controller(context);

    // Initialize model tracker with the controller's output channel
    modelTracker.initialize(controller.getOutputChannel());

    // Register connections tree view
    connectionsTreeDataProvider = new ConnectionsTreeDataProvider(controller);
    const treeView = vscode.window.createTreeView('copilotControllerConnections', {
        treeDataProvider: connectionsTreeDataProvider,
        showCollapseAll: false
    });
    context.subscriptions.push(treeView);

    // Listen to connection count changes and update status bar
    context.subscriptions.push(
        controller.onConnectionCountChange((count) => {
            updateStatusBar(controller?.isRunning() || false, count);
        })
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-controller.start', async () => {
            try {
                await controller?.start();
                updateStatusBar(true, controller?.getActiveConnectionCount() || 0);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to start: ${err}`);
            }
        }),

        vscode.commands.registerCommand('copilot-controller.stop', async () => {
            await controller?.stop();
            updateStatusBar(false, 0);
        }),

        vscode.commands.registerCommand('copilot-controller.showStatus', async () => {
            if (!controller?.isRunning()) {
                const action = await vscode.window.showInformationMessage(
                    'Controller for GitHub Copilot is not running',
                    'Start'
                );
                if (action === 'Start') {
                    vscode.commands.executeCommand('copilot-controller.start');
                }
                return;
            }

            const info = controller.getConnectionInfo();
            const models = await modelTracker.listModels();
            const modelList = models.map(m => m.name).join(', ') || 'None available';
            
            const message = [
                `🟢 Controller for GitHub Copilot running on port ${info.local.split(':').pop()}`,
                ``,
                `Available models: ${modelList}`,
                `Pass "model" in request to select one`,
                ``,
                `Local: ${info.local}`,
                info.tunnel ? `Tunnel: ${info.tunnel}` : null,
                ``,
                `WebSocket: ${info.local}${info.wsPath}`,
                `SSE: ${info.local}${info.ssePath}`
            ].filter(Boolean).join('\n');

            const action = await vscode.window.showInformationMessage(
                message,
                'Copy Connection Info',
                'Show Logs',
                'Stop'
            );

            switch (action) {
                case 'Copy Connection Info':
                    vscode.commands.executeCommand('copilot-controller.copyConnectionInfo');
                    break;
                case 'Show Logs':
                    controller.getOutputChannel().show();
                    break;
                case 'Stop':
                    vscode.commands.executeCommand('copilot-controller.stop');
                    break;
            }
        }),

        vscode.commands.registerCommand('copilot-controller.copyConnectionInfo', async () => {
            if (!controller?.isRunning()) {
                vscode.window.showWarningMessage('Controller for GitHub Copilot is not running');
                return;
            }

            const info = controller.getConnectionInfo();
            const models = await modelTracker.listModels();
            const connectionData = {
                local: info.local,
                tunnel: info.tunnel,
                token: info.token,
                websocket: `${info.local}${info.wsPath}`,
                sse: `${info.local}${info.ssePath}`,
                availableModels: models
            };

            await vscode.env.clipboard.writeText(JSON.stringify(connectionData, null, 2));
            vscode.window.showInformationMessage('Connection info copied to clipboard');
        }),

        vscode.commands.registerCommand('copilot-controller.manageDevices', async () => {
            if (!controller?.isRunning()) {
                vscode.window.showWarningMessage('Controller for GitHub Copilot is not running');
                return;
            }

            const devices = controller.getConnectedDevices();
            
            if (devices.length === 0) {
                vscode.window.showInformationMessage('No devices currently paired');
                return;
            }

            // Show quick pick with devices
            const items = devices.map(device => ({
                label: device.deviceName,
                description: `Last used: ${new Date(device.lastUsed).toLocaleString()}`,
                detail: `Device ID: ${device.deviceId}`,
                device
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a device to manage'
            });

            if (!selected) {
                return;
            }

            // Ask what to do
            const action = await vscode.window.showQuickPick(
                ['Revoke Access', 'Cancel'],
                { placeHolder: `Manage ${selected.device.deviceName}` }
            );

            if (action === 'Revoke Access') {
                const confirm = await vscode.window.showWarningMessage(
                    `Revoke access for "${selected.device.deviceName}"? The device will need to pair again.`,
                    'Revoke',
                    'Cancel'
                );

                if (confirm === 'Revoke') {
                    controller.revokeDevice(selected.device.deviceId);
                    vscode.window.showInformationMessage(`Revoked access for ${selected.device.deviceName}`);
                }
            }
        })
    );

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('copilotController');
    if (config.get('autoStart', false)) {
        try {
            await controller.start();
            updateStatusBar(true, 0);
        } catch (err) {
            console.error('Failed to auto-start:', err);
        }
    }

    console.log('Controller for GitHub Copilot extension activated');
}

function updateStatusBar(running: boolean, connectionCount: number = 0) {
    if (running) {
        if (connectionCount > 0) {
            statusBarItem.text = `$(broadcast) Controller for GitHub Copilot (${connectionCount})`;
            statusBarItem.tooltip = `Controller for GitHub Copilot: ${connectionCount} active connection${connectionCount === 1 ? '' : 's'}\nClick for status`;
            statusBarItem.backgroundColor = undefined;
        } else {
            statusBarItem.text = '$(broadcast) Controller for GitHub Copilot';
            statusBarItem.tooltip = 'Controller for GitHub Copilot running - No active connections\nClick for status';
            statusBarItem.backgroundColor = undefined;
        }
    } else {
        statusBarItem.text = '$(circle-slash) Controller for GitHub Copilot';
        statusBarItem.tooltip = 'Controller for GitHub Copilot is stopped - Click to start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

export async function deactivate() {
    await controller?.stop();
}
