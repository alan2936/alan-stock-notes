// Vercel Serverless Function: 優先抓取證交所即時/當日最新成交價 (MIS)，失敗時退回 OpenAPI
const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';

function pickMisPrice(item) {
  const tryNums = [
    item.z, // 最新成交價 / 當日收盤價
    item.b ? String(item.b).split('_')[0] : null, // 最佳買價
    item.a ? String(item.a).split('_')[0] : null, // 最佳賣價
    item.y  // 昨日收盤價
  ];
  for (const raw of tryNums) {
    const val = Number(String(raw || '').replace(/,/g, '').trim());
    if (!Number.isNaN(val) && val > 0) return val;
  }
  return 0;
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
  const prices = {};

  try {
    // 1. 優先向證交所 MIS 查詢當日最新成交/收盤價（同時查詢上市 tse 與上櫃 otc）
    if (rawSymbols.length > 0) {
      const channels = rawSymbols.flatMap(s => [`tse_${s}.tw`, `otc_${s}.tw`]).join('|');
      const misUrl = `${MIS_URL}?json=1&delay=0&ex_ch=${encodeURIComponent(channels)}&_=${Date.now()}`;
      const misRes = await fetch(misUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      });

      if (misRes.ok) {
        const misJson = await misRes.json();
        const list = Array.isArray(misJson.msgArray) ? misJson.msgArray : [];
        for (const item of list) {
          const code = String(item.c || '').trim();
          if (!code || prices[code]) continue;
          const p = pickMisPrice(item);
          if (p > 0) {
            const prev = Number(String(item.y || '0').trim()) || 0;
            prices[code] = {
              price: p,
              name: String(item.n || '').trim(),
              change: prev > 0 ? Number((p - prev).toFixed(2)) : 0,
              date: String(item.d || '').trim(),
              market: item.ex === 'otc' ? 'TPEx' : 'TWSE'
            };
          }
        }
      }
    }

    // 2. 若有漏掉的代碼，補查 OpenAPI 備援
    const missing = rawSymbols.filter(s => !prices[s]);
    if (rawSymbols.length === 0 || missing.length > 0) {
      const [twseRes, tpexRes] = await Promise.all([
        fetch(TWSE_URL, { headers: { Accept: 'application/json' } }),
        fetch(TPEX_URL, { headers: { Accept: 'application/json' } })
      ]);

      if (twseRes.ok) {
        const twseRows = await twseRes.json();
        if (Array.isArray(twseRows)) {
          for (const row of twseRows) {
            const code = String(row.Code || '').trim();
            if (!code || prices[code] || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
            const closeVal = Number(String(row.ClosingPrice || '').replace(/,/g, '').trim());
            if (!Number.isNaN(closeVal) && closeVal > 0) {
              prices[code] = {
                price: closeVal,
                name: String(row.Name || '').trim(),
                change: Number(String(row.Change || '0').replace(/,/g, '').trim()) || 0,
                date: String(row.Date || '').trim(),
                market: 'TWSE'
              };
            }
          }
        }
      }

      if (tpexRes.ok) {
        const tpexRows = await tpexRes.json();
        if (Array.isArray(tpexRows)) {
          for (const row of tpexRows) {
            const code = String(row.SecuritiesCompanyCode || '').trim();
            if (!code || prices[code] || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
            const closeVal = Number(String(row.Close || '').replace(/,/g, '').trim());
            if (!Number.isNaN(closeVal) && closeVal > 0) {
              prices[code] = {
                price: closeVal,
                name: String(row.CompanyName || '').trim(),
                change: Number(String(row.Change || '0').replace(/,/g, '').trim()) || 0,
                date: String(row.Date || '').trim(),
                market: 'TPEx'
              };
            }
          }
        }
      }
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      prices,
      count: Object.keys(prices).length,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Failed to fetch TWSE/TPEx data',
      message: err.message
    });
  }
};
