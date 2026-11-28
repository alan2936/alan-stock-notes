// Vercel Serverless Function:
// 1. 預設：查詢台股（上市/上櫃/ETF）歷史除息紀錄，並附帶歷史填息天數與填息率統計
// 2. ?upcoming=1：查詢證交所官方除權除息預告表 (TWT48U_ALL)
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const TWSE_UPCOMING_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL';

function parseRocDateToIso(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
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
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  const highs = quote.high || [];

  // 建立每日交易陣列供計算填息天數
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    const h = highs[i];
    if (c == null && h == null) continue;
    const iso = new Date(timestamps[i] * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
    bars.push({ date: iso, close: Number(c || h || 0), high: Number(h || c || 0) });
  }

  const list = [];
  for (const key of Object.keys(divMap)) {
    const item = divMap[key];
    if (item && item.amount > 0 && item.date) {
      const d = new Date(item.date * 1000 + 8 * 3600 * 1000);
      const exDate = d.toISOString().slice(0, 10);

      // 計算填息：找除息日前最後一個交易日的收盤價，再往後找 high >= preExClose
      let preExClose = null;
      let exIdx = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].date < exDate) {
          preExClose = bars[i].close;
        } else if (exIdx === -1 && bars[i].date >= exDate) {
          exIdx = i;
          break;
        }
      }

      let filled = null;
      let fillDays = null;
      if (preExClose && preExClose > 0 && exIdx !== -1) {
        filled = false;
        for (let i = exIdx; i < bars.length; i++) {
          if (bars[i].high >= preExClose - 1e-6) {
            filled = true;
            fillDays = i - exIdx + 1;
            break;
          }
        }
      }

      list.push({
        symbol: sym,
        name: result?.meta?.shortName || sym,
        exDate,
        cashPerShare: Number(Number(item.amount).toFixed(4)),
        preExClose: preExClose ? Number(preExClose.toFixed(2)) : null,
        filled,
        fillDays
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
    const flatAll = allLists.flat().sort((a, b) => a.exDate.localeCompare(b.exDate));
    const events = flatAll.filter(ev => ev.exDate >= startDate);

    // 彙整每檔股票的歷史填息統計（使用全部 5 年紀錄計算）
    const fillStats = {};
    for (const ev of flatAll) {
      if (ev.filled === null) continue;
      if (!fillStats[ev.symbol]) {
        fillStats[ev.symbol] = {
          symbol: ev.symbol,
          totalCount: 0,
          filledCount: 0,
          totalDays: 0,
          fastestDays: null,
          latestExDate: ev.exDate,
          latestFilled: ev.filled,
          latestFillDays: ev.fillDays
        };
      }
      const st = fillStats[ev.symbol];
      st.totalCount += 1;
      if (ev.filled) {
        st.filledCount += 1;
        st.totalDays += ev.fillDays || 1;
        if (st.fastestDays === null || ev.fillDays < st.fastestDays) {
          st.fastestDays = ev.fillDays;
        }
      }
      if (ev.exDate >= st.latestExDate) {
        st.latestExDate = ev.exDate;
        st.latestFilled = ev.filled;
        st.latestFillDays = ev.fillDays;
      }
    }
    for (const sym of Object.keys(fillStats)) {
      const st = fillStats[sym];
      st.fillRate = st.totalCount > 0 ? Number(((st.filledCount / st.totalCount) * 100).toFixed(1)) : 0;
      st.avgFillDays = st.filledCount > 0 ? Number((st.totalDays / st.filledCount).toFixed(1)) : null;
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ events, fillStats, count: events.length });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch dividends', message: err.message });
  }
};
