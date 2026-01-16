import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();
const DATA_DIR = path.join(process.cwd(), "data");
const NUMBER_MAP_PATH = path.join(DATA_DIR, "itemNumberToId.json");
const NAME_FALLBACK_PATH = path.join(DATA_DIR, "itemNameToId_missingNumber.json");
const cors = require('cors');
const app = express();

app.use(cors()); // This allows your frontend to talk to this server.
function loadJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

// Load maps once at startup (restart server after updating files)
let itemNumberToId = loadJsonSafe(NUMBER_MAP_PATH);
let itemNameToIdMissingNumber = loadJsonSafe(NAME_FALLBACK_PATH);

// ----------------------------
// Striven caching + backend-side rate limiting
// ----------------------------
// Your Striven plan is limited to ~100 requests/minute.
// We enforce a *backend* guard so the UI never hard-fails and can keep showing cached data.
//
// Strategy:
// - In-memory cache for /v1/items/:id responses (TTL)
// - Process-level per-minute guard (conservative default: 90)
//
// Note: This cache is in-memory; restarting the backend clears it.
const ITEM_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STRIVEN_MAX_CALLS_PER_MIN = Number(process.env.STRIVEN_MAX_CALLS_PER_MIN || 90);

const itemByIdCache = new Map(); // id -> { ts, value }
let windowStartMs = Date.now();
let windowCount = 0;

function rateWindowResetIfNeeded() {
  const now = Date.now();
  if (now - windowStartMs >= 60_000) {
    windowStartMs = now;
    windowCount = 0;
  }
}

function canSpendStrivenCall() {
  rateWindowResetIfNeeded();
  return windowCount < STRIVEN_MAX_CALLS_PER_MIN;
}

function spendStrivenCall() {
  rateWindowResetIfNeeded();
  windowCount += 1;
}

function getRetryAfterSeconds() {
  rateWindowResetIfNeeded();
  const now = Date.now();
  const msLeft = Math.max(0, 60_000 - (now - windowStartMs));
  return Math.max(1, Math.ceil(msLeft / 1000));
}

function normalizeKey(s) {
  return String(s ?? "").trim();
}

//const app = express();
//app.use(cors());
//app.use(express.json());

// This tells the app: "Use whatever Port Render gives me, otherwise use 5000"
const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

const STRIVEN_BASE = "https://api.striven.com";
const TOKEN_URL = `${STRIVEN_BASE}/accesstoken`;

const CLIENT_ID = process.env.STRIVEN_CLIENT_ID;
const CLIENT_SECRET = process.env.STRIVEN_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing STRIVEN_CLIENT_ID or STRIVEN_CLIENT_SECRET in backend/.env");
  process.exit(1);
}

// ----------------------------
// Token cache (reuse token)
// ----------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("ClientId", CLIENT_ID);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(CLIENT_ID, CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;

  // expires_in is seconds; subtract 60 seconds buffer
  const expiresInMs = (Number(json.expires_in) || 86400) * 1000;
  tokenExpiresAt = Date.now() + expiresInMs - 60_000;

  return cachedToken;
}

async function strivenFetch(path, options = {}) {
  // Process-level limiter to avoid hitting Striven's plan limits.
  // Only count calls that actually go to Striven.
  if (!canSpendStrivenCall()) {
    const retryAfter = getRetryAfterSeconds();
    const err = new Error(`Rate limit guard: too many Striven calls this minute. Retry after ${retryAfter}s`);
    err.status = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
  spendStrivenCall();

  const token = await getAccessToken();
  const url = `${STRIVEN_BASE}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Striven API error ${res.status} on ${path}: ${text}`);
    err.status = res.status;
    // Striven sometimes returns Retry-After; pass it through if present
    const ra = res.headers.get("retry-after");
    if (ra) err.retryAfter = Number(ra) || undefined;
    throw err;
  }

  return res.json();
}

function cacheGetItem(id) {
  const key = String(id);
  const hit = itemByIdCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ITEM_CACHE_TTL_MS) {
    itemByIdCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSetItem(id, value) {
  itemByIdCache.set(String(id), { ts: Date.now(), value });
}

async function fetchItemByIdCached(id) {
  const cached = cacheGetItem(id);
  if (cached) return cached;
  const item = await strivenFetch(`/v1/items/${id}`, { method: "GET" });
  cacheSetItem(id, item);
  return item;
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Always round UP using your tiers
function roundUpNice(n) {
  const x = toNumber(n);
  if (x <= 0) return 0;

  let step = 1;
  if (x >= 10 && x < 100) step = 5;
  else if (x >= 100 && x <= 500) step = 20;
  else if (x > 500 && x <= 1000) step = 50;
  else if (x > 1000) step = 100;

  return Math.ceil(x / step) * step;
}

function calcItemRawTotal(itemJson) {
  const typeName = itemJson?.itemType?.name || "";

  // SRG / Item Group
  if (typeName.toLowerCase() === "item group" && Array.isArray(itemJson.groupItems)) {
    const components = itemJson.groupItems.map(g => {
      const qty = toNumber(g.qty);
      const unitPrice = toNumber(g.price);
      return {
        itemId: g?.item?.id ?? null,
        name: g?.item?.name ?? "",
        qty,
        unitPrice,
        lineTotal: qty * unitPrice
      };
    });

    const rawTotal = components.reduce((sum, c) => sum + c.lineTotal, 0);
    return { rawTotal, components, kind: "SRG" };
  }

  // Normal item
  const rawTotal = toNumber(itemJson.price);
  return { rawTotal, components: [], kind: "ITEM" };
}

// ----------------------------
// Health check
// ----------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ----------------------------
// Get item by ID
// ----------------------------
app.get("/api/items/:id", async (req, res) => {
  try {
    const item = await fetchItemByIdCached(req.params.id);
    res.json(item);
  } catch (err) {
    const status = Number(err.status) || 500;
    const payload = { error: String(err.message || err) };
    if (err.retryAfter) payload.retryAfter = err.retryAfter;
    res.status(status).json(payload);
  }
});
app.post("/api/resolve-by-number", async (req, res) => {
  try {
    const itemNumbers = Array.isArray(req.body?.itemNumbers) ? req.body.itemNumbers : [];
    if (itemNumbers.length === 0) {
      return res.status(400).json({ error: "Body must include { itemNumbers: [...] }" });
    }

    const results = [];

    for (const n of itemNumbers) {
      const itemNumber = normalizeKey(n);
      let id = itemNumberToId[itemNumber];

      // Optional fallback: if itemNumber blank, allow lookup by name
      if (!id && itemNumberToId[itemNumber] == null) {
        id = itemNameToIdMissingNumber[itemNumber];
      }

      if (!id) {
        results.push({
          requestedItemNumber: itemNumber,
          itemNumber,
          error: "No ItemId found for this itemNumber/name in backend/data mapping files."
        });
        continue;
      }

      let item;
      try {
        item = await fetchItemByIdCached(id);
      } catch (err) {
        if (Number(err.status) === 429) {
          return res.status(429).json({
            error: String(err.message || err),
            retryAfter: err.retryAfter || getRetryAfterSeconds(),
            lines: results
          });
        }

        results.push({
          requestedItemNumber: itemNumber,
          itemNumber,
          error: String(err.message || err)
        });
        continue;
      }

      const { rawTotal, components, kind } = calcItemRawTotal(item);
      const roundedTotal = roundUpNice(rawTotal);

      results.push({
        requestedItemNumber: itemNumber,
        id: item.id,
        itemNumber: item.itemNumber,
        name: item.name,
        kind, // "SRG" or "ITEM"
        workDescription: item.description ?? item.name ?? "",
        rawTotal,
        roundedTotal,
        finalTotal: roundedTotal,
        debug: { components }
      });
    }

    res.json({ lines: results });
  } catch (err) {
    const status = Number(err.status) || 500;
    const payload = { error: String(err.message || err) };
    if (err.retryAfter) payload.retryAfter = err.retryAfter;
    res.status(status).json(payload);
  }
});

app.post("/api/resolve-lines", async (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (lines.length === 0) {
      return res.status(400).json({ error: "Body must include { lines: [{id: number}, ...] }" });
    }

    const results = [];

    for (const line of lines) {
      const id = Number(line.id);
      if (!Number.isFinite(id)) continue;

      let item;
      try {
        item = await fetchItemByIdCached(id);
      } catch (err) {
        if (Number(err.status) === 429) {
          return res.status(429).json({
            error: String(err.message || err),
            retryAfter: err.retryAfter || getRetryAfterSeconds(),
            lines: results
          });
        }
        results.push({ id, error: String(err.message || err) });
        continue;
      }

      const { rawTotal, components, kind } = calcItemRawTotal(item);
      const roundedTotal = roundUpNice(rawTotal);

      results.push({
        id: item.id,
        itemNumber: item.itemNumber,
        name: item.name,
        kind, // "SRG" or "ITEM"
        workDescription: item.description ?? item.name ?? "",
        rawTotal,
        roundedTotal,
        finalTotal: roundedTotal, // front-end can override this
        debug: { components }     // for internal audit display
      });
    }

    res.json({ lines: results });
  } catch (err) {
    const status = Number(err.status) || 500;
    const payload = { error: String(err.message || err) };
    if (err.retryAfter) payload.retryAfter = err.retryAfter;
    res.status(status).json(payload);
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
