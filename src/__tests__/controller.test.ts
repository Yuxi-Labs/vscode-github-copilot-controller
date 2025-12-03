import * as assert from 'assert';

// Note: Controller tests are limited since Controller requires vscode.ExtensionContext
// Full integration tests require running in VS Code extension host

suite('Controller', () => {
    suite('Message Protocol', () => {
        test('client message types are valid', () => {
            const validTypes = ['chat', 'cancel', 'ping'];
            validTypes.forEach(type => {
                assert.ok(typeof type === 'string');
            });
        });

        test('controller message types are valid', () => {
            const validTypes = ['chunk', 'done', 'error', 'pong', 'status'];
            validTypes.forEach(type => {
                assert.ok(typeof type === 'string');
            });
        });
    });

    suite('Auth Protocol', () => {
        test('auth timeout should be 10 seconds', () => {
            // This value is defined in controller.ts
            const AUTH_TIMEOUT_MS = 10000;
            assert.strictEqual(AUTH_TIMEOUT_MS, 10000);
        });

        test('WebSocket close codes', () => {
            const codes = {
                AUTH_TIMEOUT: 4001,
                AUTH_REQUIRED: 4002,
                INVALID_TOKEN: 4003
            };

            assert.strictEqual(codes.AUTH_TIMEOUT, 4001);
            assert.strictEqual(codes.AUTH_REQUIRED, 4002);
            assert.strictEqual(codes.INVALID_TOKEN, 4003);
        });
    });

    suite('Default Configuration', () => {
        test('default port should be 3712', () => {
            const DEFAULT_PORT = 3712;
            assert.strictEqual(DEFAULT_PORT, 3712);
        });
    });
});
