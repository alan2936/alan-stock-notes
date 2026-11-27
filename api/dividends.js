// Vercel Serverless Function:
// 1. 預設：查詢台股（上市/上櫃/ETF）歷史除息紀錄
// 2. ?upcoming=1：查詢證交所官方除權除息預告表 (TWT48U_ALL)
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TWSE_UPCOMING_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL';

function parseRocDateToIso(raw) {
  const s = String(raw || '').trim();
  // 格式1: "115年12月10日" 或 "115/12/10"
  let m = s.match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  // 格式2: "1151210"
  m = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) {
    return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  }
  return '';
}

function calcLastBuyDate(exIso) {
  if (!exIso) return '';
  const d = new Date(exIso + 'T00:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function toNum(v) {
  const n = Number(String(v || '').replace(/,/g, '').trim());
  return Number.isNaN(n) ? 0 : n;
}

async function fetchUpcomingTwse(symbolSet, showAll) {
  const r = await fetch(TWSE_UPCOMING_URL, { headers: { Accept: 'application/json' } });
  if (!r.ok) return [];
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];

  const taipeiToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const items = [];
  for (const row of rows) {
    const code = String(row.Code || '').trim();
    if (!code) continue;
    if (!showAll && symbolSet.size > 0 && !symbolSet.has(code)) continue;
    const exDate = parseRocDateToIso(row.Date);
    if (!exDate || exDate < taipeiToday) continue;
    const cashPerShare = toNum(row.CashDividend);
    const stockRatio = toNum(row.StockDividendRatio);
    items.push({
      symbol: code,
      name: String(row.Name || '').trim(),
      exDate,
      lastBuyDate: calcLastBuyDate(exDate),
      kind: String(row.Exdividend || '息').trim(),
      cashPerShare: Number(cashPerShare.toFixed(4)),
      stockRatio: Number(stockRatio.toFixed(4))
    });
  }
  return items.sort((a, b) => a.exDate.localeCompare(b.exDate)).slice(0, showAll ? 30 : 50);
}

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
  const symbolSet = new Set(rawSymbols);

  try {
    if (String(req.query.upcoming || '') === '1') {
      const showAll = String(req.query.all || '') === '1';
      const upcoming = await fetchUpcomingTwse(symbolSet, showAll);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json({ upcoming, count: upcoming.length });
    }

    const startDate = String(req.query.startDate || '2020-01-01');
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
