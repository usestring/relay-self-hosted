#!/usr/bin/env bash
# Generate a new 32-byte HMAC-SHA256 key for relay-server.
# relay-server treats 32-byte base64url values in `private_key` as HMAC-SHA256 keys.
# This key is used to both sign and verify document tokens.
set -euo pipefail

KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
KEY_ID="self-hosted-$(date +%Y-%m-%d)"

echo "New key (add to relay.toml [[auth]] block):"
echo ""
echo "[[auth]]"
echo "key_id = \"$KEY_ID\""
echo "private_key = \"$KEY\""
echo ""
echo "Keep this value secret — anyone with it can forge document tokens."
