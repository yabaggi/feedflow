exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing url parameter" }) };
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 RSSViewer/1.0",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // Parse XML into structured items
    const items = [];
    const channel = {};

    // Channel meta
    const titleMatch = xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<channel[^>]*>[\s\S]*?<title[^>]*>(.*?)<\/title>/);
    channel.title = titleMatch ? (titleMatch[1] || titleMatch[2] || "").trim() : "RSS Feed";

    const imgMatch = xml.match(/<channel[^>]*>[\s\S]*?<image>[\s\S]*?<url>(.*?)<\/url>/);
    channel.image = imgMatch ? imgMatch[1].trim() : null;

    // Extract items
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];

      const get = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
        const match = block.match(r);
        return match ? match[1].trim() : "";
      };

      const getAttr = (tag, attr) => {
        const r = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, "i");
        const match = block.match(r);
        return match ? match[1] : "";
      };

      // Thumbnail from media:thumbnail or media:content
      let thumbnail =
        getAttr("media:thumbnail", "url") ||
        getAttr("media:content", "url") ||
        getAttr("enclosure", "url") ||
        "";

      // Try to extract image from description HTML
      if (!thumbnail) {
        const imgSrc = get("description").match(/<img[^>]+src=["']([^"']+)["']/i);
        if (imgSrc) thumbnail = imgSrc[1];
      }

      const rawDate = get("pubDate") || get("dc:date") || get("published");
      const pubDate = rawDate ? new Date(rawDate).toISOString() : new Date().toISOString();

      // Strip HTML from description
      const rawDesc = get("description");
      const description = rawDesc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

      const author =
        get("author") ||
        get("dc:creator") ||
        block.match(/<author><name>(.*?)<\/name>/)?.[1] ||
        "";

      items.push({
        title: get("title"),
        link: get("link") || getAttr("link", "href"),
        description,
        pubDate,
        author: author.replace(/<[^>]+>/g, "").trim(),
        thumbnail,
        guid: get("guid") || get("id") || get("link"),
        category: get("category"),
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ channel, items, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

