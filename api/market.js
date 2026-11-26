// Vercel Serverless Function: 抓取美股四大指數、美股期貨、台積電ADR 迷你走勢圖，以及加權指數 / S&P500 / 持股區間報酬率
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
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const pairs = [];
  for (let i = 0; i < ts.length; i++) {
    if (typeof closes[i] === 'number' && !Number.isNaN(closes[i])) {
      pairs.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: closes[i] });
    }
  }
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
  const rawSymbols = String(req.query.symbols || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  try {
    // 若指定 historySymbol，回傳近一年日線收盤資料（供前端繪製半年走勢與 MA5/MA20/MA60）
    if (historySymbol) {
      const yf = /^\d/.test(historySymbol) ? `${historySymbol}.TW` : historySymbol;
      let r = await fetchChart(yf, '1y', '1d').catch(() => null);
      if (!r && yf.endsWith('.TW')) {
        r = await fetchChart(yf.replace('.TW', '.TWO'), '1y', '1d').catch(() => null);
      }
      const ts = r?.timestamp || [];
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const series = [];
      for (let i = 0; i < ts.length; i++) {
        if (typeof closes[i] === 'number' && !Number.isNaN(closes[i])) {
          series.push({
            date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
            close: Number(closes[i].toFixed(2))
          });
        }
      }
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ symbol: historySymbol, series });
    }
    // 1. 抓取指數與期貨 4 格卡片
    const allCardMeta = [...MARKET_CARDS.indices, ...MARKET_CARDS.futures];
    const cardResults = await Promise.all(
      allCardMeta.map(m => fetchChart(m.symbol, '1d', '15m').catch(() => null))
    );

    const indices = MARKET_CARDS.indices.map((m, i) => parseIntradayCard(m, cardResults[i]));
    const futures = MARKET_CARDS.futures.map((m, i) => parseIntradayCard(m, cardResults[MARKET_CARDS.indices.length + i]));

    // 2. 抓取加權指數 (^TWII)、S&P 500 (^GSPC) 與持股的真實區間漲跌幅
    const perfTargets = [
      { key: '^TWII', yf: '^TWII' },
      { key: '^GSPC', yf: '^GSPC' },
      ...rawSymbols.map(s => ({ key: s, yf: /^\d/.test(s) ? `${s}.TW` : s }))
    ];

    const perfResults = await Promise.all(
      perfTargets.map(async t => {
        let r = await fetchChart(t.yf, '1y', '1d').catch(() => null);
        // 若上市 .TW 查無資料，嘗試上櫃 .TWO
        if (!r && t.yf.endsWith('.TW')) {
          r = await fetchChart(t.yf.replace('.TW', '.TWO'), '1y', '1d').catch(() => null);
        }
        return { key: t.key, perf: r ? computePerfFromHistory(r) : null };
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
