# Controller for GitHub Copilot

A VS Code extension that enables remote access to GitHub Copilot chat from mobile, desktop, and web clients.

## Installation

Install from VS Code Marketplace (coming soon) or from VSIX:

```bash
code --install-extension vscode-github-copilot-controller-0.0.1.vsix
```

## Usage

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run `Controller for GitHub Copilot: Start`
3. Run `Controller for GitHub Copilot: Copy Connection Info`
4. Use the connection info in your client app

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotController.autoStart` | `false` | Auto-start when VS Code opens |
| `copilotController.port` | `3712` | Port to listen on |
| `copilotController.authToken` | (auto) | Authentication token |

## Requirements

- VS Code 1.106.1 or higher
- GitHub Copilot extension

## License

[MIT](LICENSE) 