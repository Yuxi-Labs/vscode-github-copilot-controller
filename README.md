# Controller for GitHub Copilot

Controller for GitHub Copilot is a Visual Studio Code extension that provides orchestration services for the Remote Pilot for GitHub Copilot mobile and desktop applications.

## What It Does

This extension lets you chat with GitHub Copilot from your phone, tablet, or another computer — as if you were typing directly into VS Code. The controller runs in VS Code and accepts connections from Remote Pilot client apps.

## Features

- **Real-time bidirectional communication** with Copilot via WebSocket or SSE
- **Multiple connection methods** for different network situations
- **Token-based authentication** for secure access
- **Multiple simultaneous clients** supported
- **Conversation history** maintained across messages

## Installation

1. Install from VS Code Marketplace (coming soon)
2. Or build from source: `npm install && npm run compile`

### Installing from VSIX

```powershell
& "C:\Program Files\Microsoft VS Code\bin\code.cmd" --install-extension vscode-github-copilot-controller-0.0.1.vsix
```

## Usage

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run `Copilot Controller: Start`
3. Run `Copilot Controller: Copy Connection Info`
4. Use the connection info in your Remote Pilot client app

## Commands

| Command | Description |
|---------|-------------|
| `Copilot Controller: Start` | Start the controller |
| `Copilot Controller: Stop` | Stop the controller |
| `Copilot Controller: Show Status` | Show connection info and status |
| `Copilot Controller: Copy Connection Info` | Copy connection details to clipboard |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotController.autoStart` | `false` | Auto-start when VS Code opens |
| `copilotController.port` | `3712` | Port to listen on |
| `copilotController.authToken` | (auto) | Auth token (auto-generated if empty) |
| `copilotController.tunnelUrl` | `""` | External tunnel URL for remote access |
| `copilotController.allowedOrigins` | `["*"]` | CORS allowed origins |

## Connection Methods

### Local Network (Same WiFi)
Connect directly to your computer's IP address and port.

### Remote Access
Use VS Code's built-in port forwarding or your own tunnel (ngrok, Cloudflare, etc.) to access from anywhere.

## Client Apps

Remote Pilot client apps for mobile, desktop, and web are available separately.

## Requirements

- VS Code 1.106.1 or higher
- GitHub Copilot extension installed and signed in

## License

[MIT](LICENSE) 