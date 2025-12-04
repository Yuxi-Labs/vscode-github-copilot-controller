import * as vscode from 'vscode';

/**
 * Simple model tracker - uses client-requested model or falls back to first available.
 */
export class ModelTracker {
    private static instance: ModelTracker | null = null;
    private outputChannel: vscode.OutputChannel | null = null;

    private constructor() {}

    static getInstance(): ModelTracker {
        if (!ModelTracker.instance) {
            ModelTracker.instance = new ModelTracker();
        }
        return ModelTracker.instance;
    }

    /**
     * Initialize the model tracker
     */
    initialize(outputChannel?: vscode.OutputChannel): void {
        this.outputChannel = outputChannel || null;
        this.log('[ModelTracker] Initialized');
    }

    /**
     * Get model for request - uses client-requested model or first available
     */
    async getModelForRequest(requestedModel?: string): Promise<vscode.LanguageModelChat | null> {
        try {
            // Get ALL available models, not just from 'copilot' vendor
            const models = await vscode.lm.selectChatModels();

            if (models.length === 0) {
                this.log('[ModelTracker] No models available');
                return null;
            }

            this.log(`[ModelTracker] Available models: ${models.map(m => `${m.name} (${m.id}, vendor: ${m.vendor})`).join(', ')}`);

            // Client explicitly requested a specific model
            if (requestedModel) {
                const match = this.findModelMatch(models, requestedModel);
                if (match) {
                    this.log(`[ModelTracker] Using requested model: ${match.name} (${match.id})`);
                    return match;
                }
                this.log(`[ModelTracker] Requested model "${requestedModel}" not found, using default`);
            }

            // Fallback to first available
            this.log(`[ModelTracker] Using default model: ${models[0].name}`);
            return models[0];

        } catch (err) {
            this.log(`[ModelTracker] Error: ${err}`);
            return null;
        }
    }    /**
     * Find a model that matches the given ID
     */
    private findModelMatch(models: vscode.LanguageModelChat[], modelId: string): vscode.LanguageModelChat | null {
        this.log(`[ModelTracker] Looking for model: "${modelId}"`);
        this.log(`[ModelTracker] Available models: ${models.map(m => `"${m.id}" (name: ${m.name}, family: ${m.family})`).join(', ')}`);
        
        // Direct ID match
        let match = models.find(m => m.id === modelId);
        if (match) {
            this.log(`[ModelTracker] Direct ID match found: ${match.id}`);
            return match;
        }

        // ID contains the modelId
        match = models.find(m => m.id.includes(modelId));
        if (match) {
            this.log(`[ModelTracker] ID contains match found: ${match.id}`);
            return match;
        }

        // modelId contains the model's ID (reverse check)
        match = models.find(m => modelId.includes(m.id));
        if (match) {
            this.log(`[ModelTracker] Reverse ID match found: ${match.id}`);
            return match;
        }

        // Family contains the modelId
        match = models.find(m => m.family.includes(modelId));
        if (match) {
            this.log(`[ModelTracker] Family match found: ${match.id}`);
            return match;
        }

        // Name contains the modelId (case insensitive)
        const lowerModelId = modelId.toLowerCase();
        match = models.find(m => m.name.toLowerCase().includes(lowerModelId));
        if (match) {
            this.log(`[ModelTracker] Name match found: ${match.id}`);
            return match;
        }

        // modelId contains the model's name (case insensitive, reverse check)
        match = models.find(m => lowerModelId.includes(m.name.toLowerCase()));
        if (match) {
            this.log(`[ModelTracker] Reverse name match found: ${match.id}`);
            return match;
        }

        this.log(`[ModelTracker] No match found for "${modelId}"`);
        return null;
    }

    /**
     * List available models
     */
    async listModels(): Promise<Array<{ id: string; name: string; vendor: string; family: string }>> {
        try {
            // Get ALL available models, not just from 'copilot' vendor
            const models = await vscode.lm.selectChatModels();
            this.log(`[ModelTracker] Listing ${models.length} models`);
            return models.map(m => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family }));
        } catch (err) {
            this.log(`[ModelTracker] Error listing models: ${err}`);
            return [];
        }
    }

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
    }

    dispose(): void {
        ModelTracker.instance = null;
    }
}
