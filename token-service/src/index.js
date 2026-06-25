import express from 'express';
import crypto from 'crypto';
import { encode, Tag } from 'cbor2';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

function loadConfig() {
  const tomlPath = process.env.RELAY_TOML || join(__dirname, '../../relay.toml');
  const toml = readFileSync(tomlPath, 'utf8');

  // Pull private_key and key_id from [[auth]] block
  const keyMatch = toml.match(/private_key\s*=\s*"([^"]+)"/);
  const kidMatch = toml.match(/key_id\s*=\s*"([^"]+)"/);
  const urlMatch = toml.match(/url\s*=\s*"([^"]+)"/);

  if (!keyMatch) throw new Error('private_key not found in relay.toml');

  return {
    privateKey: Buffer.from(keyMatch[1], 'base64url'),
    keyId: kidMatch ? kidMatch[1] : 'default',
    relayUrl: process.env.RELAY_URL || urlMatch?.[1] || 'http://localhost:8080',
    port: parseInt(process.env.PORT || '3000', 10),
    pocketbaseUrl: process.env.POCKETBASE_URL || 'http://localhost:8090',
  };
}

const config = loadConfig();

// --- CWT / COSE_Mac0 ---
// Implements COSE_Mac0 with HMAC-SHA256/64 (8-byte truncated tag) per RFC 8152.
// relay-server validates tokens using coset::iana::Algorithm::HMAC_256_64 (value 4).

const COSE_ALG_HMAC_256_64 = 4;

function buildCwtClaims(scope, expSeconds = 3600) {
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  const expSecs = nowSecs + BigInt(expSeconds);
  // CWT standard claims: 4=exp, 6=iat; custom "scope" key
  return new Map([
    [4, expSecs],
    [6, nowSecs],
    ['scope', scope],
  ]);
}

function signCoseMac0(payload, protectedHeaderBytes, privateKey) {
  // MAC_Structure = ["MAC0", protected_bstr, external_aad, payload] per RFC 8152 §6.3
  const macStructure = ['MAC0', protectedHeaderBytes, new Uint8Array(0), payload];
  const macData = encode(macStructure);
  const hmac = crypto.createHmac('sha256', privateKey);
  hmac.update(macData);
  return hmac.digest().subarray(0, 8); // truncate to 64 bits
}

function createServerToken() {
  const claims = buildCwtClaims('server');
  const payload = encode(claims);

  // Protected header: { 1: alg, 4: kid }
  const protectedHeader = new Map([
    [1, COSE_ALG_HMAC_256_64],
    [4, new TextEncoder().encode(config.keyId)],
  ]);
  const protectedHeaderBytes = encode(protectedHeader);

  const tag = signCoseMac0(payload, protectedHeaderBytes, config.privateKey);

  // COSE_Mac0 array: [protected_bstr, unprotected_map, payload, mac_tag]
  const coseMac0 = [protectedHeaderBytes, new Map(), payload, tag];

  // Encode: Tag(61, Tag(17, coseMac0))
  const withCoseTag = new Tag(17, coseMac0);
  const withCwtTag = new Tag(61, withCoseTag);
  const bytes = encode(withCwtTag);

  return Buffer.from(bytes).toString('base64url');
}

// --- PocketBase JWT verification ---
// Validates a PocketBase session token by calling PocketBase's auth-refresh endpoint.
// Falls back to JWT-decode-only if POCKETBASE_URL is not set (dev convenience).

function extractUserIdFromJwt(pbToken) {
  try {
    const [, payloadB64] = pbToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    return payload.id || payload.sub || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function verifyPocketbaseToken(pbToken) {
  if (!pbToken || pbToken.trim() === '') throw new Error('Missing auth token');

  if (!config.pocketbaseUrl) {
    return { userId: extractUserIdFromJwt(pbToken) };
  }

  const res = await fetch(`${config.pocketbaseUrl}/api/collections/users/auth-refresh`, {
    method: 'POST',
    headers: { Authorization: pbToken },
  });

  if (!res.ok) {
    throw new Error(`PocketBase token validation failed: ${res.status}`);
  }

  const data = await res.json();
  const userId = data.record?.id ?? extractUserIdFromJwt(pbToken);
  return { userId };
}

// --- Relay-server management API ---

async function authDoc(docId, userId) {
  const serverToken = createServerToken();
  const res = await fetch(`${config.relayUrl}/doc/${encodeURIComponent(docId)}/auth`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serverToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ authorization: 'full', userId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relay-server auth failed: ${res.status} ${text}`);
  }

  return res.json();
}

// --- Express app ---

const app = express();
app.use(express.json());

// Obsidian desktop sends Origin: app://obsidian.md
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', relay: config.relayUrl });
});

app.post('/token', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Bearer token' });
    }
    const pbToken = authHeader.slice(7);

    const { userId } = await verifyPocketbaseToken(pbToken);
    const { docId, folder, relay } = req.body;

    if (!docId) return res.status(400).json({ error: 'docId required' });

    // Get doc token from relay-server management API
    const clientToken = await authDoc(docId, userId);

    // Plugin expects: url, baseUrl, docId, folder, token, authorization, expiryTime
    const expiryTime = Date.now() + 60 * 60 * 1000; // 1 hour from now

    res.json({
      url: clientToken.url ?? `${config.relayUrl}/doc/`,
      baseUrl: clientToken.baseUrl ?? config.relayUrl,
      docId: clientToken.docId ?? docId,
      folder: folder ?? null,
      relay: relay ?? null,
      token: clientToken.token ?? null,
      authorization: clientToken.authorization ?? 'full',
      expiryTime,
    });
  } catch (err) {
    console.error('POST /token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Token service listening on :${config.port}`);
  console.log(`Relay server: ${config.relayUrl}`);
  console.log(`Key ID: ${config.keyId}`);
});
