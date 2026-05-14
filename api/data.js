// /api/data.js — Vercel serverless function
// Fetches two Metabase public CSV exports, parses, returns JSON.
// Cached at the CDN edge for 1 hour (matches dashboard refresh timer).

const MAIN_URL =
  "https://metabase.spyne.ai/public/question/a594963c-2ba3-4348-b305-cbf98d64fa45.csv";
const REJECTED_URL =
  "https://metabase.spyne.ai/public/question/486ace1a-801e-49b8-861a-416c02bda1ab.csv";

const CACHE_HEADER = "public, s-maxage=3600, stale-while-revalidate=1800";
const FETCH_TIMEOUT_MS = 55_000;

// ---------- CSV parser (RFC-4180-ish, handles quoted fields, embedded commas, "" escapes) ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // skip totally blank lines
    if (cells.length === 1 && cells[0] === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] === undefined ? "" : cells[c];
    }
    out.push(obj);
  }
  return out;
}

async function fetchCSV(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "text/csv,*/*;q=0.5" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Upstream ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 200)}`
      );
    }
    const text = await res.text();
    const rows = parseCSV(text);
    return rowsToObjects(rows);
  } finally {
    clearTimeout(t);
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const [main, rejected] = await Promise.all([
      fetchCSV(MAIN_URL),
      fetchCSV(REJECTED_URL),
    ]);

    res.setHeader("Cache-Control", CACHE_HEADER);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      mainCount: main.length,
      rejectedCount: rejected.length,
      main,
      rejected,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
}
