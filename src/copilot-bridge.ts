import * as vscode from 'vscode';
import { 
    ChatPayload, 
    ChatMode,
    ChunkPayload, 
    DonePayload, 
    ErrorPayload,
    ToolCallPayload,
    PendingRequest 
} from './types';
import { ModelTracker } from './model-tracker';

// Mode-specific system prompts that approximate GitHub Copilot's behavior
const MODE_PROMPTS: Record<ChatMode, string> = {
    agent: `You are an autonomous coding agent with full capabilities:
- You can execute terminal commands by wrapping them in <terminal>command</terminal> tags
- You can create or edit files by wrapping content in <file path="path/to/file">content</file> tags
- You can read files by requesting <readFile path="path/to/file"/>
- You can open files in the editor with <openFile path="path/to/file" line="1"/>
- Take initiative to complete tasks end-to-end
- Run tests, install dependencies, and verify your work
- If something fails, debug and fix it autonomously

IMPORTANT: All file changes you suggest will be shown to the user for approval before being applied.
Be specific and concrete - provide actual code, not placeholders or pseudocode.
When you need to perform actions, use the appropriate tags and the system will execute them.`,

    ask: `You are a helpful coding assistant in Ask mode:
- Answer questions about code, concepts, and best practices
- Explain code snippets and algorithms
- Provide code examples when helpful
- Focus on understanding and explaining, not on making changes

RESTRICTIONS:
- Do NOT make changes to files directly
- Do NOT execute terminal commands
- Do NOT suggest file operations unless it's to illustrate a concept
- If the user wants changes made, suggest they switch to edit or agent mode

Focus on providing accurate, educational responses.`,

    edit: `You are a precise code editor in Edit mode:
- Make targeted, surgical edits to the specified code
- When given a selection, focus only on improving that section
- Preserve the overall structure and style of the code
- Explain what changes you're making and why
- Use the <edit> or <file> tags to specify your changes

WORKFLOW:
1. Understand what the user wants to change
2. Explain your approach briefly
3. Output your edits in this format:
   <edit file="path/to/file" startLine="X" endLine="Y">
   new code here
   </edit>

IMPORTANT: All changes will be shown to the user for approval before applying.
Do NOT add unrelated changes or refactor beyond the request.
Stay focused on the user's specific edit request.`,

    plan: `You are a strategic coding planner in Plan mode:
- Break down complex tasks into clear, actionable steps
- Create numbered step-by-step plans with clear descriptions
- Identify which files will be affected by each step
- Estimate complexity and potential challenges
- Suggest testing strategies

OUTPUT FORMAT:
## Plan: [Task Name]

### Overview
[Brief summary of what needs to be done and why]

### Implementation Steps
1. **[Step Title]**
   - Description of what needs to be done
   - Files involved: [list files]
   - Estimated complexity: [Low/Medium/High]

2. **[Step Title]**
   ...

### Considerations
- Edge cases to handle
- Testing requirements
- Potential issues

### Next Steps
[What to do after the plan is approved]

RESTRICTIONS:
- Do NOT execute any actions or make changes (that's for agent mode)
- Do NOT write full implementations (focus on WHAT and WHY, not detailed HOW)
- Do NOT use action tags (<terminal>, <file>, etc.)
- If the user wants to start implementation, suggest switching to agent mode

Ask clarifying questions if the task is ambiguous.`
};

/**
 * Bridge between remote clients and VS Code's Copilot Language Model API
 */
export class CopilotBridge {
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private conversationHistory: vscode.LanguageModelChatMessage[] = [];
    private maxHistoryLength = 50;
    private modelTracker: ModelTracker;
    private currentMode: ChatMode = 'agent';

    constructor() {
        this.modelTracker = ModelTracker.getInstance();
    }

    /**
     * Strip action tags from content for display
     */
    private stripActionTags(content: string): string {
        let stripped = content;
        
        // Remove all action tags but keep their descriptions
        stripped = stripped.replace(/<file path="([^"]+)">(.*?)<\/file>/gs, (match, path) => {
            return `[File: ${path}]`;
        });
        
        stripped = stripped.replace(/<edit file="([^"]+)"[^>]*>(.*?)<\/edit>/gs, (match, path) => {
            return `[Edit: ${path}]`;
        });
        
        stripped = stripped.replace(/<terminal>(.*?)<\/terminal>/gs, (match, cmd) => {
            const trimmed = cmd.trim();
            return `[Terminal: ${trimmed.length > 50 ? trimmed.substring(0, 50) + '...' : trimmed}]`;
        });
        
        stripped = stripped.replace(/<readFile path="([^"]+)"\s*\/>/g, (match, path) => {
            return `[Read: ${path}]`;
        });
        
        stripped = stripped.replace(/<openFile path="([^"]+)"[^>]*\/>/g, (match, path) => {
            return `[Open: ${path}]`;
        });
        
        return stripped.trim();
    }

    /**
     * Parse action tags from response and generate tool calls
     */
    private parseActionTags(
        content: string, 
        requestId: string, 
        onToolCall: (toolCall: ToolCallPayload) => void,
        onFileWrite?: (path: string, content: string) => Promise<void>,
        onFileEdit?: (path: string, content: string) => Promise<void>
    ): void {
        const patterns = [
            { 
                regex: /<file path="([^"]+)">(.*?)<\/file>/gs, 
                type: 'file_write' as const, 
                desc: (path?: string) => `Write file: ${path}`,
                execute: async (match: RegExpMatchArray) => {
                    if (onFileWrite) {
                        const path = match[1];
                        const content = match[2];
                        await onFileWrite(path, content);
                    }
                }
            },
            { 
                regex: /<edit file="([^"]+)"[^>]*>(.*?)<\/edit>/gs, 
                type: 'file_edit' as const, 
                desc: (path?: string) => `Edit file: ${path}`,
                execute: async (match: RegExpMatchArray) => {
                    if (onFileEdit) {
                        const path = match[1];
                        const content = match[2];
                        await onFileEdit(path, content);
                    }
                }
            },
            { 
                regex: /<readFile path="([^"]+)"\s*\/>/g, 
                type: 'file_read' as const, 
                desc: (path?: string) => `Read file: ${path}`,
                execute: async () => {
                    // Read operations are informational only, not executed here
                }
            },
            { 
                regex: /<openFile path="([^"]+)"[^>]*\/>/g, 
                type: 'file_edit' as const, 
                desc: (path?: string) => `Open file: ${path}`,
                execute: async () => {
                    // Open operations are informational only
                }
            },
            { 
                regex: /<terminal>(.*?)<\/terminal>/gs, 
                type: 'terminal' as const, 
                desc: () => `Run terminal command`,
                execute: async () => {
                    // Terminal operations are informational only
                }
            },
        ];

        for (const pattern of patterns) {
            const matches = Array.from(content.matchAll(pattern.regex));
            for (const match of matches) {
                const id = `${requestId}-${pattern.type}-${Date.now()}-${Math.random()}`;
                const path = match[1];
                const details = match[2] ? (match[2].length > 100 ? match[2].substring(0, 100) + '...' : match[2]) : path;
                
                // Send pending status
                onToolCall({
                    requestId,
                    toolCall: {
                        id,
                        type: pattern.type,
                        status: 'pending',
                        description: pattern.desc(path),
                        details,
                        timestamp: Date.now()
                    }
                });

                // Execute the action asynchronously
                (async () => {
                    try {
                        // Send running status
                        onToolCall({
                            requestId,
                            toolCall: {
                                id,
                                type: pattern.type,
                                status: 'running',
                                description: pattern.desc(path),
                                details,
                                timestamp: Date.now()
                            }
                        });

                        // Execute the actual operation
                        await pattern.execute(match);

                        // For file operations, indicate they're awaiting approval
                        // For other operations, mark as success
                        const isFileOperation = pattern.type === 'file_write' || pattern.type === 'file_edit';
                        onToolCall({
                            requestId,
                            toolCall: {
                                id,
                                type: pattern.type,
                                status: 'success',
                                description: isFileOperation 
                                    ? `${pattern.desc(path)} (awaiting approval)` 
                                    : pattern.desc(path),
                                details: isFileOperation 
                                    ? 'Change buffered and sent for approval' 
                                    : details,
                                timestamp: Date.now()
                            }
                        });
                    } catch (err) {
                        // Send error status
                        onToolCall({
                            requestId,
                            toolCall: {
                                id,
                                type: pattern.type,
                                status: 'error',
                                description: pattern.desc(path),
                                details: err instanceof Error ? err.message : String(err),
                                timestamp: Date.now()
                            }
                        });
                    }
                })();
            }
        }
    }

    /**
     * Get the system prompt for the current mode
     */
    private getSystemPrompt(mode: ChatMode, modelName: string): string {
        const modePrompt = MODE_PROMPTS[mode];
        return `You are ${modelName}, an AI assistant operating in ${mode.toUpperCase()} mode.

${modePrompt}

You are being accessed through a remote client application connected to VS Code. When asked about your identity, accurately identify yourself as ${modelName}.`;
    }

    /**
     * Send a message to Copilot and stream the response
     */
    async sendMessage(
        requestId: string,
        payload: ChatPayload,
        onChunk: (chunk: ChunkPayload) => void,
        onDone: (done: DonePayload) => void,
        onError: (error: ErrorPayload) => void,
        onToolCall?: (toolCall: ToolCallPayload) => void,
        onFileWrite?: (path: string, content: string) => Promise<void>,
        onFileEdit?: (path: string, content: string) => Promise<void>
    ): Promise<void> {
        try {
            const mode = payload.mode || 'agent';
            this.currentMode = mode;
            
            console.log(`[CopilotBridge] Request received. Mode: ${mode}, Model: "${payload.model}"`);
            
            // Use the ModelTracker to get the appropriate model
            const model = await this.modelTracker.getModelForRequest(payload.model);

            if (!model) {
                onError({
                    requestId,
                    code: 'NO_MODEL',
                    message: payload.model 
                        ? `Model '${payload.model}' not found. Make sure GitHub Copilot is installed and signed in.`
                        : 'No Copilot models available. Make sure GitHub Copilot is installed and signed in.'
                });
                return;
            }

            console.log(`[CopilotBridge] Using model: ${model.name} (${model.id})`);

            // Build the user message with any edit context
            let userMessage = payload.message;
            if (mode === 'edit' && payload.targetFile) {
                userMessage = `Target file: ${payload.targetFile}\n`;
                if (payload.selection) {
                    userMessage += `Selected lines ${payload.selection.startLine}-${payload.selection.endLine}:\n\`\`\`\n${payload.selection.text}\n\`\`\`\n\n`;
                }
                userMessage += `Edit request: ${payload.message}`;
            }

            // Add user message to history
            this.conversationHistory.push(
                vscode.LanguageModelChatMessage.User(userMessage)
            );

            // Trim history if too long
            if (this.conversationHistory.length > this.maxHistoryLength) {
                this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
            }

            // Build messages array with mode-specific system context
            const systemContext = this.getSystemPrompt(mode, model.name);
            
            const messagesWithContext: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(systemContext),
                vscode.LanguageModelChatMessage.Assistant(`Understood. I am ${model.name} operating in ${mode.toUpperCase()} mode. I will follow the mode-specific guidelines.`),
                ...this.conversationHistory
            ];

            // Create cancellation token
            const cancellationTokenSource = new vscode.CancellationTokenSource();

            // Track the pending request
            const pendingRequest: PendingRequest = {
                id: requestId,
                startTime: Date.now(),
                cancellationToken: { cancel: () => cancellationTokenSource.cancel() },
                chunks: []
            };
            this.pendingRequests.set(requestId, pendingRequest);

            // Send request to Copilot
            const response = await model.sendRequest(
                messagesWithContext,
                {},
                cancellationTokenSource.token
            );

            // Stream the response
            let chunkIndex = 0;
            let fullContent = '';

            for await (const fragment of response.text) {
                // Check if cancelled
                if (cancellationTokenSource.token.isCancellationRequested) {
                    break;
                }

                fullContent += fragment;
                pendingRequest.chunks.push(fragment);

                onChunk({
                    requestId,
                    content: fragment,
                    index: chunkIndex++
                });
            }

            // Add assistant response to history
            this.conversationHistory.push(
                vscode.LanguageModelChatMessage.Assistant(fullContent)
            );

            // Parse and execute action tags if in agent mode and onToolCall is provided
            if (mode === 'agent' && onToolCall) {
                this.parseActionTags(fullContent, requestId, onToolCall, onFileWrite, onFileEdit);
            }

            // Strip action tags from display content
            const displayContent = mode === 'agent' ? this.stripActionTags(fullContent) : fullContent;

            // Clean up and send done
            this.pendingRequests.delete(requestId);

            onDone({
                requestId,
                fullContent: displayContent
            });

        } catch (err) {
            this.pendingRequests.delete(requestId);

            if (err instanceof vscode.LanguageModelError) {
                onError({
                    requestId,
                    code: err.code || 'LM_ERROR',
                    message: err.message
                });
            } else if (err instanceof Error) {
                onError({
                    requestId,
                    code: 'UNKNOWN_ERROR',
                    message: err.message
                });
            } else {
                onError({
                    requestId,
                    code: 'UNKNOWN_ERROR',
                    message: 'An unknown error occurred'
                });
            }
        }
    }

    /**
     * Get current mode
     */
    getCurrentMode(): ChatMode {
        return this.currentMode;
    }

    /**
     * Cancel an ongoing request
     */
    cancelRequest(requestId: string): boolean {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            pending.cancellationToken.cancel();
            this.pendingRequests.delete(requestId);
            return true;
        }
        return false;
    }

    /**
     * Clear conversation history
     */
    clearHistory(): void {
        this.conversationHistory = [];
    }

    /**
     * Get current status
     */
    getStatus(): { activeRequests: number; historyLength: number } {
        return {
            activeRequests: this.pendingRequests.size,
            historyLength: this.conversationHistory.length
        };
    }

    /**
     * Check if Copilot is available
     */
    async isCopilotAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            return models.length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Get available models
     */
    async getAvailableModels(): Promise<string[]> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            return models.map(m => `${m.vendor}/${m.family}`);
        } catch {
            return [];
        }
    }
}
