# Single-VM Deployment

This is the cheap deployment path: one VM runs Caddy, relay-server,
token-service, and PocketBase with Docker Compose. It is intended for pilots and
dogfood, not high availability.

## DNS

Point three hostnames at the VM's public IP:

- `api.example.com` -> token-service
- `auth.example.com` -> PocketBase
- `relay.example.com` -> relay-server

Caddy automatically provisions Let's Encrypt certificates for those names.

## VM prerequisites

Install Docker and the Docker Compose plugin on the VM. Open inbound TCP 80 and
443 in the VM firewall/security group. No app service port needs to be public.

## Configure

Copy the examples:

```bash
cp .env.vm.example .env
cp relay.vm.toml.example relay.toml
```

Edit `.env`:

```dotenv
API_DOMAIN=api.example.com
AUTH_DOMAIN=auth.example.com
RELAY_DOMAIN=relay.example.com
RELAY_SERVER_AUTH=REPLACE_WITH_GENERATED_AUTH_TOKEN
```

Edit `relay.toml`:

```toml
[server]
url = "https://relay.example.com"
```

## Generate relay auth material

Generate one legacy auth set:

```bash
docker compose -f docker-compose.vm.yml run --rm relay-server /app/relay gen-auth --json --key-type legacy
```

Put the returned `server_token` in `.env` as `RELAY_SERVER_AUTH`. Put the
returned `key_id` and `private_key` in the single `[[auth]]` block in
`relay.toml`, and keep `key_type = "legacy"`.

## Start

```bash
docker compose -f docker-compose.vm.yml up -d
docker compose -f docker-compose.vm.yml ps
```

Health checks:

```bash
curl https://api.example.com/health
curl https://auth.example.com/api/health
```

The relay root may return 404. That is fine; the plugin uses WebSocket and relay
document endpoints, not `/`.

## First PocketBase setup

Open:

```text
https://auth.example.com/_/
```

Create the PocketBase admin account, then configure at least one auth provider
under Settings -> Auth Providers. The Obsidian plugin uses this PocketBase auth
state for login and token authorization.

## Build the plugin

Build the plugin against the VM domains:

```bash
cd relay-plugin
RELAY_API_URL=https://api.example.com \
RELAY_AUTH_URL=https://auth.example.com \
node esbuild.config.mjs
```

When registering a self-hosted relay from Obsidian, use:

```text
https://relay.example.com
```

## Data and backups

Stateful data lives in:

- `pb_data/` - PocketBase auth/control-plane database
- `data/` - relay document/file data when using filesystem storage
- Caddy's named Docker volumes - TLS certificates and Caddy state

For a single VM, the minimum useful backup is `pb_data/`, `data/`, `.env`, and
`relay.toml`.

## Updating

```bash
git pull
docker compose -f docker-compose.vm.yml pull
docker compose -f docker-compose.vm.yml up -d
```

If auth material changes, restart token-service and relay-server:

```bash
docker compose -f docker-compose.vm.yml restart relay-server token-service
```
