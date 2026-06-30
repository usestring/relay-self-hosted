#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
AUTH_JSON=$(docker compose -f "$COMPOSE_FILE" run --rm relay-server /app/relay gen-auth --json --key-type legacy)

KEY_ID=$(printf '%s\n' "$AUTH_JSON" | sed -n 's/.*"key_id": "\(.*\)".*/\1/p')
PRIVATE_KEY=$(printf '%s\n' "$AUTH_JSON" | sed -n 's/.*"private_key": "\(.*\)".*/\1/p')
SERVER_TOKEN=$(printf '%s\n' "$AUTH_JSON" | sed -n 's/.*"server_token": "\(.*\)".*/\1/p')

echo "Add to .env:"
echo "RELAY_SERVER_AUTH=$SERVER_TOKEN"
echo ""
echo "Add to relay.toml:"
echo "[[auth]]"
echo "key_id = \"$KEY_ID\""
echo "key_type = \"legacy\""
echo "private_key = \"$PRIVATE_KEY\""
echo "allowed_token_types = [\"document\", \"file\", \"server\", \"prefix\"]"
echo ""
echo "Keep both values secret."
