# Cloudflare Tunnel Setup for Remote Access

This guide explains how to expose your Controller for GitHub Copilot to the internet using Cloudflare Tunnel, allowing you to connect from anywhere (different networks, mobile data, etc.).

## Prerequisites

- A Cloudflare account (free tier works fine)
- Your VS Code with the Controller for GitHub Copilot extension running
- The extension listening on `localhost:3712` (default)

## Step 1: Install cloudflared

### Windows (PowerShell)
```powershell
# Download the installer
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "$env:USERPROFILE\cloudflared.exe"

# Add to PATH (optional, for easier access)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$userPath;$env:USERPROFILE", "User")
```

Or use Chocolatey:
```powershell
choco install cloudflared
```

### macOS
```bash
brew install cloudflared
```

### Linux
```bash
# Debian/Ubuntu
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# Or use package manager if available
```

## Step 2: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This will:
1. Open a browser window
2. Ask you to log in to Cloudflare
3. Select a domain (or use a free subdomain)
4. Save credentials to `~/.cloudflared/cert.pem`

## Step 3: Create a Tunnel

```bash
# Create a named tunnel
cloudflared tunnel create copilot-controller

# This creates a tunnel and saves the credentials
# Note the Tunnel ID shown in the output
```

## Step 4: Configure the Tunnel

Create a config file at `~/.cloudflared/config.yml`:

```yaml
tunnel: copilot-controller
credentials-file: ~/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: copilot-controller.yourdomain.com
    service: http://localhost:3712
  - service: http_status:404
```

**Replace:**
- `<TUNNEL-ID>` with the ID from step 3
- `yourdomain.com` with your Cloudflare domain (or use `<tunnel-name>.cfargotunnel.com` for free subdomain)

## Step 5: Create DNS Record

```bash
# Point your domain to the tunnel
cloudflared tunnel route dns copilot-controller copilot-controller.yourdomain.com
```

Or if using free subdomain, it's automatically created as:
```
https://<TUNNEL-ID>.cfargotunnel.com
```

## Step 6: Run the Tunnel

### Quick Test (temporary)
```bash
cloudflared tunnel --url http://localhost:3712
```
This gives you a temporary URL like: `https://random-words-1234.trycloudflare.com`

### Permanent Tunnel (recommended)
```bash
cloudflared tunnel run copilot-controller
```

### Run as Background Service

#### Windows
```powershell
cloudflared service install
cloudflared service start
```

#### macOS/Linux
```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

## Step 7: Connect from Remote Pilot

1. **Start VS Code with Controller for GitHub Copilot extension**
2. **Start the Cloudflare tunnel** (if not running as service)
3. **In Remote Pilot app:**
   - Open Settings (File → Settings)
   - Set Connection URL to: `wss://copilot-controller.yourdomain.com/ws`
   - Note: Use `wss://` (secure WebSocket) instead of `ws://`
   - Enter your auth token
   - Click Save and connect

## Security Notes

- Cloudflare Tunnel provides automatic HTTPS/WSS encryption
- Your controller is never directly exposed - traffic goes through Cloudflare's network
- The auth token is still required for authentication
- Consider using Cloudflare Access for additional authentication layers

## Troubleshooting

### Tunnel starts but can't connect
- Verify Controller for GitHub Copilot is running: `Controller for GitHub Copilot: Show Status`
- Check the tunnel is routing to correct port (3712)
- Ensure WebSocket upgrade is working (Cloudflare handles this automatically)

### Connection refused
- Extension might not be started: Run `Controller for GitHub Copilot: Start`
- Check firewall isn't blocking local port 3712
- Verify tunnel config points to `http://localhost:3712` (not https)

### Certificate errors
- Make sure you're using `wss://` (not `ws://`) in Remote Pilot settings
- Cloudflare provides valid SSL certificates automatically

## Quick Start Script

Save this as `start-tunnel.ps1` (Windows) or `start-tunnel.sh` (Mac/Linux):

```powershell
# Windows PowerShell
Write-Host "Starting Cloudflare Tunnel for Controller for GitHub Copilot..." -ForegroundColor Green

# Quick temporary tunnel (no setup required)
cloudflared tunnel --url http://localhost:3712

# Or use your configured tunnel:
# cloudflared tunnel run copilot-controller
```

```bash
#!/bin/bash
# Mac/Linux
echo "Starting Cloudflare Tunnel for Controller for GitHub Copilot..."

# Quick temporary tunnel (no setup required)
cloudflared tunnel --url http://localhost:3712

# Or use your configured tunnel:
# cloudflared tunnel run copilot-controller
```

## Example Workflow

1. **At your desk:**
   ```powershell
   # Start VS Code, open your project
   code .
   
   # Start the tunnel (in a separate terminal)
   cloudflared tunnel run copilot-controller
   # Or for quick test: cloudflared tunnel --url http://localhost:3712
   ```

2. **From living room/mobile:**
   - Open Remote Pilot app
   - Connect to `wss://copilot-controller.yourdomain.com/ws`
   - Continue working with Copilot and terminals running on your desktop

3. **Done working:**
   - Close Remote Pilot
   - Stop tunnel: `Ctrl+C` or `cloudflared service stop`
   - VS Code keeps running on desktop

## Advanced: Multiple Controllers

If you have multiple machines, create separate tunnels:

```bash
cloudflared tunnel create desktop-copilot
cloudflared tunnel create laptop-copilot

# Route to different subdomains
cloudflared tunnel route dns desktop-copilot desktop.copilot.yourdomain.com
cloudflared tunnel route dns laptop-copilot laptop.copilot.yourdomain.com
```

## Cost

- **Cloudflare Tunnel: FREE** ✅
- No bandwidth limits
- No connection limits
- Included in free Cloudflare plan
