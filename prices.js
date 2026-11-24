// Vercel Serverless Function: 抓取台灣證券交易所 (TWSE) 與櫃買中心 (TPEx) 最新收盤價
const TWSE_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TPEX_URL = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes';

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
    const [twseRes, tpexRes] = await Promise.all([
      fetch(TWSE_URL, { headers: { Accept: 'application/json' } }),
      fetch(TPEX_URL, { headers: { Accept: 'application/json' } })
    ]);

    const prices = {};

    if (twseRes.ok) {
      const twseRows = await twseRes.json();
      if (Array.isArray(twseRows)) {
        for (const row of twseRows) {
          const code = String(row.Code || '').trim();
          if (!code || (symbolSet.size > 0 && !symbolSet.has(code))) continue;
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

    // Vercel Edge Cache: 快取 5 分鐘，過期後背景更新 10 分鐘
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
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
