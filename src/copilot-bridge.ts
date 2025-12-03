import * as vscode from 'vscode';
import { 
    ChatPayload, 
    ChunkPayload, 
    DonePayload, 
    ErrorPayload, 
    PendingRequest 
} from './types';

/**
 * Bridge between remote clients and VS Code's Copilot Language Model API
 */
export class CopilotBridge {
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private conversationHistory: vscode.LanguageModelChatMessage[] = [];
    private maxHistoryLength = 50;

    constructor() {}

    /**
     * Send a message to Copilot and stream the response
     */
    async sendMessage(
        requestId: string,
        payload: ChatPayload,
        onChunk: (chunk: ChunkPayload) => void,
        onDone: (done: DonePayload) => void,
        onError: (error: ErrorPayload) => void
    ): Promise<void> {
        try {
            // Select the chat model
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: payload.model || 'gpt-4o'
            });

            if (models.length === 0) {
                // Try without family filter
                const anyModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                if (anyModels.length === 0) {
                    onError({
                        requestId,
                        code: 'NO_MODEL',
                        message: 'No Copilot models available. Make sure GitHub Copilot is installed and signed in.'
                    });
                    return;
                }
                models.push(anyModels[0]);
            }

            const model = models[0];

            // Add user message to history
            this.conversationHistory.push(
                vscode.LanguageModelChatMessage.User(payload.message)
            );

            // Trim history if too long
            if (this.conversationHistory.length > this.maxHistoryLength) {
                this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
            }

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
                this.conversationHistory,
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

            // Clean up and send done
            this.pendingRequests.delete(requestId);

            onDone({
                requestId,
                fullContent
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
