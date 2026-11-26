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
    { symbol: 'NQ=F', name: '小那斯達克' }
  ]
};


async function fetchTaifexNightCard() {
  const quoteUrl = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
  const chartUrl = 'https://mis.taifex.com.tw/futures/api/getChartData1Min';
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://mis.taifex.com.tw',
    'Referer': 'https://mis.taifex.com.tw/futures/'
  };

  // 先查夜盤 (MarketType: "1")，若非夜盤時段或尚無成交則自動查日盤 (MarketType: "0")
  for (const marketType of ['1', '0']) {
    try {
      const r = await fetch(quoteUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          MarketType: marketType,
          SymbolType: 'F',
          KindID: '1',
          CID: 'TXF',
          ExpireMonth: '',
          RowSize: '全部',
          PageNo: '',
          SortColumn: '',
          AscDesc: 'A'
        })
      });
      if (!r.ok) continue;
      const json = await r.json();
      const list = json?.RtData?.QuoteList || [];
      // 挑選近月台指期合約（排除現貨 TXF-S 及價差單 "/"）
      const near = list.find(q =>
        q.SymbolID &&
        !String(q.SymbolID).includes('/') &&
        !String(q.SymbolID).endsWith('-S') &&
        Number(q.CLastPrice) > 0
      );
      if (!near) continue;

      const price = Number(near.CLastPrice) || 0;
      const prevClose = Number(near.CRefPrice) || price;
      const change = Number(near.CDiff) || (price - prevClose);
      const pct = Number(near.CDiffRate) || (prevClose > 0 ? (change / prevClose) * 100 : 0);

      // 嘗試抓取 1 分鐘分時走勢點繪製迷你走勢圖
      let sparkline = [];
      try {
        const cr = await fetch(chartUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ SymbolID: near.SymbolID })
        });
        if (cr.ok) {
          const cjson = await cr.json();
          const pts = cjson?.RtData?.QuoteList || cjson?.RtData?.ChartData || [];
          if (Array.isArray(pts) && pts.length > 1) {
            const rawPrices = pts
              .map(p => Number(Array.isArray(p) ? p[1] : (p.CLastPrice || p.Price || p.Close)))
              .filter(v => !Number.isNaN(v) && v > 0);
            if (rawPrices.length > 36) {
              const step = rawPrices.length / 36;
              for (let i = 0; i < 36; i++) sparkline.push(rawPrices[Math.floor(i * step)]);
              sparkline[sparkline.length - 1] = price;
            } else {
              sparkline = rawPrices;
            }
          }
        }
      } catch (_) {}

      if (sparkline.length < 2) {
        const openP = Number(near.COpenPrice) || prevClose;
        const highP = Number(near.CHighPrice) || Math.max(openP, price);
        const lowP = Number(near.CLowPrice) || Math.min(openP, price);
        sparkline = [prevClose, openP, highP, lowP, price];
      }

      return {
        symbol: near.SymbolID,
        name: marketType === '1' ? '台指期盤後' : '台指期(日盤)',
        price: Number(price.toFixed(0)),
        prevClose: Number(prevClose.toFixed(0)),
        change: Number(change.toFixed(0)),
        pct: Number(pct.toFixed(2)),
        sparkline
      };
    } catch (_) {}
  }
  return null;
}

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
    // 單檔近 3 年日線 + 證交所本益比/殖利率/股價淨值比 (供個股均線與價值河流圖用)
    if (historySymbol) {
      const [r, bwRes] = await Promise.all([
        fetchTwHistory(historySymbol, '3y'),
        fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', {
          headers: { Accept: 'application/json' }
        }).then(resp => (resp.ok ? resp.json() : null)).catch(() => null)
      ]);
      const series = r ? extractDailySeries(r) : [];
      let valuation = null;
      if (Array.isArray(bwRes)) {
        const hit = bwRes.find(row => String(row.Code || '').trim() === historySymbol);
        if (hit) {
          const pe = Number(String(hit.PEratio || '').replace(/,/g, '').trim());
          const pb = Number(String(hit.PBratio || '').replace(/,/g, '').trim());
          const yld = Number(String(hit.DividendYield || '').replace(/,/g, '').trim());
          valuation = {
            pe: !Number.isNaN(pe) && pe > 0 ? pe : null,
            pb: !Number.isNaN(pb) && pb > 0 ? pb : null,
            yield: !Number.isNaN(yld) && yld > 0 ? yld : null
          };
        }
      }
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ symbol: historySymbol, series, valuation });
    }

    // 批次真實歷史日線 (供真實報酬日曆、走勢分析、績效 vs 0050 含股利用)
    if (batchHistory) {
      const allSyms = Array.from(new Set([...rawSymbols, compareSym, '^TWII', '0050', '00981A'].filter(Boolean)));
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

    const taifexCard = await fetchTaifexNightCard();
    const indices = MARKET_CARDS.indices.map((m, i) => parseIntradayCard(m, cardResults[i]));
    const futures = [
      ...MARKET_CARDS.futures.map((m, i) => parseIntradayCard(m, cardResults[MARKET_CARDS.indices.length + i])),
      taifexCard || { symbol: 'TXF-M', name: '台指期盤後', price: 0, prevClose: 0, change: 0, pct: 0, sparkline: [] }
    ];

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
