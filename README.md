# Self-hosted Relay Server

Fully self-hosted Obsidian live collaboration — no dependency on relay.md's control plane.

## Stack

| Component | Port | What it does |
|---|---|---|
| `relay-server` | 8080 | CRDT sync engine (Rust, MIT-licensed fork of y-sweet) |
| `token-service` | 3000 | Uses `RELAY_SERVER_AUTH` to ask relay-server for doc/file tokens |
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
- **`pb_hooks/relay_self_host.pb.js`** — implements `POST /api/collections/relays/self-host` (the `Relay: Register self-hosted server` command): auth-gated, creates the provider + relay + Owner `relay_role` + `storage_quota` + initial member invite, returns the relay enriched with the expands the plugin's `store.ingest` expects.
- **`pb_hooks/relay_runtime.pb.js`** — implements the remaining self-host control-plane calls needed for normal usage: `POST /api/accept-invitation`, `POST /api/self-host-rotate-key`, and `GET /api/self-host-relay-toml/:id`.
- **`pb_hooks/oauth2_code_exchange.pb.js`** — global middleware on `GET /api/oauth2-redirect` that persists a `code_exchange` row (`id = state.slice(0,15)`, `code = <auth code>`) so the plugin's **manual** OAuth code flow (`LoginManager.poll`) can read it back. Calls `next(c)` so PB's built-in handler still runs and the popup `authWithOAuth2`/SSE flow is untouched. Reconstructs relay.md's closed redirect handler.

Both are mounted into the pocketbase container (`./pb_migrations`, `./pb_hooks`) and auto-applied on `serve`.

> **PocketBase version pin.** The migrations + hook target the **v0.22.x** JS API (`Dao` / `Collection` / `SchemaField`, `$app.dao()`, `$apis.enrichRecord`). PocketBase v0.23 rewrote that API, so docker-compose pins `ghcr.io/muchobien/pocketbase:0.22.21`. Do not float to `:latest` without porting the migration/hook code to the new API.

### Verification status

- The stack has been live-smoked with Docker: PocketBase migrations/hooks applied, self-host relay registration created owner/member records, invitation acceptance worked, key rotation worked through `POST /api/self-host-rotate-key`, relay config download worked through `GET /api/self-host-relay-toml/:id`, `/token` and `/file-token` returned relay-server-issued tokens, and a headless WebSocket opened against the relay-server using a token minted by token-service.
- A throwaway bare Git repository was initialized and cloned into two Obsidian-style vault directories; the smoke copied the plugin artifact into `.obsidian/plugins/system3-relay`, committed the vault contents, cloned the second vault, and opened a relay WebSocket for a document in that Git-backed vault.
- Access rules are best-effort. They distinguish relay membership, folder membership, private-folder visibility, and owner-only mutation paths, but were inferred rather than copied from relay.md.
- `code_exchange` population is implemented by `pb_hooks/oauth2_code_exchange.pb.js`; OAuth providers still need credentials configured in the PB admin UI before browser login can be tested.
- PocketBase v0.22.21 reserves/catches some upstream-looking paths such as `POST /api/rotate-key` and `GET /api/collections/relays/records/:id/relay.toml`, so self-host management uses the non-conflicting paths listed above.

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

Relay-server needs two local auth materials:

1. An EdDSA server-auth keypair: put the public key in `relay.toml`, and put the matching server CWT in `.env` as `RELAY_SERVER_AUTH`.
2. A legacy 30-byte signing key: keep this as a second `[[auth]]` block so `/doc/:id/auth` can sign returned doc/file tokens.

Both blocks must include `allowed_token_types = ["document", "file", "server", "prefix"]`.

To rotate the legacy signing key:
```bash
./keygen.sh   # prints a new [[auth]] block to paste into relay.toml
docker compose restart relay-server token-service
```

To rotate the server-auth keypair, run relay-server's `gen-auth --json --key-type EdDSA`, update `relay.toml` with the new public key, update `.env` with the new `RELAY_SERVER_AUTH`, then recreate the stack.

## Rebuilding the plugin

If you want to point at a different host (e.g. a remote server):

```bash
cd ~/relay-self-hosted/relay-plugin
RELAY_API_URL=https://relay.example.com RELAY_AUTH_URL=https://auth.example.com node esbuild.config.mjs
# Then re-copy main.js to each vault's plugin directory
```

## Architecture (token flow)

```
Obsidian plugin
  → POST /token to token-service (with PocketBase session JWT)
  → token-service validates JWT with PocketBase auth-refresh
  → token-service calls relay-server management API (POST /doc/:id/auth) with RELAY_SERVER_AUTH
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
  "token": "<doc/file CWT returned by relay-server>",
  "authorization": "full",
  "expiryTime": 1234567890000
}
```

### `POST /file-token`

The plugin also calls `POST ${API_URL}/file-token` (see `relay-plugin/src/LiveTokenStore.ts`) to get a `FileToken` for attachment upload/download via the relay-server CAS endpoints (`/upload-url`, `/download-url`). The token-service implements this by authorizing the file doc ID through relay-server and returning the resulting ClientToken plus `fileHash`.

## Production checklist

- [ ] Replace `localhost` URLs with your server's hostname in `relay.toml` (`[server] url`) and rebuild the plugin
- [ ] Use Cloudflare R2 or S3 for storage instead of local filesystem (set `[store] type = "s3"` in relay.toml)
- [ ] Put token-service and PocketBase behind a reverse proxy (nginx/Caddy) with TLS
- [ ] Rotate auth/signing material and store secrets in a secret manager (not in plaintext local files)
- [ ] Enable PocketBase OAuth providers in the admin UI

For the cheap one-box deployment path, use `docker-compose.vm.yml` and follow
`docs/single-vm.md`. It runs Caddy, relay-server, token-service, and PocketBase
on one VM and only exposes ports 80/443.

## Files

- `relay.toml` — relay-server config (our key, filesystem storage)
- `docker-compose.yml` — full stack (relay-server, token-service, pocketbase)
- `docker-compose.vm.yml` — single-VM stack with Caddy TLS reverse proxy
- `deploy/Caddyfile` — routes API/auth/relay hostnames to internal services
- `keygen.sh` — generates a new signing key
- `pb_migrations/` — PocketBase control-plane schema (auto-applied on serve)
- `pb_hooks/` — PocketBase custom routes (`self-host`, invitation, key rotation, relay config, OAuth code exchange)
- `data/` — local document storage
- `pb_data/` — PocketBase database
- `relay-plugin/` — forked Obsidian plugin (patched build constants, built main.js)
- `token-service/` — Node.js token microservice source
