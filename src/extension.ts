import * as vscode from 'vscode';
import { Controller } from './controller';

let controller: Controller | null = null;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Copilot Controller extension activating...');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'copilot-controller.showStatus';
    updateStatusBar(false);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Create controller instance
    controller = new Controller(context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-controller.start', async () => {
            try {
                await controller?.start();
                updateStatusBar(true);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to start: ${err}`);
            }
        }),

        vscode.commands.registerCommand('copilot-controller.stop', async () => {
            await controller?.stop();
            updateStatusBar(false);
        }),

        vscode.commands.registerCommand('copilot-controller.showStatus', async () => {
            if (!controller?.isRunning()) {
                const action = await vscode.window.showInformationMessage(
                    'Copilot Controller is not running',
                    'Start'
                );
                if (action === 'Start') {
                    vscode.commands.executeCommand('copilot-controller.start');
                }
                return;
            }

            const info = controller.getConnectionInfo();
            const message = [
                `🟢 Controller running on port ${info.local.split(':').pop()}`,
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
                vscode.window.showWarningMessage('Controller is not running');
                return;
            }

            const info = controller.getConnectionInfo();
            const connectionData = {
                local: info.local,
                tunnel: info.tunnel,
                token: info.token,
                websocket: `${info.local}${info.wsPath}`,
                sse: `${info.local}${info.ssePath}`
            };

            await vscode.env.clipboard.writeText(JSON.stringify(connectionData, null, 2));
            vscode.window.showInformationMessage('Connection info copied to clipboard');
        })
    );

    // Auto-start if configured
    const config = vscode.workspace.getConfiguration('copilotController');
    if (config.get('autoStart', false)) {
        try {
            await controller.start();
            updateStatusBar(true);
        } catch (err) {
            console.error('Failed to auto-start:', err);
        }
    }

    console.log('Copilot Controller extension activated');
}

function updateStatusBar(running: boolean) {
    if (running) {
        statusBarItem.text = '$(broadcast) Copilot Controller';
        statusBarItem.tooltip = 'Copilot Controller is running - Click for status';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(circle-slash) Copilot Controller';
        statusBarItem.tooltip = 'Copilot Controller is stopped - Click to start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

export async function deactivate() {
    await controller?.stop();
}
