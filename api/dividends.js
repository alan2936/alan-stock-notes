// Vercel Serverless Function: 查詢證交所歷史除權息結果 (TWSE TWT49U) 與上櫃除權息資料
const TWSE_TWT49U = 'https://www.twse.com.tw/rwd/zh/exRight/TWT49U';

function rocTextToIso(raw) {
  const s = String(raw || '').trim();
  // 支援 "115年11月17日" 或 "115/11/17"
  const m = s.match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return '';
  const y = Number(m[1]) + 1911;
  const mon = String(Number(m[2])).padStart(2, '0');
  const d = String(Number(m[3])).padStart(2, '0');
  return `${y}-${mon}-${d}`;
}

function toNum(v) {
  const n = Number(String(v || '').replace(/,/g, '').trim());
  return Number.isNaN(n) ? 0 : n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const symbolSet = new Set(rawSymbols);

  const startDate = String(req.query.startDate || '2024-01-01').replace(/-/g, '');
  const now = new Date();
  const endDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  try {
    const url = `${TWSE_TWT49U}?response=json&strDate=${startDate}&endDate=${endDate}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
    });

    const events = [];
    if (r.ok) {
      const json = await r.json();
      if (json && json.stat === 'OK' && Array.isArray(json.data)) {
        const fields = json.fields || [];
        const idxDate = fields.findIndex(f => f.includes('資料日期'));
        const idxCode = fields.findIndex(f => f.includes('代號'));
        const idxName = fields.findIndex(f => f.includes('名稱'));
        const idxVal = fields.findIndex(f => f.includes('權值+息值') || f.includes('息值'));
        const idxType = fields.findIndex(f => f.includes('權/息'));

        for (const row of json.data) {
          const code = String(row[idxCode >= 0 ? idxCode : 1] || '').trim();
          if (!code || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
          const exDate = rocTextToIso(row[idxDate >= 0 ? idxDate : 0]);
          const val = toNum(row[idxVal >= 0 ? idxVal : 5]);
          const kind = String(row[idxType >= 0 ? idxType : 6] || '').trim();
          // 若為「息」或「權息」且金額 > 0，回傳現金股利估算
          if (exDate && val > 0 && !kind.startsWith('權')) {
            events.push({
              symbol: code,
              name: String(row[idxName >= 0 ? idxName : 2] || '').trim(),
              exDate,
              cashPerShare: val
            });
          }
        }
      }
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      events,
      count: events.length
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch dividends', message: err.message });
  }
};
