const https = require('https');
const http  = require('http');

// ── HTTP helper with redirect support ──────────────────────────────────────
function fetchUrl(urlStr, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith('https') ? https : http;
    const defaultHeaders = {
      'User-Agent': 'FeedFlow/1.0 (personal RSS reader)',
      'Accept': 'application/json, application/rss+xml, application/xml, text/xml, */*',
    };
    const options = { headers: { ...defaultHeaders, ...customHeaders } };

    const req = client.get(urlStr, options, (res) => {
      // Follow up to 5 redirects
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

// ── Reddit JSON parser ─────────────────────────────────────────────────────
function parseRedditJson(raw, urlParam) {
  const data = JSON.parse(raw);
  const posts = data?.data?.children || [];

  // Derive subreddit name from URL as fallback
  const subMatch = urlParam.match(/\/r\/([^/]+)/);
  const subName  = subMatch ? `r/${subMatch[1]}` : 'Reddit';
  const channel  = { title: posts[0]?.data?.subreddit_name_prefixed || subName };

  const items = posts
    .filter(({ data: p }) => p && (p.title || p.url))
    .map(({ data: p }) => {
      // Best thumbnail: preview image > thumbnail url > ''
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

// ── Atom feed parser ───────────────────────────────────────────────────────
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

// ── RSS 2.0 parser ─────────────────────────────────────────────────────────
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

// ── Netlify handler ────────────────────────────────────────────────────────
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

    if (isReddit) {
      // Convert .rss URL → JSON API URL
      // e.g. reddit.com/r/SaaS/.rss  →  reddit.com/r/SaaS.json
      const jsonUrl = urlParam
        .replace(/\/\.rss(\?.*)?$/, '.json$1')
        .replace(/\.rss(\?.*)?$/,   '.json$1');

      const raw = await fetchUrl(jsonUrl, {
        'User-Agent': 'FeedFlow/1.0 (personal RSS reader; open source)',
        'Accept': 'application/json',
      });

      const { channel, items } = parseRedditJson(raw, urlParam);
      console.log(`Reddit JSON → ${items.length} items from ${urlParam}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ channel, items, fetchedAt: new Date().toISOString() }),
      };
    }

    // Generic RSS / Atom
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

