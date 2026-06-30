#!/usr/bin/env bash
# Generate the legacy signing key relay-server needs for /doc/:id/auth.
set -euo pipefail

KEY=$(openssl rand -base64 30 | tr '+/' '-_' | tr -d '=')
KEY_ID="self_hosted_legacy"

echo "New key (add to relay.toml [[auth]] block):"
echo ""
echo "[[auth]]"
echo "key_id = \"$KEY_ID\""
echo "key_type = \"hmac-sha256\""
echo "private_key = \"$KEY\""
echo "allowed_token_types = [\"document\", \"file\", \"server\", \"prefix\"]"
echo ""
echo "Keep this value secret — anyone with it can forge document tokens."
