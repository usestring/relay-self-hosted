# Self-hosted Relay Server

Fully self-hosted Obsidian live collaboration — no dependency on relay.md's control plane.

## Stack

| Component | Port | What it does |
|---|---|---|
| `relay-server` | 8080 | CRDT sync engine (Rust, MIT-licensed fork of y-sweet) |
| `token-service` | 3000 | Issues doc tokens signed by our private key |
| `pocketbase` | 8090 | Auth backend — OAuth login (Google/GitHub/Discord) |

## Getting started

### 1. Start the stack

```bash
cd ~/relay-self-hosted
docker compose up -d
```

Wait for all three containers to be healthy (takes ~30s on first pull):

```bash
docker compose ps          # all three should show "healthy" or "running"
curl http://localhost:8080/ready   # → {"ok":true}
curl http://localhost:3000/health  # → {"status":"ok","relay":"http://relay-server:8080"}
curl http://localhost:8090/api/health  # → {"code":200,"message":"API is healthy."}
```

### 2. Configure PocketBase

Open http://localhost:8090/_/ in your browser and create the admin account.

Then go to Settings → Auth Providers and enable at least one OAuth provider (Google, GitHub, or Discord). You need OAuth credentials from the provider's developer console.

### 3. Sideload the plugin

```bash
VAULT=~/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/system3-relay"
cp ~/relay-self-hosted/relay-plugin/main.js "$VAULT/.obsidian/plugins/system3-relay/"
cp ~/relay-self-hosted/relay-plugin/manifest.json "$VAULT/.obsidian/plugins/system3-relay/"
```

Then in Obsidian:
1. Settings → Community Plugins → turn off Restricted Mode
2. Enable "Relay" in the installed plugins list
3. Run command palette: `Relay: Register self-hosted Relay Server`
4. Enter: `http://localhost:3000`

### 4. Log in and sync

In the Relay plugin sidebar, log in via PocketBase OAuth. Create a multiplayer folder. Open the same vault on a second device (repeat step 3, same server URL) and log in — edits sync in real time.

## Key management

The `relay.toml` `private_key` is a 32-byte HMAC-SHA256 key in base64url (no padding).
relay-server uses this key to sign and verify document tokens — no relay.md keys configured.

To rotate the key:
```bash
./keygen.sh   # prints a new [[auth]] block to paste into relay.toml
docker compose restart relay-server token-service
```

After rotating: active sessions need to re-authenticate (tokens signed with the old key are rejected).

## Rebuilding the plugin

If you want to point at a different host (e.g. a remote server):

```bash
cd ~/relay-self-hosted/relay-plugin
RELAY_API_URL=https://relay.example.com node esbuild.config.mjs
# Then re-copy main.js to each vault's plugin directory
```

## Architecture (token flow)

```
Obsidian plugin
  → POST /token to token-service (with PocketBase session JWT)
  → token-service validates JWT with PocketBase auth-refresh
  → token-service calls relay-server management API (POST /doc/:id/auth)
  → relay-server issues a doc-scoped CWT signed with private_key
  → token-service returns ClientToken to plugin
  → plugin opens WebSocket to relay-server with that CWT
  → relay-server validates CWT and opens the doc session
```

## Token microservice contract

The plugin POSTs to `${API_URL}/token` with:

```http
POST /token HTTP/1.1
Authorization: Bearer <pocketbase-session-jwt>
Content-Type: application/json

{
  "docId": "<document-uuid>",
  "relay": "<relay-id>",
  "folder": "<folder-id>",
  "device": "<device-id>"   // optional
}
```

Expected response (`ClientToken`):
```json
{
  "url": "ws://localhost:8080/doc/",
  "baseUrl": "http://localhost:8080",
  "docId": "<document-uuid>",
  "folder": "<folder-id>",
  "token": "<HMAC-SHA256 CWT signed by relay.toml private_key>",
  "authorization": "full",
  "expiryTime": 1234567890000
}
```

## Production checklist

- [ ] Replace `localhost` URLs with your server's hostname in `relay.toml` (`[server] url`) and rebuild the plugin
- [ ] Use Cloudflare R2 or S3 for storage instead of local filesystem (set `[store] type = "s3"` in relay.toml)
- [ ] Put token-service and PocketBase behind a reverse proxy (nginx/Caddy) with TLS
- [ ] Rotate the signing key and store it in a secret manager (not in relay.toml plaintext)
- [ ] Enable PocketBase OAuth providers in the admin UI

## Files

- `relay.toml` — relay-server config (our key, filesystem storage)
- `docker-compose.yml` — full stack (relay-server, token-service, pocketbase)
- `keygen.sh` — generates a new signing key
- `data/` — local document storage
- `pb_data/` — PocketBase database
- `relay-plugin/` — forked Obsidian plugin (patched build constants, built main.js)
- `token-service/` — Node.js token microservice source
