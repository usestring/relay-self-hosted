# Token Service

Issues doc-scoped CWTs for the Obsidian Relay plugin, bridging PocketBase auth and relay-server's management API.

## Run locally

```bash
npm install
npm start
# or for dev with auto-reload:
npm run dev
```

Reads `../relay.toml` by default (override with `RELAY_TOML=/path/to/relay.toml`).

## Env vars

| Var | Default | Description |
|-----|---------|-------------|
| `PORT` | `3000` | Listen port |
| `RELAY_URL` | from relay.toml | relay-server URL |
| `RELAY_TOML` | `../../relay.toml` | Path to relay.toml (for private key + key ID) |
| `POCKETBASE_URL` | `http://localhost:8090` | PocketBase instance URL |

## Endpoints

### `GET /health`
Returns `{ status: "ok", relay: "<relay-url>" }`.

### `POST /token`
```
Authorization: Bearer <pocketbase-session-jwt>
Content-Type: application/json

{ "docId": "...", "relay": "...", "folder": "...", "device": "..." }
```
Returns a ClientToken the plugin sends to relay-server's WebSocket.

## How it works

1. Verifies the PocketBase Bearer JWT (**currently stubbed** — accepts any non-empty token; wire up real PocketBase validation once PocketBase is running)
2. Generates a server-scoped CWT (COSE_Mac0, HMAC-SHA256/64) signed with the private key from `relay.toml`
3. Calls `POST /doc/:docId/auth` on relay-server with that server token
4. Returns the resulting ClientToken with `folder` + `expiryTime` added (fields the plugin expects beyond the relay-server shape)

## TODO before production

- [ ] Replace the PocketBase token stub with a real validation call to `${POCKETBASE_URL}/api/collections/users/auth-refresh`
- [ ] Run PocketBase and wire up OAuth login (Google/GitHub/Discord)
- [ ] Serve the PocketBase login proxy on `AUTH_URL` so the plugin's login flow works end-to-end
- [ ] Add CORS headers scoped to the Obsidian origin if needed
