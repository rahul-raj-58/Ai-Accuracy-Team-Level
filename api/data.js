// /api/data.js — Vercel serverless function
// Fetches the TWO Metabase public CSV exports used by the dashboard.
// Resilient: if one query fails, the other still gets returned with diagnostics.

const MAIN_URL =
  "https://metabase.spyne.ai/public/question/a594963c-2ba3-4348-b305-cbf98d64fa45.csv";
const REJECTED_URL =
  "https://metabase.spyne.ai/public/question/486ace1a-801e-49b8-861a-416c02bda1ab.csv";

const CACHE_HEADER = "public, s-maxage=3600, stale-while-revalidate=1800";
const PER_QUERY_TIMEOUT_MS = 45_000;
// Vercel Hobby has a 4.5 MB response body cap. Stay well under it.
const MAX_RESPONSE_BYTES = 4_000_000;

// ---------- CSV parser (RFC-4180-ish: quoted fields, embedded commas, "" escapes) ----------
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
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = []; field = ""; i++; continue;
    }
    field += c; i++;
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
    if (cells.length === 1 && cells[0] === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] === undefined ? "" : cells[c];
    }
    out.push(obj);
  }
  return out;
}

// Returns { ok, rows, bytes, ms, error } — never throws.
async function fetchCSV(url, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_QUERY_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "text/csv,*/*;q=0.5" },
    });
    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch (_) {}
      return {
        ok: false,
        error: `${label}: upstream ${res.status} ${res.statusText} — ${body}`,
        ms: Date.now() - startedAt,
        rows: [],
      };
    }
    const text = await res.text();
    const rows = parseCSV(text);
    const objs = rowsToObjects(rows);
    return { ok: true, rows: objs, bytes: text.length, ms: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === "AbortError"
        ? `${label}: timed out after ${PER_QUERY_TIMEOUT_MS}ms`
        : `${label}: ${String(err && err.message ? err.message : err)}`,
      ms: Date.now() - startedAt,
      rows: [],
    };
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

  const startedAt = Date.now();

  try {
    const [main, rejected] = await Promise.all([
      fetchCSV(MAIN_URL, "main"),
      fetchCSV(REJECTED_URL, "rejected"),
    ]);

    const diagnostics = {
      fetchedAt: new Date().toISOString(),
      totalMs: Date.now() - startedAt,
      main: { ok: main.ok, rows: main.rows.length, bytes: main.bytes || 0, ms: main.ms, error: main.error || null },
      rejected: { ok: rejected.ok, rows: rejected.rows.length, bytes: rejected.bytes || 0, ms: rejected.ms, error: rejected.error || null },
    };

    // If BOTH failed there's nothing to show — return 502 with details.
    if (!main.ok && !rejected.ok) {
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({
        ok: false,
        error: "Both Metabase queries failed",
        diagnostics,
      });
      return;
    }

    // Build response. Trim if it would exceed Vercel's body limit.
    let mainRows = main.rows;
    let rejectedRows = rejected.rows;
    let truncated = false;
    let truncatedFrom = null;

    let payload = {
      ok: true,
      partial: !main.ok || !rejected.ok,
      diagnostics,
      truncated: false,
      main: mainRows,
      rejected: rejectedRows,
    };
    let payloadStr = JSON.stringify(payload);

    if (payloadStr.length > MAX_RESPONSE_BYTES) {
      truncated = true;
      truncatedFrom = { main: mainRows.length, rejected: rejectedRows.length };
      // Trim main first (usually the larger), keep most recent rows by sticking with tail.
      const overshoot = payloadStr.length / MAX_RESPONSE_BYTES;
      const keep = Math.max(0.1, (1 / overshoot) * 0.9);
      mainRows = mainRows.slice(-Math.floor(mainRows.length * keep));
      payload = {
        ok: true,
        partial: !main.ok || !rejected.ok,
        diagnostics,
        truncated: true,
        truncatedFrom,
        truncatedTo: { main: mainRows.length, rejected: rejectedRows.length },
        main: mainRows,
        rejected: rejectedRows,
      };
      payloadStr = JSON.stringify(payload);

      // If still too big, also trim rejected.
      if (payloadStr.length > MAX_RESPONSE_BYTES) {
        const overshoot2 = payloadStr.length / MAX_RESPONSE_BYTES;
        const keep2 = Math.max(0.1, (1 / overshoot2) * 0.9);
        rejectedRows = rejectedRows.slice(-Math.floor(rejectedRows.length * keep2));
        payload.rejected = rejectedRows;
        payload.truncatedTo.rejected = rejectedRows.length;
        payloadStr = JSON.stringify(payload);
      }
    }

    // Don't cache partial or truncated responses; freshness matters more.
    const cacheHeader = (payload.partial || payload.truncated) ? "no-store" : CACHE_HEADER;
    res.setHeader("Cache-Control", cacheHeader);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).send(payloadStr);
  } catch (err) {
    // Last-resort catch — shouldn't fire because fetchCSV swallows its own errors.
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
      stack: err && err.stack ? String(err.stack).split("\n").slice(0, 5) : undefined,
    });
  }
}
