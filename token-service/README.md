# Token Service

Bridges PocketBase auth to relay-server's management API and returns doc/file CWTs for the Obsidian Relay plugin.

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
| `RELAY_SERVER_AUTH` | required | Server-scoped CWT accepted by relay-server's `/doc/:id/auth` |
| `RELAY_TOML` | `../../relay.toml` | Path to relay.toml (for relay URL discovery) |
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

### `POST /file-token`
```
Authorization: Bearer <pocketbase-session-jwt>
Content-Type: application/json

{
  "docId": "...",
  "relay": "...",
  "folder": "...",
  "hash": "...",
  "contentType": "image/png",
  "contentLength": 1234
}
```
Returns a FileToken: a ClientToken plus `fileHash`.

## How it works

1. Verifies the PocketBase Bearer JWT via `${POCKETBASE_URL}/api/collections/users/auth-refresh`
2. Sends `RELAY_SERVER_AUTH` to `POST /doc/:docId/auth` on relay-server
3. Creates the doc first and retries when relay-server returns `404`
4. Returns the resulting ClientToken with `folder` + `expiryTime` added (fields the plugin expects beyond the relay-server shape)

## TODO before production

- [ ] Run PocketBase and wire up OAuth login (Google/GitHub/Discord)
- [ ] Add CORS headers scoped to the Obsidian origin if needed
