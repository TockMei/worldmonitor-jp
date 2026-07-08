export const config = { runtime: 'edge' };

// Aggregates the latest items for every econsec source tagged mr:"rss".
// sources.json stores each source's website URL, not a raw feed href, so
// this discovers the feed the same way scripts/econsec-check.mjs's
// detectRssLinks does (a <link rel="alternate" type="application/rss+xml">
// tag), then fetches and parses that feed itself. There is no reusable
// isomorphic RSS parser in this repo (src/services/rss.ts is browser-only,
// via DOMParser, which the edge runtime does not have), so parsing is
// regex-based here.
//
// Access control: edge middleware (middleware.js) enforces Basic auth on
// /api/internal/*; this handler adds a defense-in-depth check, matching
// api/internal/econsec-sources.js.
import sources from '../../data/econsec/sources.json';
import { checkBasicAuth, unauthorized } from '../_basic-auth.js';

// Mirrors scripts/econsec-check.mjs's SKIP_DOMAINS - kept as a separate copy
// because that script imports node:fs, which the edge runtime cannot load.
const SKIP_DOMAINS = ['x.com', 'facebook.com', 't.me', 'weibo.com', 'webgate.ec.europa.eu'];
const PER_FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 10;
const MAX_ITEMS = 3;
// Hard ceiling on total handler time so a run of slow/hanging sources can't
// push the whole response past the platform's function timeout. Sources not
// reached before the deadline are simply omitted, same as a fetch failure.
const GLOBAL_DEADLINE_MS = 20000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSkipDomain(url) {
  const host = hostOf(url);
  if (!host) return true;
  return SKIP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Feed content is third-party network data. A <link> element containing a
// javascript: URI would otherwise pass through untouched to the client,
// which only HTML-escapes item.link before putting it in an href - escaping
// does not neutralize the URL scheme, so it must be checked here too.
function isSafeHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function decodeEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

// Same <link rel="alternate" type="application/(rss|atom)+xml"> detection as
// scripts/econsec-check.mjs's detectRssLinks, extended to capture the href.
function discoverFeedUrl(html, baseUrl) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of links) {
    const isAlternate = /rel\s*=\s*["']?alternate["']?/i.test(tag);
    const isFeedType = /type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag);
    if (!isAlternate || !isFeedType) continue;
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    try {
      return new URL(hrefMatch[1], baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export function parseFeedItems(xml) {
  const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blockPattern = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = (xml.match(blockPattern) || []).slice(0, MAX_ITEMS);

  const items = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;

    let link = null;
    if (isAtom) {
      const linkMatch =
        block.match(/<link\b[^>]*rel\s*=\s*["']?alternate["']?[^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/i) ||
        block.match(/<link\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
      link = linkMatch ? linkMatch[1] : null;
    } else {
      const linkMatch = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
      link = linkMatch ? decodeEntities(linkMatch[1]) : null;
    }
    if (!link || !isSafeHttpUrl(link)) continue;

    const dateMatch = isAtom
      ? block.match(/<(?:published|updated)\b[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)
      : block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);

    items.push({
      title: decodeEntities(titleMatch[1]),
      link,
      date: dateMatch ? decodeEntities(dateMatch[1]) : null,
    });
  }
  return items;
}

async function feedForSource(source) {
  const html = await fetchText(source.url, PER_FETCH_TIMEOUT_MS);
  const feedUrl = discoverFeedUrl(html, source.url);
  if (!feedUrl) return null;
  const xml = await fetchText(feedUrl, PER_FETCH_TIMEOUT_MS);
  const items = parseFeedItems(xml);
  return items.length ? items : null;
}

// Best-effort warm-instance cache: reduces repeat feed fetches across
// requests hitting the same warm edge isolate. Never consulted before the
// auth check, so it cannot be used to bypass authentication.
let cache = null; // { builtAt: number, feeds: Record<string, FeedItem[]> }
const CACHE_TTL_MS = 900 * 1000;

export async function buildFeeds() {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) {
    return cache.feeds;
  }

  const candidates = sources.sources.filter(
    (s) => Array.isArray(s.mr) && s.mr.includes('rss') && s.url && !isSkipDomain(s.url),
  );

  const startedAt = Date.now();
  const queue = [...candidates];
  const feeds = {};

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      if (Date.now() - startedAt > GLOBAL_DEADLINE_MS) return;
      const source = queue.shift();
      if (!source) continue;
      try {
        const items = await feedForSource(source);
        if (items) feeds[source.id] = items;
      } catch {
        // Silent skip: a single dead/slow feed must not surface as an error.
      }
    }
  });
  await Promise.all(workers);

  cache = { builtAt: Date.now(), feeds };
  return feeds;
}

export default async function handler(request) {
  if (!(await checkBasicAuth(request))) {
    return unauthorized();
  }

  const feeds = await buildFeeds();

  return new Response(JSON.stringify({ generated: new Date().toISOString(), feeds }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // "private" keeps shared/CDN caches from storing this authenticated
      // response (which would otherwise risk serving it to a request that
      // never passed checkBasicAuth); s-maxage/stale-while-revalidate still
      // give the browser's own cache the requested freshness window.
      'Cache-Control': 'private, s-maxage=900, stale-while-revalidate=1800',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
