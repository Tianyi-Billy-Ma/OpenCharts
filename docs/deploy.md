# Deploying on a server with Cloudflare Tunnel

This guide runs OpenCharts on an always-on Linux machine as a systemd user
service. It is published through a Cloudflare Tunnel on two hostnames:

| Hostname | Serves | Gate |
| --- | --- | --- |
| `charts.example.com` | The terminal | Cloudflare Access (your email only) |
| `mcp.example.com` | `/mcp` only, for your bots | The MCP bearer token |

The tunnel only makes outbound connections, so no port opens on the server.
Replace `example.com` with your own domain on Cloudflare.

If you already run nginx on a public server behind Cloudflare, you can use it
instead of a tunnel. See [Without a tunnel](#without-a-tunnel-nginx-on-another-server)
at the end; steps 1, 2, 4 and 5 stay the same.

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

Then list the hostname in `opencharts.config.ts`, so the terminal's account and order routes answer on it (they refuse unknown hostnames, which stops DNS-rebinding pages):

```ts
export default {
  allowedHosts: ["charts.example.com"],
};
```

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

## Without a tunnel: nginx on another server

Use this when your sites already go through Cloudflare's proxy (orange-cloud
DNS records) to an nginx server with a public IP, and OpenCharts runs on a
different machine with no public IP. nginx forwards to it over
[Tailscale](https://tailscale.com), so the backend is never on the internet.

```text
browser or bot -> Cloudflare -> nginx (public server) -> Tailscale -> OpenCharts (port 8787)
```

### On the OpenCharts machine

The backend binds to 127.0.0.1 by default, which nginx on another machine
cannot reach. Bind it to the machine's Tailscale address in
`opencharts.config.ts`:

```ts
export default {
  host: "100.x.y.z", // from `tailscale ip -4` on this machine
};
```

Then restart the service. Anyone who can reach that address and port gets
the terminal without the Access login, so open it to the nginx server only.
In the Tailscale admin console, under **Access controls**, add a rule like:

```json
{ "action": "accept", "src": ["tag:proxy"], "dst": ["tag:opencharts:8787"] }
```

Use your own tags or machine names. From the nginx server,
`curl -s http://100.x.y.z:8787/api/health` should now answer.

### On the nginx server

1. In Cloudflare DNS, add `charts` and `mcp` as proxied (orange cloud) A
   records pointing at the nginx server.
2. Set **SSL/TLS** to **Full (strict)**, and create an **Origin Certificate**
   for `charts.example.com` and `mcp.example.com` under
   **SSL/TLS → Origin Server**. Save the certificate and key on the server.
3. Only accept connections from Cloudflare, or anyone who finds the server's
   IP can skip Access. Allow [Cloudflare's IP ranges](https://www.cloudflare.com/ips/)
   in the firewall, or with an nginx `geo` block as below.
4. Add `/etc/nginx/sites-enabled/opencharts`:

```nginx
# 1 when the connection comes from Cloudflare. Fill in every range from
# https://www.cloudflare.com/ips/ and keep the list up to date.
geo $realip_remote_addr $opencharts_from_cloudflare {
    default 0;
    173.245.48.0/20 1;
    # ...the other Cloudflare ranges...
}

server {
    listen 443 ssl http2;
    server_name charts.example.com;
    ssl_certificate     /etc/ssl/cloudflare/example.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/example.com.key;
    if ($opencharts_from_cloudflare = 0) { return 403; }

    location / {
        proxy_pass http://100.x.y.z:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Live prices are a Server-Sent Events stream: no buffering, long reads.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}

server {
    listen 443 ssl http2;
    server_name mcp.example.com;
    ssl_certificate     /etc/ssl/cloudflare/example.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/example.com.key;
    if ($opencharts_from_cloudflare = 0) { return 403; }

    # Only the MCP endpoint is published on this hostname.
    location = /mcp {
        proxy_pass http://100.x.y.z:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
    location / { return 404; }
}
```

Run `sudo nginx -t && sudo systemctl reload nginx`. Then put
`charts.example.com` behind Cloudflare Access (step 4) and check it (step 5).
