#!/usr/bin/env node
// Liveness checker for the internal econsec source directory.
// Reads data/econsec/sources.json, probes each source URL, and writes the
// results (status / last_checked / final_url, plus RSS autodetection into mr)
// back into the same file, preserving its one-line-per-source format.
//
// Status semantics (see handoff spec):
//   ok             2xx
//   redirect       permanent redirect (301/308) that changed the host
//   blocked        401/403/405/407/429/999 (auth-required or bot-blocked;
//                  manual review queue, NOT dead)
//   dead_candidate first failure (DNS/timeout/5xx) - not confirmed yet
//   dead           failed again on the following run
//   skip           skip-listed domains and url=null entries
//
// Runs standalone on node >= 18 (global fetch), no dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const DATA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../data/econsec/sources.json');

// webgate.ec.europa.eu (EU FSF) always demands EU Login auth - probing it
// tells us nothing, so it must never be marked dead.
const SKIP_DOMAINS = ['x.com', 'facebook.com', 't.me', 'weibo.com', 'webgate.ec.europa.eu'];
const TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const MAX_REDIRECTS = 10;
const PERMANENT_REDIRECTS = new Set([301, 308]);
// 401/407 are auth challenges: the site is alive but requires credentials,
// so they must be classified as blocked before any dead_candidate verdict.
const BLOCKED_STATUSES = new Set([401, 403, 405, 407, 429, 999]);
// Real-browser-equivalent User-Agent: many government/媒体 sites reject
// default fetch UAs outright.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REQUEST_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en;q=0.8',
};

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isSkipDomain(url) {
  const host = hostOf(url);
  if (!host) return true;
  return SKIP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function detectRssLinks(html) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  return links.some((tag) => {
    const rel = /rel\s*=\s*["']?alternate["']?/i.test(tag);
    const type = /type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag);
    return rel && type;
  });
}

// Follows redirects manually so permanent (301/308) host changes can be
// distinguished from temporary ones.
async function probe(url) {
  const originalHost = hostOf(url);
  let current = url;
  let permanentHostChange = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      res.body?.cancel().catch(() => {});
      if (!location) return { kind: 'fail', detail: `redirect ${res.status} without location` };
      const next = new URL(location, current).toString();
      if (PERMANENT_REDIRECTS.has(res.status) && hostOf(next) !== originalHost) {
        permanentHostChange = true;
      }
      current = next;
      continue;
    }

    if (res.ok) {
      let hasRss = false;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('html')) {
        try {
          hasRss = detectRssLinks(await res.text());
        } catch {
          // body read failure does not affect liveness verdict
        }
      } else {
        res.body?.cancel().catch(() => {});
      }
      return {
        kind: permanentHostChange ? 'redirect' : 'ok',
        finalUrl: current,
        hasRss,
      };
    }

    res.body?.cancel().catch(() => {});
    if (BLOCKED_STATUSES.has(res.status)) {
      return { kind: 'blocked', finalUrl: current, detail: `HTTP ${res.status}` };
    }
    return { kind: 'fail', detail: `HTTP ${res.status}` };
  }
  return { kind: 'fail', detail: 'too many redirects' };
}

export function applyResult(source, result, now) {
  source.last_checked = now;

  if (result.kind === 'fail') {
    // Never confirm dead on a single run: first failure becomes a candidate,
    // a failure on the following run confirms it.
    const previouslyFailing = source.status === 'dead' || source.status === 'dead_candidate';
    source.status = previouslyFailing ? 'dead' : 'dead_candidate';
    return;
  }

  source.status = result.kind;

  if (result.finalUrl && result.finalUrl !== source.url) {
    source.final_url = result.finalUrl;
  } else {
    delete source.final_url;
  }

  if (result.kind === 'redirect' && !String(source.notes || '').includes('旧URL')) {
    const note = `旧URL: ${source.url}`;
    source.notes = source.notes ? `${source.notes}｜${note}` : note;
  }

  if (result.hasRss && !source.mr.includes('rss')) {
    source.mr = [...source.mr.filter((m) => m !== 'none' && m !== 'unknown'), 'rss'];
  }
}

// Preserves the file layout: pretty-printed meta, one line per source.
export function serialize(data) {
  const meta = JSON.stringify(data.meta, null, 2).replace(/\n/g, '\n  ');
  const rows = data.sources.map((s, i) => {
    const one = JSON.stringify(s, null, 1)
      .replace(/\n\s*/g, ' ')
      .replace(/\[ /g, '[')
      .replace(/ \]/g, ']');
    return `    ${one}${i < data.sources.length - 1 ? ',' : ''}`;
  });
  return `{\n  "meta": ${meta},\n  "sources": [\n${rows.join('\n')}\n  ]\n}\n`;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
  const now = new Date().toISOString();

  const queue = [];
  for (const source of data.sources) {
    if (!source.url || isSkipDomain(source.url)) {
      source.status = 'skip';
      source.last_checked = now;
      continue;
    }
    queue.push(source);
  }

  console.log(`checking ${queue.length} sources (skip: ${data.sources.length - queue.length})`);

  let done = 0;
  const failed = [];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const source = queue.shift();
      let result;
      try {
        result = await probe(source.url);
      } catch (err) {
        result = { kind: 'fail', detail: err?.cause?.code || err?.name || String(err) };
      }
      if (result.kind === 'fail') failed.push(source);
      applyResult(source, result, now);
      done += 1;
      console.log(
        `[${done}] ${source.id}: ${source.status}` +
          (result.detail ? ` (${result.detail})` : '') +
          (result.hasRss ? ' +rss' : ''),
      );
    }
  });
  await Promise.all(workers);

  // In-run retry for transient failures (sequential, gentler pacing). A still
  // failing probe keeps the verdict from the first pass - it must NOT
  // escalate dead_candidate to dead within the same run.
  if (failed.length > 0) {
    console.log(`\nretrying ${failed.length} failed sources...`);
    for (const source of failed) {
      let result;
      try {
        result = await probe(source.url);
      } catch (err) {
        result = { kind: 'fail', detail: err?.cause?.code || err?.name || String(err) };
      }
      if (result.kind !== 'fail') {
        applyResult(source, result, now);
      }
      console.log(`[retry] ${source.id}: ${source.status}` + (result.detail ? ` (${result.detail})` : ''));
    }
  }

  const counts = {};
  for (const s of data.sources) counts[s.status] = (counts[s.status] || 0) + 1;

  writeFileSync(DATA_PATH, serialize(data), 'utf-8');
  console.log('\nresult:', JSON.stringify(counts));
  const missing = data.sources.filter((s) => !s.status || !s.last_checked);
  console.log(`without status/last_checked: ${missing.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERROR checker failed:', err);
    process.exit(1);
  });
}
