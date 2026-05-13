// /api/data.js - Vercel serverless function
// Fetches data from Metabase CSV and returns as JSON with caching

const METABASE_CSV_URL = "https://metabase.spyne.ai/public/question/a594963c-2ba3-4348-b305-cbf98d64fa45.csv";
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

module.exports.config = { maxDuration: 60 };

let cache = { data: null, fetchedAt: 0 };

// Parse CSV
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 1) return { headers: [], records: [] };

  // Parse header
  const headers = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < lines[0].length; i++) {
    const c = lines[0][i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      headers.push(current.trim().replace(/"/g, ''));
      current = '';
    } else {
      current += c;
    }
  }
  headers.push(current.trim().replace(/"/g, ''));

  // Parse records
  const records = [];
  for (let r = 1; r < lines.length; r++) {
    const row = {};
    let inQuotes = false;
    let current = '';
    let col = 0;

    for (let i = 0; i < lines[r].length; i++) {
      const c = lines[r][i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        row[headers[col]] = current.trim().replace(/"/g, '');
        current = '';
        col++;
      } else {
        current += c;
      }
    }
    if (col < headers.length) {
      row[headers[col]] = current.trim().replace(/"/g, '');
    }
    if (Object.keys(row).length > 0 && Object.values(row).some(v => v)) {
      records.push(row);
    }
  }

  return { headers, records };
}

// Fetch and cache
async function fetchData() {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL) {
    return cache.data;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(METABASE_CSV_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'text/csv' }
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseCSV(text);
    
    cache = { data: parsed, fetchedAt: now };
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

// Handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const data = await fetchData();
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=3600');
    res.status(200).json({
      ok: true,
      headers: data.headers,
      records: data.records
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};
