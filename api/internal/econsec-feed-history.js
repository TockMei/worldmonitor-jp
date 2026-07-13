export const config = { runtime: 'edge' };

// Serves the internal econsec RSS feed-history archive: every mr:"rss"
// source's items (up to 200 / 180 days each), bundled across all sources
// into one file by scripts/econsec-watch.mjs. A per-source endpoint would
// mean one static import per RSS source (dozens), so this mirrors the
// sources.json/alerts.json pattern of a single committed JSON file instead.
// The JSON lives in data/ (NOT public/) and is bundled into this function at
// build time, so it is never exposed as an unauthenticated static asset.
// Access control: edge middleware (middleware.js) enforces Basic auth on
// /api/internal/* and /internal/*; this handler adds a defense-in-depth check
// so a middleware misconfiguration cannot silently expose the data.
import feedHistory from '../../data/econsec/feed-history.json';
import { checkBasicAuth, unauthorized } from '../_basic-auth.js';

export default async function handler(request) {
  if (!(await checkBasicAuth(request))) {
    return unauthorized();
  }

  return new Response(JSON.stringify(feedHistory), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
