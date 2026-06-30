import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---

function loadConfig() {
  const tomlPath = process.env.RELAY_TOML || join(__dirname, '../../relay.toml');
  const toml = readFileSync(tomlPath, 'utf8');

  const urlMatch = toml.match(/url\s*=\s*"([^"]+)"/);

  return {
    relayUrl: process.env.RELAY_URL || urlMatch?.[1] || 'http://localhost:8080',
    relayServerAuth: process.env.RELAY_SERVER_AUTH || '',
    port: parseInt(process.env.PORT || '3000', 10),
    pocketbaseUrl: process.env.POCKETBASE_URL || 'http://localhost:8090',
  };
}

const config = loadConfig();

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
  const serverToken = config.relayServerAuth;
  if (!serverToken) {
    throw new Error('RELAY_SERVER_AUTH is required');
  }

  const res = await fetch(`${config.relayUrl}/doc/${encodeURIComponent(docId)}/auth`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serverToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ authorization: 'full' }),
  });

  if (res.status === 404) {
    const createRes = await fetch(`${config.relayUrl}/doc/new`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serverToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ docId }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`relay-server doc create failed: ${createRes.status} ${text}`);
    }

    return authDoc(docId, userId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relay-server auth failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function buildPluginToken(req, res, includeFileHash) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' });
  }
  const pbToken = authHeader.slice(7);

  const { userId } = await verifyPocketbaseToken(pbToken);
  const { docId, folder, relay, hash } = req.body;

  if (!docId) return res.status(400).json({ error: 'docId required' });
  if (includeFileHash && !hash) {
    return res.status(400).json({ error: 'hash required' });
  }

  const clientToken = await authDoc(docId, userId);
  const expiryTime = Date.now() + 60 * 60 * 1000;
  const response = {
    url: clientToken.url ?? `${config.relayUrl}/doc/`,
    baseUrl: clientToken.baseUrl ?? config.relayUrl,
    docId: clientToken.docId ?? docId,
    folder: folder ?? null,
    relay: relay ?? null,
    token: clientToken.token ?? null,
    authorization: clientToken.authorization ?? 'full',
    expiryTime,
  };

  if (includeFileHash) {
    response.fileHash = hash;
  }

  return res.json(response);
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
    return await buildPluginToken(req, res, false);
  } catch (err) {
    console.error(`POST /token error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/file-token', async (req, res) => {
  try {
    return await buildPluginToken(req, res, true);
  } catch (err) {
    console.error(`POST /file-token error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Token service listening on :${config.port}`);
  console.log(`Relay server: ${config.relayUrl}`);
});
