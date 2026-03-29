const https = require('https');
const http  = require('http');

// ── HTTP helper with redirect support ─────────────────────────────────────
function fetchUrl(urlStr, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith('https') ? https : http;
    const defaultHeaders = {
      'User-Agent': 'FeedFlow/1.0 (personal RSS reader)',
      'Accept': 'application/json, application/rss+xml, application/xml, text/xml, */*',
    };
    const options = { headers: { ...defaultHeaders, ...customHeaders } };

    const req = client.get(urlStr, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).href;
        return fetchUrl(next, customHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── Check if Reddit blocked the response ──────────────────────────────────
function isRedditBlocked(raw) {
  return (
    raw.includes('whoa there') ||
    raw.includes('Our CDN was unable') ||
    raw.includes('please try again') ||
    raw.trimStart().startsWith('<!') ||   // any HTML page = blocked
    raw.trimStart().startsWith('<html')
  );
}

// ── Parse Reddit's native JSON API response ───────────────────────────────
function parseRedditJson(raw, urlParam) {
  const data = JSON.parse(raw);
  const posts = data?.data?.children || [];

  const subMatch = urlParam.match(/\/r\/([^/?]+)/);
  const subName  = subMatch ? `r/${subMatch[1]}` : 'Reddit';
  const channel  = { title: posts[0]?.data?.subreddit_name_prefixed || subName };

  const items = posts
    .filter(({ data: p }) => p && (p.title || p.url))
    .map(({ data: p }) => {
      let thumbnail = '';
      if (p.preview?.images?.[0]?.source?.url) {
        thumbnail = p.preview.images[0].source.url.replace(/&amp;/g, '&');
      } else if (p.thumbnail && p.thumbnail.startsWith('http')) {
        thumbnail = p.thumbnail;
      }

      const description = (p.selftext || p.url_overridden_by_dest || '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

      return {
        title:       p.title       || '',
        link:        `https://reddit.com${p.permalink}`,
        description,
        pubDate:     new Date(p.created_utc * 1000).toISOString(),
        author:      p.author      || '',
        thumbnail,
        guid:        p.id          || p.name,
        category:    p.link_flair_text || '',
        score:       p.score       || 0,
        numComments: p.num_comments || 0,
      };
    });

  return { channel, items };
}

// ── Parse rss2json.com proxy response ────────────────────────────────────
function parseRss2Json(raw, urlParam) {
  const data = JSON.parse(raw);

  if (data.status !== 'ok') {
    throw new Error(`rss2json error: ${data.message || 'unknown'}`);
  }

  const subMatch = urlParam.match(/\/r\/([^/?]+)/);
  const subName  = subMatch ? `r/${subMatch[1]}` : (data.feed?.title || 'Reddit');
  const channel  = { title: data.feed?.title || subName };

  const items = (data.items || []).map(p => ({
    title:       p.title       || '',
    link:        p.link        || '',
    description: (p.description || p.content || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    pubDate:     p.pubDate ? new Date(p.pubDate).toISOString() : new Date().toISOString(),
    author:      p.author      || '',
    thumbnail:   p.thumbnail   || '',
    guid:        p.guid        || p.link,
    category:    Array.isArray(p.categories) ? (p.categories[0] || '') : '',
  }));

  return { channel, items };
}

// ── Atom feed parser ──────────────────────────────────────────────────────
function parseAtom(xml) {
  const get = (block, tag) => {
    const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
    return (block.match(r)?.[1] || '').trim();
  };
  const getAttr = (block, tag, attr) => {
    const r = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*\\/?>`, 'i');
    return block.match(r)?.[1] || '';
  };

  const titleMatch = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
  const channel = { title: (titleMatch?.[1] || 'Feed').trim() };

  const items = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const rawDesc = get(block, 'content') || get(block, 'summary');
    const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

    let thumbnail = '';
    const imgSrc = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgSrc) thumbnail = imgSrc[1];

    const link  = getAttr(block, 'link', 'href') || get(block, 'link');
    const title = get(block, 'title');
    if (!title && !link) continue;

    items.push({
      title,
      link,
      description,
      pubDate:  new Date(get(block, 'updated') || get(block, 'published') || Date.now()).toISOString(),
      author:   (get(block, 'name') || get(block, 'author')).replace(/<[^>]+>/g, '').trim(),
      thumbnail,
      guid:     get(block, 'id') || link,
      category: getAttr(block, 'category', 'term') || get(block, 'category'),
    });
  }
  return { channel, items };
}

// ── RSS 2.0 parser ────────────────────────────────────────────────────────
function parseRss(xml) {
  const get = (block, tag) => {
    const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
    return (block.match(r)?.[1] || '').trim();
  };
  const getAttr = (block, tag, attr) => {
    const r = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i');
    return block.match(r)?.[1] || '';
  };

  const titleMatch = xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
  const channel = { title: (titleMatch?.[1] || 'RSS Feed').trim() };

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const rawDesc = get(block, 'description');
    const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

    let thumbnail = getAttr(block, 'media:thumbnail', 'url')
      || getAttr(block, 'media:content', 'url')
      || getAttr(block, 'enclosure', 'url')
      || '';
    if (!thumbnail) {
      const imgSrc = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgSrc) thumbnail = imgSrc[1];
    }

    const link  = get(block, 'link') || getAttr(block, 'link', 'href');
    const title = get(block, 'title');
    if (!title && !link) continue;

    const rawDate = get(block, 'pubDate') || get(block, 'dc:date') || get(block, 'published');

    items.push({
      title,
      link,
      description,
      pubDate:  rawDate ? new Date(rawDate).toISOString() : new Date().toISOString(),
      author:   (get(block, 'author') || get(block, 'dc:creator')).replace(/<[^>]+>/g, '').trim(),
      thumbnail,
      guid:     get(block, 'guid') || get(block, 'id') || link,
      category: get(block, 'category'),
    });
  }
  return { channel, items };
}

// ── Netlify handler ───────────────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const urlParam = event.queryStringParameters?.url;
  if (!urlParam) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }

  try {
    const isReddit = urlParam.includes('reddit.com');

    // ── REDDIT PATH ──────────────────────────────────────────────────────
    if (isReddit) {
      // Step 1: try Reddit's own JSON API
      const jsonUrl = urlParam
        .replace(/\/\.rss(\?.*)?$/, '.json$1')
        .replace(/\.rss(\?.*)?$/,   '.json$1');

      let raw, usedProxy = false;

      try {
        console.log(`Reddit: trying direct JSON → ${jsonUrl}`);
        raw = await fetchUrl(jsonUrl, {
          'User-Agent': 'FeedFlow/1.0 (personal RSS reader)',
          'Accept': 'application/json',
        });

        if (isRedditBlocked(raw)) {
          throw new Error('Reddit blocked the direct request (datacenter IP)');
        }
      } catch (directErr) {
        // Step 2: fall back to rss2json.com proxy
        console.log(`Reddit direct failed (${directErr.message}), trying rss2json proxy…`);
        const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(urlParam)}&count=25`;
        raw = await fetchUrl(proxyUrl, { 'Accept': 'application/json' });
        usedProxy = true;
      }

      const { channel, items } = usedProxy
        ? parseRss2Json(raw, urlParam)
        : parseRedditJson(raw, urlParam);

      console.log(`Reddit (${usedProxy ? 'rss2json proxy' : 'direct'}) → ${items.length} items`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ channel, items, fetchedAt: new Date().toISOString() }),
      };
    }

    // ── GENERIC RSS / ATOM PATH ──────────────────────────────────────────
    const raw = await fetchUrl(urlParam);
    console.log(`Feed preview: ${raw.slice(0, 120).replace(/\n/g, ' ')}`);

    let result;
    if (raw.includes('<feed') || raw.includes('xmlns="http://www.w3.org/2005/Atom"')) {
      result = parseAtom(raw);
      console.log(`Atom → ${result.items.length} items`);
    } else {
      result = parseRss(raw);
      console.log(`RSS → ${result.items.length} items`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...result, fetchedAt: new Date().toISOString() }),
    };

  } catch (err) {
    console.error('rss function error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

