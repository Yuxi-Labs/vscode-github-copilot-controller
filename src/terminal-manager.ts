import * as vscode from 'vscode';
import * as pty from 'node-pty';
import * as os from 'os';
import { 
    TerminalPayload,
    TerminalSpawnPayload,
    TerminalOutputResponse,
    TerminalExitResponse
} from './types';

interface RunningTerminal {
    id: string;
    ptyProcess: pty.IPty;
    startTime: number;
    command: string;
    isInteractive: boolean;
}

// Output channel for logging
let outputChannel: vscode.OutputChannel | null = null;

function log(message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [TerminalManager] ${message}`;
    if (outputChannel) {
        outputChannel.appendLine(logMessage);
    }
    console.log(logMessage);
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
     * Set the output channel for logging
     */
    setOutputChannel(channel: vscode.OutputChannel): void {
        outputChannel = channel;
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
     * Detect the best available shell on the system
     */
    private detectBestShell(): { path: string; type: string } {
        const fs = require('fs');
        
        if (os.platform() === 'win32') {
            // Try PowerShell Core (pwsh) first - best experience
            const pwshPaths = [
                'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
            ];
            for (const path of pwshPaths) {
                if (fs.existsSync(path)) {
                    return { path, type: 'pwsh' };
                }
            }
            
            // Try Windows PowerShell - good experience
            const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            if (fs.existsSync(powershellPath)) {
                return { path: powershellPath, type: 'powershell' };
            }
            
            // Try Git Bash (if installed) - Unix-like experience on Windows
            const gitBashPaths = [
                'C:\\Program Files\\Git\\bin\\bash.exe',
                'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
            ];
            for (const path of gitBashPaths) {
                if (fs.existsSync(path)) {
                    return { path, type: 'bash' };
                }
            }
            
            // Fall back to cmd.exe - always available
            return { 
                path: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', 
                type: 'cmd' 
            };
        } else {
            // Unix-like systems
            const bashPath = '/bin/bash';
            if (fs.existsSync(bashPath)) {
                return { path: bashPath, type: 'bash' };
            }
            
            const shPath = '/bin/sh';
            if (fs.existsSync(shPath)) {
                return { path: shPath, type: 'sh' };
            }
            
            // Fall back to environment shell
            return { path: process.env.SHELL || '/bin/sh', type: 'unknown' };
        }
    }

    /**
     * Resolve shell path - handles common shell names
     */
    private resolveShellPath(shell: string): string {
        const fs = require('fs');
        
        // If it's already a full path, use it
        if (shell.includes('\\') || shell.includes('/')) {
            return shell;
        }

        // Handle common Windows shells
        if (os.platform() === 'win32') {
            const lowerShell = shell.toLowerCase();
            
            // PowerShell Core (pwsh)
            if (lowerShell === 'pwsh' || lowerShell === 'pwsh.exe') {
                const commonPaths = [
                    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                    'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
                ];
                for (const path of commonPaths) {
                    if (fs.existsSync(path)) {
                        return path;
                    }
                }
                return 'pwsh.exe';
            }
            
            // Windows PowerShell
            if (lowerShell === 'powershell' || lowerShell === 'powershell.exe') {
                return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            }
            
            // cmd
            if (lowerShell === 'cmd' || lowerShell === 'cmd.exe') {
                return process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
            }
        }

        // For Unix-like systems or unknown shells, return as-is
        return shell;
    }

    /**
     * Get the working directory
     */
    private getWorkingDirectory(cwd?: string): string {
        if (cwd) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                return vscode.Uri.joinPath(workspaceFolders[0].uri, cwd).fsPath;
            }
            return cwd;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return os.homedir();
    }

    /**
     * Spawn an interactive shell
     */
    spawnInteractiveShell(
        payload: TerminalSpawnPayload,
        onOutput: (response: TerminalOutputResponse) => void,
        onExit: (response: TerminalExitResponse) => void
    ): boolean {
        const { terminalId, cwd, shell, cols = 120, rows = 30 } = payload;

        log(`spawnInteractiveShell called: id=${terminalId}`);

        // Kill existing terminal with same ID if exists
        if (this.runningTerminals.has(terminalId)) {
            this.killTerminal(terminalId);
        }

        try {
            const workingDir = this.getWorkingDirectory(cwd);
            
            let shellToUse: string;
            let shellType: string;
            
            if (shell) {
                shellToUse = this.resolveShellPath(shell);
                shellType = shell.toLowerCase().replace('.exe', '');
            } else {
                const detected = this.detectBestShell();
                shellToUse = detected.path;
                shellType = detected.type;
            }

            log(`Spawning shell: ${shellToUse} (type: ${shellType}) in ${workingDir}`);

            // Spawn interactive shell (no command args = interactive)
            const ptyProcess = pty.spawn(shellToUse, [], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: workingDir,
                env: process.env as { [key: string]: string },
            });

            log(`PTY spawned successfully, pid=${ptyProcess.pid}`);

            // Store terminal reference
            this.runningTerminals.set(terminalId, {
                id: terminalId,
                ptyProcess,
                startTime: Date.now(),
                command: shellToUse,
                isInteractive: true
            });
            
            // Send shell type info back to client on first output
            let sentShellType = false;

            // Handle output
            ptyProcess.onData((data: string) => {
                log(`Output from ${terminalId}: ${data.substring(0, 50).replace(/\r?\n/g, '\\n')}...`);
                onOutput({
                    terminalId,
                    output: data,
                    shellType: !sentShellType ? shellType : undefined,
                    isError: false
                });
                sentShellType = true;
            });

            // Handle exit
            ptyProcess.onExit(({ exitCode }) => {
                log(`Terminal ${terminalId} exited with code ${exitCode}`);
                this.runningTerminals.delete(terminalId);
                onExit({
                    terminalId,
                    exitCode,
                    success: exitCode === 0
                });
            });

            return true;
        } catch (error) {
            log(`Error spawning shell: ${error instanceof Error ? error.message : String(error)}`);
            onOutput({
                terminalId,
                output: `Error spawning shell: ${error instanceof Error ? error.message : String(error)}\r\n`,
                isError: true
            });
            onExit({
                terminalId,
                exitCode: 1,
                success: false
            });
            return false;
        }
    }

    /**
     * Execute a command in a new PTY (legacy single-command execution)
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
                command,
                isInteractive: false
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
            log(`Writing to PTY ${terminalId}: ${data.length} bytes, data="${data.substring(0, 20)}"`);
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
