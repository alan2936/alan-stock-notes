// Vercel Serverless Function:
// 1. 美股指數 / 期貨 / 台積電ADR 迷你走勢圖 + 個股/大盤區間報酬
// 2. ?historySymbol=2330 -> 單檔近1年日線
// 3. ?batchHistory=1&symbols=...&compare=0050 -> 多檔近3年真實日收盤與含息還原(adjclose)序列
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const MARKET_CARDS = {
  indices: [
    { symbol: '^DJI', name: '道瓊指數' },
    { symbol: '^GSPC', name: 'S&P500' },
    { symbol: '^IXIC', name: '那斯達克' },
    { symbol: '^SOX', name: '費城半導體' }
  ],
  futures: [
    { symbol: 'YM=F', name: '小道瓊' },
    { symbol: 'ES=F', name: '小S&P500' },
    { symbol: 'NQ=F', name: '小那斯達克' },
    { symbol: 'TSM', name: '台積電ADR(夜盤指標)' }
  ]
};

async function fetchChart(symbol, range = '1d', interval = '15m') {
  const url = `${YF_BASE}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.chart?.result?.[0] || null;
}

async function fetchTwHistory(sym, range = '3y') {
  const yf = /^\d/.test(sym) ? `${sym}.TW` : sym;
  let r = await fetchChart(yf, range, '1d').catch(() => null);
  if (!r && yf.endsWith('.TW')) {
    r = await fetchChart(yf.replace('.TW', '.TWO'), range, '1d').catch(() => null);
  }
  return r;
}

function extractDailySeries(result) {
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || closes;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === 'number' && !Number.isNaN(c) && c > 0) {
      const a = typeof adj[i] === 'number' && !Number.isNaN(adj[i]) && adj[i] > 0 ? adj[i] : c;
      // Convert UTC timestamp to Taipei local date (UTC+8)
      const d = new Date(ts[i] * 1000 + 8 * 3600 * 1000);
      out.push({
        date: d.toISOString().slice(0, 10),
        close: Number(c.toFixed(2)),
        adjclose: Number(a.toFixed(4))
      });
    }
  }
  return out;
}

function parseIntradayCard(metaItem, result) {
  const meta = result?.meta || {};
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number' && !Number.isNaN(v));
  const price = meta.regularMarketPrice || closes[closes.length - 1] || 0;
  const prevClose = meta.chartPreviousClose || meta.previousClose || closes[0] || price;
  const change = price - prevClose;
  const pct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  return {
    symbol: metaItem.symbol,
    name: metaItem.name,
    price: Number(price.toFixed(2)),
    prevClose: Number(prevClose.toFixed(2)),
    change: Number(change.toFixed(2)),
    pct: Number(pct.toFixed(2)),
    sparkline: closes.slice(-36).map(v => Number(v.toFixed(2)))
  };
}

function computePerfFromHistory(result) {
  const pairs = extractDailySeries(result);
  if (pairs.length < 2) return null;
  const last = pairs[pairs.length - 1].close;
  const calcPct = idx => {
    const base = pairs[Math.max(0, idx)]?.close;
    return base > 0 ? Number((((last - base) / base) * 100).toFixed(2)) : 0;
  };
  const yrStart = `${new Date().getFullYear()}-01-01`;
  const ytdRow = pairs.find(p => p.date >= yrStart) || pairs[0];
  const ytd = ytdRow.close > 0 ? Number((((last - ytdRow.close) / ytdRow.close) * 100).toFixed(2)) : 0;
  return {
    d1: calcPct(pairs.length - 2),
    d5: calcPct(pairs.length - 6),
    d20: calcPct(pairs.length - 21),
    ytd
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const historySymbol = String(req.query.historySymbol || '').trim();
  const batchHistory = String(req.query.batchHistory || '') === '1';
  const compareSym = String(req.query.compare || '0050').trim();
  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  try {
    // 單檔日線 (供個股彈窗用)
    if (historySymbol) {
      const r = await fetchTwHistory(historySymbol, '1y');
      const series = r ? extractDailySeries(r) : [];
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ symbol: historySymbol, series });
    }

    // 批次真實歷史日線 (供真實報酬日曆、走勢分析、績效 vs 0050 含股利用)
    if (batchHistory) {
      const allSyms = Array.from(new Set([...rawSymbols, compareSym, '^TWII', '0050'].filter(Boolean)));
      const results = await Promise.all(
        allSyms.map(async s => {
          const r = await fetchTwHistory(s, '3y');
          return { s, series: r ? extractDailySeries(r) : [] };
        })
      );
      const historyBySymbol = {};
      for (const item of results) {
        if (item.series.length > 0) historyBySymbol[item.s] = item.series;
      }
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ historyBySymbol });
    }

    // 指數與期貨 4 格卡片 + 大盤與持股漲跌幅
    const allCardMeta = [...MARKET_CARDS.indices, ...MARKET_CARDS.futures];
    const cardResults = await Promise.all(
      allCardMeta.map(m => fetchChart(m.symbol, '1d', '15m').catch(() => null))
    );

    const indices = MARKET_CARDS.indices.map((m, i) => parseIntradayCard(m, cardResults[i]));
    const futures = MARKET_CARDS.futures.map((m, i) => parseIntradayCard(m, cardResults[MARKET_CARDS.indices.length + i]));

    const perfTargets = ['^TWII', '^GSPC', ...rawSymbols];
    const perfResults = await Promise.all(
      perfTargets.map(async k => {
        const r = await fetchTwHistory(k, '1y');
        return { key: k, perf: r ? computePerfFromHistory(r) : null };
      })
    );

    const perfMap = {};
    for (const item of perfResults) {
      if (item.perf) perfMap[item.key] = item.perf;
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      indices,
      futures,
      perfMap,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch market data', message: err.message });
  }
};
