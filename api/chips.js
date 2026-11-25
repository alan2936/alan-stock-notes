// Vercel Serverless Function: 抓取台股盤後三大法人買賣超 (TWSE T86 / TPEx) 與融資融券變化 (TWSE MI_MARGN)
const TWSE_T86 = 'https://www.twse.com.tw/rwd/zh/fund/T86';
const TWSE_MARGN = 'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN';
const TPEX_3INSTI = 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading';

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isNaN(n) ? 0 : n;
}

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchTwseWithFallback(baseUrl, selectType) {
  // 盤後資料通常 15:00-16:30 後公布，若當日尚未公布或逢假日，最多往回推 5 天找最近交易日
  const baseDate = new Date();
  for (let offset = 0; offset <= 5; offset++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() - offset);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ymd = formatYmd(d);
    const url = `${baseUrl}?response=json&date=${ymd}&selectType=${selectType}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (!r.ok) continue;
      const json = await r.json();
      if (json && json.stat === 'OK') {
        return { ymd, json };
      }
    } catch (_) {
      // Try previous trading day
    }
  }
  return null;
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
  const chips = {};
  let dataDate = '';

  try {
    const [t86Res, margnRes, tpexRes] = await Promise.all([
      fetchTwseWithFallback(TWSE_T86, 'ALLBUT0999'),
      fetchTwseWithFallback(TWSE_MARGN, 'ALL'),
      fetch(TPEX_3INSTI, { headers: { Accept: 'application/json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    ]);

    // 1. 解析上市三大法人 T86 (單位為股 -> 除以 1000 轉成張)
    if (t86Res && Array.isArray(t86Res.json.data)) {
      dataDate = t86Res.ymd;
      const fields = t86Res.json.fields || [];
      const idxCode = fields.findIndex(f => f.includes('證券代號'));
      const idxName = fields.findIndex(f => f.includes('證券名稱'));
      const idxForeign = fields.findIndex(f => f.includes('外陸資買賣超股數(不含外資自營商)'));
      const idxTrust = fields.findIndex(f => f.includes('投信買賣超股數'));
      const idxDealer = fields.findIndex(f => f.includes('自營商買賣超股數'));
      const idxTotal = fields.findIndex(f => f.includes('三大法人買賣超股數'));

      for (const row of t86Res.json.data) {
        const code = String(row[idxCode >= 0 ? idxCode : 0] || '').trim();
        if (!code || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
        const foreign = Math.round(toNum(row[idxForeign >= 0 ? idxForeign : 4]) / 1000);
        const trust = Math.round(toNum(row[idxTrust >= 0 ? idxTrust : 10]) / 1000);
        const dealer = Math.round(toNum(row[idxDealer >= 0 ? idxDealer : 11]) / 1000);
        const total = idxTotal >= 0 ? Math.round(toNum(row[idxTotal]) / 1000) : foreign + trust + dealer;
        chips[code] = {
          symbol: code,
          name: String(row[idxName >= 0 ? idxName : 1] || '').trim(),
          foreign,
          trust,
          dealer,
          total,
          marginDiff: null,
          shortDiff: null,
          shortMarginRatio: null,
          market: 'TWSE'
        };
      }
    }

    // 2. 解析上市融資融券 MI_MARGN (tables[1] 為個股明細)
    if (margnRes && Array.isArray(margnRes.json.tables)) {
      if (!dataDate) dataDate = margnRes.ymd;
      const stockTable = margnRes.json.tables.find(t => Array.isArray(t.fields) && t.fields.some(f => f.includes('代號')));
      if (stockTable && Array.isArray(stockTable.data)) {
        for (const row of stockTable.data) {
          const code = String(row[0] || '').trim();
          if (!code || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
          // 常見欄位順序: [0]代號 [1]名稱 [2]資買 [3]資賣 [4]資現償 [5]資前餘 [6]資今餘 [7]資限額 [8]券買 [9]券賣 [10]券現償 [11]券前餘 [12]券今餘
          const marginPrev = toNum(row[5]);
          const marginCurr = toNum(row[6]);
          const shortPrev = toNum(row[11]);
          const shortCurr = toNum(row[12]);
          if (!chips[code]) {
            chips[code] = {
              symbol: code,
              name: String(row[1] || '').trim(),
              foreign: 0,
              trust: 0,
              dealer: 0,
              total: 0,
              market: 'TWSE'
            };
          }
          chips[code].marginDiff = Math.round(marginCurr - marginPrev);
          chips[code].shortDiff = Math.round(shortCurr - shortPrev);
          chips[code].shortMarginRatio = marginCurr > 0 ? Number(((shortCurr / marginCurr) * 100).toFixed(2)) : 0;
        }
      }
    }

    // 3. 補齊上櫃三大法人 (TPEx OpenAPI)
    if (Array.isArray(tpexRes)) {
      for (const row of tpexRes) {
        const code = String(row.SecuritiesCompanyCode || '').trim();
        if (!code || chips[code] || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
        const foreign = Math.round(toNum(row['ForeignInvestors_NetBuySell'] || row.Foreign_Net || 0) / 1000);
        const trust = Math.round(toNum(row['InvestmentTrust_NetBuySell'] || row.Trust_Net || 0) / 1000);
        const dealer = Math.round(toNum(row['Dealer_NetBuySell'] || row.Dealer_Net || 0) / 1000);
        const total = Math.round(toNum(row['Total_NetBuySell'] || (foreign + trust + dealer) * 1000) / 1000);
        chips[code] = {
          symbol: code,
          name: String(row.CompanyName || '').trim(),
          foreign,
          trust,
          dealer,
          total,
          marginDiff: null,
          shortDiff: null,
          shortMarginRatio: null,
          market: 'TPEx'
        };
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      chips,
      dataDate,
      count: Object.keys(chips).length
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Failed to fetch chips data',
      message: err.message
    });
  }
};
