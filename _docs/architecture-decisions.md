# Architecture Decisions

## Mode Implementation Strategy

### Core Principle: Surface vs Implement

**Don't duplicate. If a feature can be reached, we surface it. If not, we implement it, if we need it.**

### VS Code API Realities

**What's accessible (we surface these):**

*GitHub Copilot APIs:*
- `vscode.lm` - Language models (GPT-4, Claude, etc.)
- `vscode.chat` - Chat participant API (but can't invoke `@github` programmatically)

*VS Code APIs:*
- `vscode.workspace` - Workspace, files, folders, file system
- `vscode.window` - Editor, terminal, UI elements
- `vscode.commands` - Execute VS Code commands
- `vscode.env` - Environment, clipboard, shell
- `vscode.languages` - Language features, diagnostics, errors
- `vscode.debug` - Debug sessions
- `vscode.tasks` - Task execution
- `vscode.scm` - Source control (Git)
- `vscode.extensions` - Extension information
- `vscode.authentication` - Auth providers
- All standard VS Code extension APIs

**What's NOT accessible (we implement these):**
- `@github` participant - No API to invoke or hook into
- GitHub Copilot's mode behaviors - Internal to the extension
- GitHub Copilot's approval workflows - Not exposed

### Our Implementation

**We implement only what's necessary for remote control:**
- Mode behaviors via system prompts (can't access `@github`'s)
- Change approval workflow (ChangeBuffer for safety)
- Remote protocol (WebSocket/SSE)

### Change Approval Flow
```
Chat Request (with mode) 
    → LLM generates response (via vscode.lm)
    → Response parsed for action tags
    → Actions buffered in ChangeBuffer
    → pendingChange message sent to client
    → Client displays diff with Keep/Undo
    → User approves/rejects
    → Change applied or discarded
```

## Related Documents

- `design.md` - Overall architecture
- `cloudflare-tunnel-setup.md` - Secure remote access
- `secure-storage.md` - Token storage security

