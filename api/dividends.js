// Vercel Serverless Function: 查詢台股（上市/上櫃/ETF）真實除息歷史紀錄
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function fetchDividendsForSymbol(sym) {
  const yf = /^\d/.test(sym) ? `${sym}.TW` : sym;
  const fetchOne = async ticker => {
    const url = `${YF_BASE}${encodeURIComponent(ticker)}?range=5y&interval=1d&events=div`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.chart?.result?.[0] || null;
  };

  let result = await fetchOne(yf).catch(() => null);
  if (!result && yf.endsWith('.TW')) {
    result = await fetchOne(yf.replace('.TW', '.TWO')).catch(() => null);
  }
  const divMap = result?.events?.dividends || {};
  const list = [];
  for (const key of Object.keys(divMap)) {
    const item = divMap[key];
    if (item && item.amount > 0 && item.date) {
      const d = new Date(item.date * 1000 + 8 * 3600 * 1000);
      list.push({
        symbol: sym,
        name: result?.meta?.shortName || sym,
        exDate: d.toISOString().slice(0, 10),
        cashPerShare: Number(Number(item.amount).toFixed(4))
      });
    }
  }
  return list;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const startDate = String(req.query.startDate || '2020-01-01');

  try {
    const allLists = await Promise.all(rawSymbols.map(s => fetchDividendsForSymbol(s)));
    const events = allLists
      .flat()
      .filter(ev => ev.exDate >= startDate)
      .sort((a, b) => a.exDate.localeCompare(b.exDate));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ events, count: events.length });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch dividends', message: err.message });
  }
};
