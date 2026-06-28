# Self-hosted Relay Server

Fully self-hosted Obsidian live collaboration — no dependency on relay.md's control plane.

## Stack

| Component | Port | What it does |
|---|---|---|
| `relay-server` | 8080 | CRDT sync engine (Rust, MIT-licensed fork of y-sweet) |
| `token-service` | 3000 | Issues doc tokens signed by our private key |
| `pocketbase` | 8090 | Auth backend + **control plane** — OAuth login AND relay/folder/membership records |

The plugin is built with two distinct endpoint constants (verified in `relay-plugin/src`):

| Build constant | Points at | Used for |
|---|---|---|
| `API_URL`  | token-service `:3000` | `POST /token`, `POST /file-token`, `GET /health` |
| `AUTH_URL` | PocketBase `:8090` | login, realtime, all `collection(...)` CRUD, `POST /api/collections/relays/self-host` |

`AUTH_URL` is where the plugin's PocketBase SDK client is created (`new PocketBase(getAuthUrl())` in `LoginManager.ts`). It must be PocketBase, **not** the token-service. (Earlier builds set both to `:3000`; fixed 2026-06-26 — rebuild with `RELAY_AUTH_URL=http://localhost:8090`.)

## PocketBase control plane (reverse-engineered)

`docker.system3.md/relay-server`'s upstream self-host template (`no-instructions/relay-server-template`) self-hosts **only the sync server + storage**; auth, login, doc-token minting, and the relay/folder control plane all stay on relay.md's hosted PocketBase (the template's `relay.toml` ships relay.md's **public keys**). Our goal — zero relay.md traffic — requires reimplementing that control plane locally, and a vanilla PocketBase image does **not** include it.

relay.md's PocketBase schema is not published in any open repo, so it was **reverse-engineered from the plugin's collection/field usage** (`relay-plugin/src`: the `*DAO` interfaces in `RelayManager.ts`, `DeviceManager.ts` device/vault creates, `LoginManager.ts` users/oauth2_response/code_exchange) and provisioned as:

- **`pb_migrations/1750000000_init_relay_control_plane.js`** — creates 12 collections: `roles` (seeded Owner/Member/Reader), `storage_quotas`, `providers`, `relays`, `shared_folders`, `relay_roles`, `shared_folder_roles`, `relay_invitations`, `subscriptions`, `devices`, `vaults`, `oauth2_response`, `code_exchange`. Each realtime-subscribed collection gets a non-null `listRule` so the plugin's `collection(...).subscribe("*")` SSE stream isn't admin-blocked.
- **`pb_migrations/1750000001_users_add_picture.js`** — adds the `picture` text field the plugin reads off the OAuth user (`name`/`email` already exist on PB's default `users` auth collection).
- **`pb_hooks/relay_self_host.pb.js`** — implements `POST /api/collections/relays/self-host` (the `Relay: Register self-hosted server` command): auth-gated, creates the provider + relay + Owner `relay_role` + `storage_quota`, returns the relay enriched with the expands the plugin's `store.ingest` expects.
- **`pb_hooks/oauth2_code_exchange.pb.js`** — global middleware on `GET /api/oauth2-redirect` that persists a `code_exchange` row (`id = state.slice(0,15)`, `code = <auth code>`) so the plugin's **manual** OAuth code flow (`LoginManager.poll`) can read it back. Calls `next(c)` so PB's built-in handler still runs and the popup `authWithOAuth2`/SSE flow is untouched. Reconstructs relay.md's closed redirect handler.

Both are mounted into the pocketbase container (`./pb_migrations`, `./pb_hooks`) and auto-applied on `serve`.

> **PocketBase version pin.** The migrations + hook target the **v0.22.x** JS API (`Dao` / `Collection` / `SchemaField`, `$app.dao()`, `$apis.enrichRecord`). PocketBase v0.23 rewrote that API, so docker-compose pins `ghcr.io/muchobien/pocketbase:0.22.21`. Do not float to `:latest` without porting the migration/hook code to the new API.

### Remaining gaps (not yet live-verified)

- **No live smoke test yet.** Written + static-validated (JS `node --check`, schema shape vs. the plugin's field usage) but **not** applied against a running PocketBase — Docker was not started (machine-mutation policy). First boot may surface API drift (e.g. `new URL` availability in goja, exact `$apis` signatures); the hook is defensively wrapped where that's likely.
- **Access rules are best-effort.** They scope visibility by membership via `relay_roles_via_relay` back-relations + creator, but were inferred, not copied from relay.md. Tighten/verify during the smoke test.
- **`code_exchange` population — RESOLVED.** The manual OAuth code flow row is now written by `pb_hooks/oauth2_code_exchange.pb.js` (redirect middleware), and `code_exchange.viewRule` is public so `LoginManager.poll`'s pre-auth `getOne` succeeds (the 15-char id is the high-entropy OAuth-state slice, so it doubles as the capability; `listRule` stays null to block enumeration). Both popup and manual flows should now work. Still untested live (needs Docker + OAuth provider creds).
- **OAuth providers still need credentials** (Google/GitHub/Discord console) configured in the PB admin UI before any login.

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

Open http://localhost:8090/_/ in your browser and create the admin account. On
first boot the mounted `pb_migrations/` auto-apply, so you should already see the
relay control-plane collections (`relays`, `shared_folders`, `relay_roles`, …)
under Collections, and the `roles` collection seeded with Owner/Member/Reader.

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
3. Run command palette: `Relay: Register self-hosted server`
4. Enter the **relay-server** URL: `http://localhost:8080`

   NOTE: this is the CRDT sync server (port 8080), not the token-service. The
   plugin POSTs this URL to `POST /api/collections/relays/self-host` on its
   PocketBase client (AUTH_URL, port 8090), which records it as the relay's host.

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

### Not yet implemented: `POST /file-token`

The plugin also calls `POST ${API_URL}/file-token` (see `relay-plugin/src/LiveTokenStore.ts`) to get a `FileToken` (a `ClientToken` plus a `fileHash`) for attachment upload/download via the relay-server CAS endpoints (`/upload-url`, `/download-url`). The token-service does **not** implement this yet — markdown-only sync works without it, but attachments will fail. Add it alongside `/token` in the next token-service increment.

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
- `pb_migrations/` — PocketBase control-plane schema (auto-applied on serve)
- `pb_hooks/` — PocketBase custom routes (the `self-host` registration endpoint)
- `data/` — local document storage
- `pb_data/` — PocketBase database
- `relay-plugin/` — forked Obsidian plugin (patched build constants, built main.js)
- `token-service/` — Node.js token microservice source
