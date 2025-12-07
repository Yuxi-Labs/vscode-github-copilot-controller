import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
    test('extension should be present', () => {
        const extension = vscode.extensions.getExtension('yuxi-labs.vscode-github-copilot-controller');
        assert.ok(extension);
    });

    test('commands should be registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        
        assert.ok(commands.includes('github-copilot-controller.start'));
        assert.ok(commands.includes('github-copilot-controller.stop'));
        assert.ok(commands.includes('github-copilot-controller.showStatus'));
        assert.ok(commands.includes('github-copilot-controller.copyConnectionInfo'));
    });
});
