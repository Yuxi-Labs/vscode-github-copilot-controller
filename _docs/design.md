# Controller for GitHub Copilot - Design Document

## Overview

This VS Code extension acts as a **controller** (not a server) that enables remote, real-time, bidirectional communication with GitHub Copilot from external client applications (mobile, desktop, web).

## Problem Statement

When physically at your desktop, you chat with Copilot inside VS Code. When away (living room, work, coffee shop), you want to continue the **exact same conversation** with the **same Copilot instance** in real-time from a phone or laptop.

## Core Requirement

Remote real-time, bidirectional chat with the Copilot chat session running in VS Code — as if you were typing directly into Copilot's chat box.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code Desktop                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Controller Extension                        │    │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │    │
│  │  │  WebSocket  │    │     SSE     │    │   Copilot   │  │    │
│  │  │   Handler   │    │   Handler   │    │   Bridge    │  │    │
│  │  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘  │    │
│  │         │                  │                  │          │    │
│  │         └────────────┬─────┴──────────────────┘          │    │
│  │                      │                                    │    │
│  │              ┌───────▼───────┐                           │    │
│  │              │ VS Code LM API │ (vscode.lm)              │    │
│  │              └───────┬───────┘                           │    │
│  └──────────────────────┼───────────────────────────────────┘    │
│                         │                                        │
│                 ┌───────▼───────┐                                │
│                 │ GitHub Copilot │                               │
│                 └───────────────┘                                │
└─────────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
    │  Mobile   │   │  Desktop  │   │    Web    │
    │   App     │   │    App    │   │    App    │
    └───────────┘   └───────────┘   └───────────┘
         (Remote Pilot client applications)
```

## Connection Methods

The controller supports multiple real-time connection methods. Client apps can choose based on their situation:

### 1. WebSocket (Primary)
- Full duplex, real-time streaming
- Best for persistent connections
- Path: `/ws`

### 2. SSE + HTTP POST (Fallback)
- SSE for streaming responses from controller → client
- HTTP POST for sending messages from client → controller
- Still real-time, just split channels
- Paths: `/sse` (stream), `/message` (send)

### 3. Tunnel Support
For remote access outside local network:
- **VS Code Port Forwarding** - Built-in, free with GitHub account
- **Manual Tunnel URL** - User provides their own (ngrok, Cloudflare, etc.)
- Future: Yuxi-Labs hosted relay service

**No polling** - all methods are real-time push-based.

## Connection Scenarios

| Location | Method |
|----------|--------|
| Same WiFi (home) | Direct connection to `192.168.x.x:port` |
| Different network (work, mobile data) | Via tunnel URL |

## Authentication

- Auto-generated token on first start (stored in VS Code global state)
- Token required for all connections
- Sent via:
  - WebSocket: First message after connect
  - SSE/HTTP: `Authorization: Bearer <token>` header or `?token=` query param

## Message Protocol

### Client → Controller

```typescript
interface ClientMessage {
    id: string;        // Unique message ID
    type: 'chat' | 'cancel' | 'ping';
    payload: unknown;
}
```

### Controller → Client

```typescript
interface ControllerMessage {
    id: string;        // Matches request ID
    type: 'chunk' | 'done' | 'error' | 'pong' | 'status';
    payload: unknown;
}
```

### Chat Flow

1. Client sends: `{ id: "abc", type: "chat", payload: { message: "Hello" } }`
2. Controller streams: `{ id: "abc", type: "chunk", payload: { content: "Hi" } }`
3. Controller streams: `{ id: "abc", type: "chunk", payload: { content: " there!" } }`
4. Controller finishes: `{ id: "abc", type: "done", payload: { fullContent: "Hi there!" } }`

## Extension Commands

| Command | Description |
|---------|-------------|
| `Copilot Controller: Start` | Start the controller |
| `Copilot Controller: Stop` | Stop the controller |
| `Copilot Controller: Show Status` | Show connection info and status |
| `Copilot Controller: Copy Connection Info` | Copy connection details for client apps |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotController.autoStart` | `false` | Auto-start when VS Code opens |
| `copilotController.port` | `3712` | Port to listen on |
| `copilotController.authToken` | (auto) | Auth token (auto-generated if empty) |
| `copilotController.tunnelUrl` | `""` | External tunnel URL for display/copy |
| `copilotController.allowedOrigins` | `["*"]` | CORS allowed origins |

## File Structure

```
src/
├── extension.ts        # Extension entry point, commands
├── controller.ts       # Main controller (WebSocket + SSE handlers)
├── copilot-bridge.ts   # Interface to VS Code Language Model API
└── types.ts            # Message types and interfaces
```

## Security Considerations

- Auth token required for all connections
- Token stored in VS Code global state (encrypted by VS Code)
- CORS configurable for allowed origins
- Connection timeout for unauthenticated WebSocket clients

## Future Considerations

- Yuxi-Labs hosted relay service for easier remote access
- Multiple simultaneous client connections
- Conversation history sync across clients
- End-to-end encryption option
