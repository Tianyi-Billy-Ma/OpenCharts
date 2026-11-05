# Deploying on a server with Cloudflare Tunnel

This guide runs OpenCharts on an always-on Linux machine as a systemd user
service. It is published through a Cloudflare Tunnel on two hostnames:

| Hostname | Serves | Gate |
| --- | --- | --- |
| `charts.example.com` | The terminal | Cloudflare Access (your email only) |
| `mcp.example.com` | `/mcp` only, for your bots | The MCP bearer token |

The tunnel only makes outbound connections, so no port opens on the server.
Replace `example.com` with your own domain on Cloudflare.

## 1. Install and configure

```bash
git clone https://github.com/<you>/OpenCharts.git ~/OpenCharts
cd ~/OpenCharts
npm ci
npm run build:desk
cp .env.example .env
chmod 600 .env
```

Fill in `.env`:

- **Alpaca keys:** use the paper keys.
- **MCP tokens:** set `OPENCHARTS_MCP_TOKEN` and `OPENCHARTS_RISK_TOKEN`, each from `openssl rand -hex 32`.
- **Webhooks:** set the webhook URLs and secret, if you want them.

Edit `opencharts.config.ts` for your watchlist and rules.

## 2. Run as a systemd user service

Find Node 22.18 or newer with `which node`, then create
`~/.config/systemd/user/opencharts.service`:

```ini
[Unit]
Description=OpenCharts backend
After=network-online.target

[Service]
WorkingDirectory=%h/OpenCharts
ExecStart=/usr/bin/node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Change `/usr/bin/node` if `which node` printed another path. Then start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencharts
loginctl enable-linger "$USER"   # keep it running after you log out
journalctl --user -u opencharts -f
curl -s http://127.0.0.1:8787/api/health
```

To update later: `git pull && npm ci && npm run build:desk && systemctl --user restart opencharts`.
Approvals and signals are in `data/opencharts.db`, so back that file up.

## 3. Create the tunnel

Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run:

```bash
cloudflared tunnel login
cloudflared tunnel create opencharts
cloudflared tunnel route dns opencharts charts.example.com
cloudflared tunnel route dns opencharts mcp.example.com
```

Write `~/.cloudflared/config.yml`, with the tunnel ID that `create` printed:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: charts.example.com
    service: http://127.0.0.1:8787
  # Only the MCP endpoint is reachable on this hostname.
  - hostname: mcp.example.com
    path: ^/mcp$
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run it as a service with
`sudo cloudflared --config /home/<user>/.cloudflared/config.yml service install`,
or as a second systemd user unit with
`ExecStart=/usr/bin/cloudflared tunnel run opencharts`.

## 4. Put the terminal behind Cloudflare Access

In the Cloudflare Zero Trust dashboard, go to **Access → Applications → Add an application → Self-hosted**:

- **Domain:** `charts.example.com`.
- **Policy:** Allow, with the rule *Emails* set to your own address.

Do not add `mcp.example.com` to Access. Bots cannot complete a browser login, and the bearer token already guards that hostname.

## 5. Check it

```bash
curl -sI https://charts.example.com/ | head -1         # a redirect to the Access login
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp   # 401 without a token
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.example.com/api/health    # 404: only /mcp is published
```

Point your bots' MCP client at `https://mcp.example.com/mcp`, with the header
`Authorization: Bearer <token>` (see the MCP section in
[self-hosting.md](self-hosting.md)). Only the Risk Officer gets the risk token.
