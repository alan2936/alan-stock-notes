// Vercel Serverless Function: 透過 Google News RSS 抓取台股個股新聞與「巴逆逆」最新動態
function decodeXml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const block of itemMatches.slice(0, 12)) {
    const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const srcRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || 'Google 新聞';

    const fullTitle = decodeXml(titleRaw);
    const source = decodeXml(srcRaw);
    const cleanTitle = fullTitle.replace(/\s*-\s*[^-]+$/, '').trim() || fullTitle;
    let dateStr = '';
    if (pubRaw) {
      const d = new Date(pubRaw);
      if (!Number.isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 10);
    }
    if (cleanTitle && linkRaw) {
      items.push({
        title: cleanTitle,
        link: decodeXml(linkRaw),
        source,
        date: dateStr
      });
    }
  }
  return items;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = String(req.query.q || '台股').trim();
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

  try {
    const r = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, text/xml' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const items = parseRssItems(xml);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ query: q, items, count: items.length });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch news RSS', message: err.message });
  }
};
