// /api/data.js - Vercel serverless function
// Fetches CSV from Metabase and parses it properly

const METABASE_CSV_URL = "https://metabase.spyne.ai/public/question/a594963c-2ba3-4348-b305-cbf98d64fa45.csv";
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

module.exports.config = { maxDuration: 60 };

let cache = { data: null, fetchedAt: 0, error: null };

// Better CSV parser using simpler approach
function parseCSV(text) {
  try {
    // Remove BOM if present
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return { headers: [], records: [], error: 'No data in CSV' };
    }

    // Parse header line
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));

    // Parse records
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = [];
      let current = '';
      let inQuotes = false;

      for (let j = 0; j < line.length; j++) {
        const c = line[j];
        if (c === '"') {
          if (line[j + 1] === '"') {
            current += '"';
            j++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (c === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += c;
        }
      }
      values.push(current.trim());

      // Build record object
      const record = {};
      for (let k = 0; k < headers.length; k++) {
        record[headers[k]] = values[k] || '';
      }
      
      // Only add if has data
      if (Object.values(record).some(v => v)) {
        records.push(record);
      }
    }

    return { headers, records, error: null };
  } catch (err) {
    return { headers: [], records: [], error: err.message };
  }
}

// Fetch and cache
async function fetchData() {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL) {
    return cache;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    console.log('Fetching from:', METABASE_CSV_URL);
    
    const res = await fetch(METABASE_CSV_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'text/csv' }
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    
    const text = await res.text();
    console.log('CSV size:', text.length, 'bytes');
    console.log('First 200 chars:', text.substring(0, 200));
    
    const parsed = parseCSV(text);
    console.log('Parsed:', parsed.headers.length, 'headers,', parsed.records.length, 'records');
    
    cache = { 
      data: parsed, 
      fetchedAt: now,
      error: parsed.error 
    };
    
    return cache;
  } catch (err) {
    console.error('Fetch error:', err.message);
    cache.error = err.message;
    return cache;
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
    const result = await fetchData();
    
    if (result.error && !result.data.records.length) {
      return res.status(500).json({
        ok: false,
        error: result.error,
        debug: {
          url: METABASE_CSV_URL,
          cached: (Date.now() - result.fetchedAt) < CACHE_TTL
        }
      });
    }

    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=3600');
    res.status(200).json({
      ok: true,
      headers: result.data.headers,
      records: result.data.records,
      rowCount: result.data.records.length,
      debug: {
        fetchedAt: result.fetchedAt,
        cacheAge: Date.now() - result.fetchedAt
      }
    });
  } catch (err) {
    console.error('Handler error:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};
