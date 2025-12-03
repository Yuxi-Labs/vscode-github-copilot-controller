import * as assert from 'assert';
import {
    ClientMessage,
    ControllerMessage,
    ChatPayload,
    ChunkPayload,
    DonePayload,
    ErrorPayload,
    AuthMessage,
    AuthResponse
} from '../types';

suite('Types', () => {
    suite('ClientMessage', () => {
        test('chat message structure', () => {
            const msg: ClientMessage = {
                id: 'test-123',
                type: 'chat',
                payload: { message: 'Hello' } as ChatPayload
            };

            assert.strictEqual(msg.id, 'test-123');
            assert.strictEqual(msg.type, 'chat');
            assert.strictEqual((msg.payload as ChatPayload).message, 'Hello');
        });

        test('cancel message structure', () => {
            const msg: ClientMessage = {
                id: 'test-456',
                type: 'cancel',
                payload: { requestId: 'req-789' }
            };

            assert.strictEqual(msg.type, 'cancel');
        });

        test('ping message structure', () => {
            const msg: ClientMessage = {
                id: 'test-789',
                type: 'ping',
                payload: null
            };

            assert.strictEqual(msg.type, 'ping');
        });
    });

    suite('ControllerMessage', () => {
        test('chunk message structure', () => {
            const msg: ControllerMessage = {
                id: 'test-123',
                type: 'chunk',
                payload: {
                    requestId: 'req-123',
                    content: 'Hello',
                    index: 0
                } as ChunkPayload
            };

            assert.strictEqual(msg.type, 'chunk');
            assert.strictEqual((msg.payload as ChunkPayload).content, 'Hello');
        });

        test('done message structure', () => {
            const msg: ControllerMessage = {
                id: 'test-123',
                type: 'done',
                payload: {
                    requestId: 'req-123',
                    fullContent: 'Hello world'
                } as DonePayload
            };

            assert.strictEqual(msg.type, 'done');
            assert.strictEqual((msg.payload as DonePayload).fullContent, 'Hello world');
        });

        test('error message structure', () => {
            const msg: ControllerMessage = {
                id: 'test-123',
                type: 'error',
                payload: {
                    requestId: 'req-123',
                    code: 'TEST_ERROR',
                    message: 'Test error'
                } as ErrorPayload
            };

            assert.strictEqual(msg.type, 'error');
            assert.strictEqual((msg.payload as ErrorPayload).code, 'TEST_ERROR');
        });
    });

    suite('Authentication', () => {
        test('auth message structure', () => {
            const msg: AuthMessage = {
                type: 'auth',
                token: 'test-token-123'
            };

            assert.strictEqual(msg.type, 'auth');
            assert.strictEqual(msg.token, 'test-token-123');
        });

        test('auth response success', () => {
            const response: AuthResponse = {
                type: 'auth_result',
                success: true
            };

            assert.strictEqual(response.success, true);
            assert.strictEqual(response.error, undefined);
        });

        test('auth response failure', () => {
            const response: AuthResponse = {
                type: 'auth_result',
                success: false,
                error: 'Invalid token'
            };

            assert.strictEqual(response.success, false);
            assert.strictEqual(response.error, 'Invalid token');
        });
    });
});
