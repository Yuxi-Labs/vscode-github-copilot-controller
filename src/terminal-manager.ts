import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as os from 'os';
import { 
    TerminalPayload,
    TerminalOutputResponse,
    TerminalExitResponse
} from './types';

interface RunningTerminal {
    id: string;
    ptyProcess: pty.IPty;
    startTime: number;
    command: string;
}

/**
 * Handles remote terminal operations using node-pty for real PTY support
 */
export class TerminalManager {
    private static instance: TerminalManager;
    private runningTerminals: Map<string, RunningTerminal> = new Map();

    private constructor() {}

    static getInstance(): TerminalManager {
        if (!TerminalManager.instance) {
            TerminalManager.instance = new TerminalManager();
        }
        return TerminalManager.instance;
    }

    /**
     * Get the default shell for the current platform
     */
    private getDefaultShell(): string {
        if (os.platform() === 'win32') {
            return process.env.COMSPEC || 'cmd.exe';
        }
        return process.env.SHELL || '/bin/bash';
    }

    /**
     * Execute a command in a new PTY
     */
    async executeCommand(
        id: string,
        payload: TerminalPayload,
        onOutput: (response: TerminalOutputResponse) => void,
        onExit: (response: TerminalExitResponse) => void
    ): Promise<void> {
        const { command, cwd, shell } = payload;

        try {
            // Determine working directory
            let workingDir: string;
            if (cwd) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    workingDir = vscode.Uri.joinPath(workspaceFolders[0].uri, cwd).fsPath;
                } else {
                    workingDir = cwd;
                }
            } else {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    workingDir = workspaceFolders[0].uri.fsPath;
                } else {
                    workingDir = os.homedir();
                }
            }

            // Determine shell to use
            const shellToUse = shell || this.getDefaultShell();
            
            // Shell arguments for executing a command
            const shellArgs: string[] = os.platform() === 'win32' 
                ? ['/c', command]
                : ['-c', command];

            // Spawn the PTY process
            const ptyProcess = pty.spawn(shellToUse, shellArgs, {
                name: 'xterm-256color',
                cols: 120,
                rows: 30,
                cwd: workingDir,
                env: process.env as { [key: string]: string },
            });

            // Store terminal reference
            this.runningTerminals.set(id, {
                id,
                ptyProcess,
                startTime: Date.now(),
                command
            });

            // Handle output
            ptyProcess.onData((data: string) => {
                onOutput({
                    terminalId: id,
                    output: data,
                    isError: false
                });
            });

            // Handle exit
            ptyProcess.onExit(({ exitCode }) => {
                this.runningTerminals.delete(id);
                onExit({
                    terminalId: id,
                    exitCode,
                    success: exitCode === 0
                });
            });

        } catch (error) {
            onOutput({
                terminalId: id,
                output: `Error: ${error instanceof Error ? error.message : String(error)}\r\n`,
                isError: true
            });
            onExit({
                terminalId: id,
                exitCode: 1,
                success: false
            });
        }
    }

    /**
     * Write input to a running terminal
     */
    writeToTerminal(terminalId: string, data: string): boolean {
        const running = this.runningTerminals.get(terminalId);
        if (running) {
            running.ptyProcess.write(data);
            return true;
        }
        return false;
    }

    /**
     * Resize a terminal
     */
    resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
        const running = this.runningTerminals.get(terminalId);
        if (running) {
            running.ptyProcess.resize(cols, rows);
            return true;
        }
        return false;
    }

    /**
     * Kill a running terminal
     */
    killTerminal(terminalId: string): boolean {
        const running = this.runningTerminals.get(terminalId);
        if (running) {
            running.ptyProcess.kill();
            this.runningTerminals.delete(terminalId);
            return true;
        }
        return false;
    }

    /**
     * Get list of active terminals
     */
    getActiveTerminals(): { id: string; command: string; duration: number }[] {
        const now = Date.now();
        return Array.from(this.runningTerminals.values()).map(t => ({
            id: t.id,
            command: t.command,
            duration: now - t.startTime
        }));
    }

    /**
     * Dispose all terminals
     */
    dispose(): void {
        for (const running of this.runningTerminals.values()) {
            running.ptyProcess.kill();
        }
        this.runningTerminals.clear();
    }
}
