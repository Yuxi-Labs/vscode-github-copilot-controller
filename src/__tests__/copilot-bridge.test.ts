import * as assert from 'assert';
import { CopilotBridge } from '../copilot-bridge';

suite('CopilotBridge', () => {
    let bridge: CopilotBridge;

    setup(() => {
        bridge = new CopilotBridge();
    });

    suite('getStatus', () => {
        test('initial status should have zero active requests', () => {
            const status = bridge.getStatus();
            
            assert.strictEqual(status.activeRequests, 0);
            assert.strictEqual(status.historyLength, 0);
        });
    });

    suite('clearHistory', () => {
        test('should clear conversation history', () => {
            bridge.clearHistory();
            const status = bridge.getStatus();
            
            assert.strictEqual(status.historyLength, 0);
        });
    });

    suite('cancelRequest', () => {
        test('should return false for non-existent request', () => {
            const result = bridge.cancelRequest('non-existent-id');
            
            assert.strictEqual(result, false);
        });
    });
});
