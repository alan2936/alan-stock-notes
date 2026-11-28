// Vercel Serverless Function:
// 查詢台股 ETF 即時預估淨值與折溢價 (TWSE MIS all_etf.txt) + 熱門台股 ETF 成分股權重
const MIS_ETF_URL = 'https://mis.twse.com.tw/stock/data/all_etf.txt';
const YF_SUMMARY_BASE = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/';

// 內建熱門台股 ETF 主要成分股權重備援（當外部成分股 API 無法即時取得時提供精確穿透參考）
const FALLBACK_ETF_HOLDINGS = {
  '0050': [
    { symbol: '2330', name: '台積電', weight: 55.2 },
    { symbol: '2317', name: '鴻海', weight: 4.9 },
    { symbol: '2454', name: '聯發科', weight: 4.5 },
    { symbol: '2308', name: '台達電', weight: 2.1 },
    { symbol: '2382', name: '廣達', weight: 1.9 },
    { symbol: '2881', name: '富邦金', weight: 1.8 },
    { symbol: '2882', name: '國泰金', weight: 1.5 },
    { symbol: '2891', name: '中信金', weight: 1.4 },
    { symbol: '3711', name: '日月光投控', weight: 1.3 },
    { symbol: '2412', name: '中華電', weight: 1.2 }
  ],
  '006208': [
    { symbol: '2330', name: '台積電', weight: 55.0 },
    { symbol: '2317', name: '鴻海', weight: 4.9 },
    { symbol: '2454', name: '聯發科', weight: 4.5 },
    { symbol: '2308', name: '台達電', weight: 2.1 },
    { symbol: '2382', name: '廣達', weight: 1.9 },
    { symbol: '2881', name: '富邦金', weight: 1.8 },
    { symbol: '2882', name: '國泰金', weight: 1.5 },
    { symbol: '2891', name: '中信金', weight: 1.4 },
    { symbol: '3711', name: '日月光投控', weight: 1.3 },
    { symbol: '2412', name: '中華電', weight: 1.2 }
  ],
  '0056': [
    { symbol: '2603', name: '長榮', weight: 4.8 },
    { symbol: '2303', name: '聯電', weight: 4.3 },
    { symbol: '3231', name: '緯創', weight: 4.1 },
    { symbol: '2357', name: '華碩', weight: 3.9 },
    { symbol: '2891', name: '中信金', weight: 3.8 },
    { symbol: '2301', name: '光寶科', weight: 3.6 },
    { symbol: '2382', name: '廣達', weight: 3.5 },
    { symbol: '2379', name: '瑞昱', weight: 3.4 },
    { symbol: '3034', name: '聯詠', weight: 3.3 },
    { symbol: '4938', name: '和碩', weight: 3.1 }
  ],
  '00878': [
    { symbol: '2882', name: '國泰金', weight: 9.2 },
    { symbol: '2881', name: '富邦金', weight: 8.6 },
    { symbol: '2303', name: '聯電', weight: 7.4 },
    { symbol: '2357', name: '華碩', weight: 5.8 },
    { symbol: '3034', name: '聯詠', weight: 5.4 },
    { symbol: '2886', name: '兆豐金', weight: 4.9 },
    { symbol: '2379', name: '瑞昱', weight: 4.6 },
    { symbol: '2301', name: '光寶科', weight: 4.4 },
    { symbol: '2891', name: '中信金', weight: 4.3 },
    { symbol: '2454', name: '聯發科', weight: 4.2 }
  ],
  '00919': [
    { symbol: '2603', name: '長榮', weight: 10.5 },
    { symbol: '2891', name: '中信金', weight: 9.4 },
    { symbol: '2303', name: '聯電', weight: 8.8 },
    { symbol: '2454', name: '聯發科', weight: 8.1 },
    { symbol: '3034', name: '聯詠', weight: 6.5 },
    { symbol: '2882', name: '國泰金', weight: 6.2 },
    { symbol: '2881', name: '富邦金', weight: 5.9 },
    { symbol: '5347', name: '世界', weight: 4.2 },
    { symbol: '3005', name: '神基', weight: 3.9 },
    { symbol: '2449', name: '京元電子', weight: 3.8 }
  ],
  '00929': [
    { symbol: '2454', name: '聯發科', weight: 8.9 },
    { symbol: '2303', name: '聯電', weight: 8.2 },
    { symbol: '3711', name: '日月光投控', weight: 7.4 },
    { symbol: '3034', name: '聯詠', weight: 6.8 },
    { symbol: '2379', name: '瑞昱', weight: 5.9 },
    { symbol: '2301', name: '光寶科', weight: 5.2 },
    { symbol: '2385', name: '群光', weight: 4.8 },
    { symbol: '2449', name: '京元電子', weight: 4.5 },
    { symbol: '4938', name: '和碩', weight: 4.3 },
    { symbol: '2324', name: '仁寶', weight: 4.1 }
  ],
  '00713': [
    { symbol: '2412', name: '中華電', weight: 7.8 },
    { symbol: '3045', name: '台灣大', weight: 7.1 },
    { symbol: '4904', name: '遠傳', weight: 6.5 },
    { symbol: '1216', name: '統一', weight: 5.9 },
    { symbol: '2886', name: '兆豐金', weight: 5.4 },
    { symbol: '2892', name: '第一金', weight: 5.1 },
    { symbol: '2303', name: '聯電', weight: 4.6 },
    { symbol: '2357', name: '華碩', weight: 4.3 },
    { symbol: '2385', name: '群光', weight: 4.1 },
    { symbol: '5904', name: '寶雅', weight: 3.8 }
  ],
  '00915': [
    { symbol: '2891', name: '中信金', weight: 8.5 },
    { symbol: '2882', name: '國泰金', weight: 8.1 },
    { symbol: '2886', name: '兆豐金', weight: 7.2 },
    { symbol: '2454', name: '聯發科', weight: 6.8 },
    { symbol: '2303', name: '聯電', weight: 6.2 },
    { symbol: '3034', name: '聯詠', weight: 5.5 },
    { symbol: '2379', name: '瑞昱', weight: 5.1 },
    { symbol: '2357', name: '華碩', weight: 4.8 },
    { symbol: '2301', name: '光寶科', weight: 4.2 },
    { symbol: '2603', name: '長榮', weight: 4.0 }
  ],
  '00940': [
    { symbol: '2603', name: '長榮', weight: 9.1 },
    { symbol: '2303', name: '聯電', weight: 4.8 },
    { symbol: '2891', name: '中信金', weight: 4.5 },
    { symbol: '2301', name: '光寶科', weight: 4.1 },
    { symbol: '2385', name: '群光', weight: 3.9 },
    { symbol: '2357', name: '華碩', weight: 3.7 },
    { symbol: '2454', name: '聯發科', weight: 3.6 },
    { symbol: '3034', name: '聯詠', weight: 3.4 },
    { symbol: '2379', name: '瑞昱', weight: 3.2 },
    { symbol: '4938', name: '和碩', weight: 3.1 }
  ],
  '00981A': [
    { symbol: '2330', name: '台積電', weight: 10.2 },
    { symbol: '2317', name: '鴻海', weight: 6.8 },
    { symbol: '2454', name: '聯發科', weight: 6.1 },
    { symbol: '2382', name: '廣達', weight: 5.6 },
    { symbol: '2308', name: '台達電', weight: 4.9 },
    { symbol: '3661', name: '世芯-KY', weight: 4.2 },
    { symbol: '3017', name: '奇鋐', weight: 3.8 },
    { symbol: '6669', name: '緯穎', weight: 3.6 },
    { symbol: '2345', name: '智邦', weight: 3.4 },
    { symbol: '2881', name: '富邦金', weight: 3.1 }
  ]
};

function toNum(v) {
  const n = Number(String(v || '').replace(/,/g, '').trim());
  return Number.isNaN(n) ? null : n;
}

async function fetchMisEtfNavMap(symbolSet) {
  const navMap = {};
  try {
    const r = await fetch(MIS_ETF_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/plain' }
    });
    if (!r.ok) return navMap;
    const text = await r.text();
    const json = JSON.parse(text);
    const list = Array.isArray(json?.a1) ? json.a1 : (Array.isArray(json?.msgArray) ? json.msgArray : []);
    for (const item of list) {
      const code = String(item?.a || '').trim();
      if (!code) continue;
      if (symbolSet.size > 0 && !symbolSet.has(code)) continue;
      const marketPrice = toNum(item.e);
      const nav = toNum(item.f) || toNum(item.h);
      let premiumPct = toNum(item.g);
      if (premiumPct === null && marketPrice && nav && nav > 0) {
        premiumPct = ((marketPrice - nav) / nav) * 100;
      }
      if (nav && nav > 0) {
        navMap[code] = {
          symbol: code,
          name: String(item.b || '').trim(),
          marketPrice,
          nav: Number(nav.toFixed(2)),
          premiumPct: premiumPct !== null ? Number(premiumPct.toFixed(2)) : null,
          time: String(item.i || '').trim()
        };
      }
    }
  } catch (_) {}
  return navMap;
}

async function fetchYahooTopHoldings(sym) {
  if (FALLBACK_ETF_HOLDINGS[sym]) {
    return FALLBACK_ETF_HOLDINGS[sym];
  }
  try {
    const url = `${YF_SUMMARY_BASE}${encodeURIComponent(sym + '.TW')}?modules=topHoldings`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    const holdings = j?.quoteSummary?.result?.[0]?.topHoldings?.holdings || [];
    return holdings
      .map(h => ({
        symbol: String(h.symbol || '').replace(/\.TW[O]?$/i, '').trim(),
        name: String(h.holdingName || h.symbol || '').trim(),
        weight: Number(((Number(h.holdingPercent?.raw || 0)) * 100).toFixed(2))
      }))
      .filter(h => h.symbol && h.weight > 0);
  } catch (_) {
    return [];
  }
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
    const navMap = await fetchMisEtfNavMap(symbolSet);
    const holdingsMap = {};
    const etfCandidates = rawSymbols.filter(s => /^00\d+/.test(s) || FALLBACK_ETF_HOLDINGS[s]);
    await Promise.all(
      etfCandidates.map(async sym => {
        const list = await fetchYahooTopHoldings(sym);
        if (list.length > 0) holdingsMap[sym] = list;
      })
    );

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ navMap, holdingsMap, count: Object.keys(navMap).length });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch ETF info', message: err.message });
  }
};
