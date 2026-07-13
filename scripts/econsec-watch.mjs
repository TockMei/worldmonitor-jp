#!/usr/bin/env node
// Regulatory-list / regulatory-page watcher (econsec Step 9 Phase A + Step 10
// Phase B/C/D).
//
// Three kinds of source, each diffed against its own snapshot in
// data/econsec/watch/<id>.json:
//   - entity  : bulk list -> {id -> {name, list}}, diffed as add/remove
//   - page    : single page -> normalized text lines, diffed as page-change
//               (first changed line, first 200 chars, goes into detail)
//   - fr      : Federal Register API queries -> new document_numbers only
//               (documents scrolling out of the "newest" window are not a
//               removal event, so only additions ever alert)
//
// All diff events append to data/econsec/alerts.json (pruned to the last 90
// days). First run per source writes a baseline snapshot only - no diff is
// taken against an empty/missing snapshot, so an initial full list never
// floods alerts.json as a wall of "additions".
//
// A source whose fetch or parse fails is skipped silently: its snapshot is
// left untouched and no alert is generated for it this run.
//
// Runs standalone on node >= 18 (global fetch + zlib), no dependencies.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_DIR = resolve(ROOT, 'data/econsec/watch');
const ALERTS_PATH = resolve(ROOT, 'data/econsec/alerts.json');
const SOURCES_PATH = resolve(ROOT, 'data/econsec/sources.json');
const FEED_HISTORY_DIR = resolve(ROOT, 'data/econsec/feed-history');
const FEED_HISTORY_BUNDLE_PATH = resolve(ROOT, 'data/econsec/feed-history.json');
const SUMMARY_PATH = resolve(ROOT, 'econsec-watch-summary.md');

const TIMEOUT_MS = 30000;
const RETENTION_DAYS = 90;
const MAX_ENTITIES_PER_ISSUE_SOURCE = 50;
const FEED_HISTORY_RETENTION_DAYS = 180;
const FEED_HISTORY_MAX_PER_SOURCE = 200;
// Mirrors api/internal/econsec-feeds.js's SKIP_DOMAINS - kept as a separate
// copy because that file runs in the edge runtime, which cannot load this
// node:fs-using script, and vice versa.
const FEED_SKIP_DOMAINS = ['x.com', 'facebook.com', 't.me', 'weibo.com', 'webgate.ec.europa.eu'];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

export function hashKey(...parts) {
  return createHash('sha1').update(parts.join('')).digest('hex').slice(0, 16);
}

// ---- Generic delimited-text parser (RFC4180-ish: quoted fields, embedded
// delimiters/newlines inside quotes, "" as an escaped quote). ----
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---- Feed-history helpers (Step 11 Phase A): mirrors the discovery/parsing
// logic in api/internal/econsec-feeds.js, duplicated for the same reason as
// FEED_SKIP_DOMAINS above - that file's edge runtime cannot load node:fs. ----
export function isSafeHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function feedHostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSkipFeedDomain(url) {
  const host = feedHostOf(url);
  if (!host) return true;
  return FEED_SKIP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// Same <link rel="alternate" type="application/(rss|atom)+xml"> detection as
// econsec-feeds.js's discoverFeedUrl.
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

function decodeFeedEntities(value) {
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

// Unlike econsec-feeds.js's card-oriented parseFeedItems (capped to the
// latest 3 items), history accumulation wants everything a feed currently
// lists - RSS/Atom feeds rarely list more than a few dozen entries, so a
// generous cap here is just a safety valve against a pathological feed, not
// a meaningful limit in practice.
const FEED_HISTORY_ITEMS_PER_FETCH = 100;

export function parseFeedItems(xml) {
  const isAtom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blockPattern = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = (xml.match(blockPattern) || []).slice(0, FEED_HISTORY_ITEMS_PER_FETCH);

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
      link = linkMatch ? decodeFeedEntities(linkMatch[1]) : null;
    }
    if (!link || !isSafeHttpUrl(link)) continue;

    const dateMatch = isAtom
      ? block.match(/<(?:published|updated)\b[^>]*>([\s\S]*?)<\/(?:published|updated)>/i)
      : block.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);

    items.push({
      title: decodeFeedEntities(titleMatch[1]),
      link,
      date: dateMatch ? decodeFeedEntities(dateMatch[1]) : null,
    });
  }
  return items;
}

// ---- Minimal HTML table extraction (regex-based - good enough for the
// government table markup this targets; not a general HTML parser). ----
function stripTags(html) {
  return decodeXmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHtmlTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const cells = [];
      const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        cells.push(stripTags(cm[1]));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// ---- Minimal ZIP central-directory reader + XLSX sheet extraction. No
// external dependency: xlsx is just a zip of XML parts, and Node's zlib
// already provides raw DEFLATE inflation. ----
function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('not a valid zip (EOCD not found)');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = {};
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) entries[name] = compressed;
    else if (compressionMethod === 8) entries[name] = inflateRawSync(compressed);
    // other compression methods are not used by xlsx writers in practice - skip silently

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function parseSharedStrings(xmlBuf) {
  if (!xmlBuf) return [];
  const xml = xmlBuf.toString('utf8');
  const items = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
    items.push(decodeXmlEntities(text));
  }
  return items;
}

function parseSheetRows(xmlBuf, sharedStrings) {
  const xml = xmlBuf.toString('utf8');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const cells = [];
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const typeMatch = attrs.match(/\st="([^"]*)"/);
      const type = typeMatch ? typeMatch[1] : 'n';
      let value = '';
      if (type === 's') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const idx = vMatch ? parseInt(vMatch[1], 10) : NaN;
        value = Number.isInteger(idx) ? sharedStrings[idx] || '' : '';
      } else if (type === 'inlineStr') {
        const isMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = isMatch ? decodeXmlEntities(isMatch[1]) : '';
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? decodeXmlEntities(vMatch[1]) : '';
      }
      cells.push(value);
    }
    rows.push(cells);
  }
  return rows;
}

export function parseXlsxRows(buf) {
  const entries = readZipEntries(buf);
  const sharedStrings = parseSharedStrings(entries['xl/sharedStrings.xml']);
  const sheetName = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet found in xlsx');
  return parseSheetRows(entries[sheetName], sharedStrings);
}

// Fallback normalizer for sources with no verifiable stable per-entity ID
// (METI / MOF Japanese-language exports): each row becomes one entity keyed
// by a hash of its full text content, so a changed row reads as a
// remove+add rather than silently vanishing.
function rowsToRowHashEntities(rows) {
  const entities = new Map();
  for (const row of rows) {
    const text = row.map((c) => String(c ?? '').trim()).filter(Boolean).join(' | ');
    if (!text) continue;
    entities.set(hashKey(text), { name: text.slice(0, 160), list: 'row' });
  }
  return entities;
}

// Classic 12-column OFAC SDN/Non-SDN CSV: no header row.
// ent_num,SDN_Name,SDN_Type,Program,Title,Call_Sign,Vess_type,Tonnage,GRT,Vess_flag,Vess_owner,Remarks
function parseOfacCsv(text, label) {
  const rows = parseDelimited(text);
  const entities = new Map();
  for (const r of rows) {
    const id = (r[0] || '').trim();
    if (!id || id === '-0-') continue;
    const name = (r[1] || '').trim();
    if (!name) continue;
    const program = (r[3] || '').trim();
    entities.set(id, { name, list: program && program !== '-0-' ? program : label });
  }
  return entities;
}

async function fetchOfacList(url, label) {
  const res = await fetchText(url);
  const text = await res.text();
  return { resolvedUrl: url, entities: parseOfacCsv(text, label) };
}

async function resolveLinkFromListingPage(listingUrl, linkPattern) {
  const res = await fetchText(listingUrl);
  const html = await res.text();
  const m = html.match(linkPattern);
  if (!m) throw new Error(`could not locate matching link on ${listingUrl}`);
  return new URL(m[1], listingUrl).toString();
}

// Removes every well-formed <tagName>...</tagName> block whose opening tag
// matches openTagTest, tracking nesting depth so a block containing another
// same-named tag (e.g. <section> inside <section>) is not truncated at the
// first inner closing tag - confirmed necessary against real markup (2026-07-13):
// MOFCOM's sidebar is a <section class="rColumnBox"> that itself contains a
// nested <section class="con">.
function stripBalancedTag(html, tagName, openTagTest) {
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}>`, 'gi');
  let result = '';
  let cursor = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const isOpen = m[0][1] !== '/';
    if (!isOpen || !openTagTest(m[0])) continue;
    result += html.slice(cursor, m.index);
    let depth = 1;
    tagRe.lastIndex = m.index + m[0].length;
    let end = html.length;
    let sm;
    while ((sm = tagRe.exec(html))) {
      if (sm[0][1] === '/') {
        depth--;
        if (depth === 0) {
          end = tagRe.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }
    cursor = end;
    tagRe.lastIndex = end;
  }
  result += html.slice(cursor);
  return result;
}

// ---- Page-diff normalization: tag-strip + whitespace-collapse only, one
// line per original source line. Deliberately minimal - aggressive
// normalization (e.g. sorting/deduping lines) hides the exact edits this
// watcher exists to surface. <head> is excluded because it churns on every
// request (asset query strings, nonces) independent of page content; the
// same reasoning applies to <script> blocks, which is where a request-scoped
// token (e.g. MOFCOM's `authorizedReadUnitId`) was confirmed to live
// (2026-07-13) - stripped for every page source, not just MOFCOM's, since a
// <script> block is never meaningful page text to diff on. extraStripFns are
// for source-specific noise that is NOT safe to assume applies generally
// (e.g. MOFCOM's related-articles sidebar - a different CMS template could
// use the same class name for genuine list content, so this is opt-in per
// source, not baked in here). ----
function normalizePage(html, extraStripFns = []) {
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  for (const stripFn of extraStripFns) cleaned = stripFn(cleaned);
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : cleaned;
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// MOFCOM's CMS template renders a "related columns" sidebar
// (<aside class="...jgRBox...">, containing one or more
// <section class="rColumnBox">) alongside the actual list/announcement
// content, which lives in a separately-classed <section class="listCon">.
// Confirmed via direct inspection of the live page (2026-07-13) that this
// sidebar's article list changes independently of the unreliable-entity-list
// content itself, which was producing false-positive page-change alerts.
// Scoped to mofcom-unreliable-entity-list only, not applied generally: this
// is a template quirk of that one page, not a general page-diff concern, and
// mofcom-export-control (a different domain/template) has not been verified
// to have the same structure.
function stripMofcomSidebar(html) {
  return stripBalancedTag(html, 'aside', (tag) => /\bclass="[^"]*\bjgRBox\b[^"]*"/i.test(tag));
}

// Returns both sides of the first differing line, not just the new value -
// a page-change alert with only the new value can't distinguish a real
// content change from a value flapping back and forth between two states
// across runs (confirmed happening in practice, 2026-07-13: acquisition.gov's
// "Last Updated" stamp toggled between two dates across consecutive fetches).
// Showing old -> new lets a human tell the two cases apart at a glance;
// automatically suppressing repeat flips is deliberately NOT done here, since
// a wrong suppression rule risks hiding a genuine change.
function firstDiffLine(oldLines, newLines) {
  const len = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < len; i++) {
    if (oldLines[i] !== newLines[i]) {
      return { oldLine: oldLines[i] ?? '(なし)', newLine: newLines[i] ?? '(なし)' };
    }
  }
  return { oldLine: '', newLine: '' };
}

// ---- Entity-level sources: bulk list -> Map<id, {name, list}> ----
const SOURCES = [
  {
    id: 'csl',
    label: 'Trade.gov Consolidated Screening List',
    async fetchEntities() {
      const url = 'https://data.trade.gov/downloadable_consolidated_screening_list/v1/consolidated.csv';
      const res = await fetchText(url);
      const rows = parseDelimited(await res.text());
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const idxId = header.indexOf('_id');
      const idxSource = header.indexOf('source');
      const idxName = header.indexOf('name');
      if (idxId === -1 || idxName === -1) throw new Error('csl: unexpected header, aborting parse');
      const entities = new Map();
      for (const r of rows.slice(1)) {
        const name = (r[idxName] || '').trim();
        if (!name) continue;
        const id = (r[idxId] || '').trim() || hashKey(name, r[idxSource] || '');
        entities.set(id, { name, list: idxSource !== -1 ? r[idxSource] : 'CSL' });
      }
      return { resolvedUrl: url, entities };
    },
  },
  {
    id: 'ofac-sdn',
    label: 'OFAC SDN List',
    fetchEntities: () =>
      fetchOfacList('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV', 'SDN'),
  },
  {
    id: 'ofac-consolidated',
    label: 'OFAC Non-SDN Consolidated List (incl. NS-CMIC)',
    // CONSOLIDATED.CSV is served but always empty-bodied (confirmed live,
    // 2026-07-11) - CONSOLIDATED.XML on the same export service returns the
    // real data, so the consolidated (non-SDN) list is parsed from XML.
    async fetchEntities() {
      const url = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML';
      const res = await fetchText(url);
      const xml = await res.text();
      const entities = new Map();
      const entryRe = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
      let m;
      while ((m = entryRe.exec(xml))) {
        const body = m[1];
        const field = (tag) => {
          const fm = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
          return fm ? decodeXmlEntities(fm[1].trim()) : '';
        };
        const uid = field('uid');
        if (!uid) continue;
        const name = [field('firstName'), field('lastName')].filter(Boolean).join(' ');
        if (!name) continue;
        const programs = [...body.matchAll(/<program>([\s\S]*?)<\/program>/g)].map((p) =>
          decodeXmlEntities(p[1].trim()),
        );
        entities.set(uid, { name, list: programs.join(';') || 'CONSOLIDATED' });
      }
      if (entities.size === 0) throw new Error('ofac-consolidated: parsed 0 entities - schema may have changed');
      return { resolvedUrl: url, entities };
    },
  },
  {
    id: 'uksl',
    label: 'UK Sanctions List (UKSL, successor to the OFSI Consolidated List)',
    async fetchEntities() {
      const url = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv';
      const res = await fetchText(url);
      const text = await res.text();
      const firstLine = text.slice(0, text.indexOf('\n'));
      const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
      const rows = parseDelimited(text, delimiter);
      // The file leads with a free-text "Report Date: ..." line before the
      // real header row, so the header must be located rather than assumed
      // to be rows[0].
      const headerIdx = rows.findIndex((r) => r.includes('Unique ID'));
      if (headerIdx === -1) throw new Error('uksl: unexpected file (Unique ID header not found)');
      const header = rows[headerIdx].map((h) => h.trim());
      const idxId = header.indexOf('Unique ID');
      const nameIdxs = [1, 2, 3, 4, 5, 6].map((n) => header.indexOf(`Name ${n}`)).filter((i) => i !== -1);
      const idxRegime = header.indexOf('Regime Name');
      const entities = new Map();
      for (const r of rows.slice(headerIdx + 1)) {
        const id = (r[idxId] || '').trim();
        if (!id) continue;
        const name = nameIdxs
          .map((i) => r[i])
          .filter(Boolean)
          .join(' ')
          .trim();
        if (!name) continue;
        entities.set(id, { name, list: idxRegime !== -1 ? r[idxRegime] : 'UKSL' });
      }
      return { resolvedUrl: url, entities };
    },
  },
  {
    id: 'un-consolidated',
    label: 'UN Security Council Consolidated List',
    async fetchEntities() {
      const listingUrl = 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list';
      const xmlUrl = await resolveLinkFromListingPage(listingUrl, /href="([^"]+\.xml)"/i);
      const xmlRes = await fetchText(xmlUrl);
      const xml = await xmlRes.text();
      const entities = new Map();
      const blockRe = /<(INDIVIDUAL|ENTITY)>([\s\S]*?)<\/\1>/g;
      let bm;
      while ((bm = blockRe.exec(xml))) {
        const body = bm[2];
        const field = (tag) => {
          const fm = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
          return fm ? decodeXmlEntities(fm[1].trim()) : '';
        };
        const dataId = field('DATAID');
        if (!dataId) continue;
        const nameParts = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map(field).filter(Boolean);
        const name = nameParts.join(' ') || field('FIRST_NAME');
        if (!name) continue;
        const list = field('UN_LIST_TYPE') || field('REFERENCE_NUMBER') || 'UN Consolidated';
        entities.set(dataId, { name, list });
      }
      if (entities.size === 0) throw new Error('un: parsed 0 entities - schema may have changed');
      return { resolvedUrl: xmlUrl, entities };
    },
  },
  {
    id: 'meti-foreign-user-list',
    label: 'METI 外国ユーザーリスト',
    async fetchEntities() {
      const listingUrl = 'https://www.meti.go.jp/policy/anpo/law05.html';
      const xlsxUrl = await resolveLinkFromListingPage(listingUrl, /href="([^"]+\.xlsx)"/i);
      const res = await fetchText(xlsxUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const rows = parseXlsxRows(buf);
      return { resolvedUrl: xlsxUrl, entities: rowsToRowHashEntities(rows) };
    },
  },
  {
    id: 'mof-sanctions',
    label: '財務省 経済制裁対象者リスト',
    async fetchEntities() {
      const listingUrl = 'https://www.mof.go.jp/policy/international_policy/gaitame_kawase/gaitame/economic_sanctions/list.html';
      const xlsxUrl = await resolveLinkFromListingPage(listingUrl, /href="([^"]+\.xlsx)"/i);
      const res = await fetchText(xlsxUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const rows = parseXlsxRows(buf);
      return { resolvedUrl: xlsxUrl, entities: rowsToRowHashEntities(rows) };
    },
  },
  {
    id: 'dhs-uflpa',
    label: 'DHS UFLPA Entity List',
    // Confirmed live (2026-07-12): three clean <table> blocks with a
    // "Name of Entity" / "Effective Date" header, one row per entity - a
    // genuine entity-level upgrade from a plain page-diff.
    async fetchEntities() {
      const url = 'https://www.dhs.gov/uflpa-entity-list';
      const res = await fetchText(url);
      const html = await res.text();
      const entities = new Map();
      for (const rows of parseHtmlTables(html)) {
        const header = rows[0].map((h) => h.toLowerCase());
        const idxName = header.indexOf('name of entity');
        if (idxName === -1) continue;
        const idxDate = header.indexOf('effective date');
        for (const r of rows.slice(1)) {
          const name = (r[idxName] || '').trim();
          if (!name) continue;
          entities.set(hashKey(name), { name, list: idxDate !== -1 ? r[idxDate] : 'UFLPA' });
        }
      }
      if (entities.size === 0) throw new Error('dhs-uflpa: parsed 0 entities - schema may have changed');
      return { resolvedUrl: url, entities };
    },
  },
];

// EU FSF is opt-in: the export requires a token embedded in the URL itself,
// so EU_FSF_URL must never be logged or written into a committed snapshot
// file - only a fixed placeholder string is ever persisted as resolvedUrl.
// Schema (EU sanctionEntity/nameAlias) is implemented from the documented
// EU FSF format but is NOT verified against a live token URL in this
// environment - re-check the parser once a real EU_FSF_URL is registered.
if (process.env.EU_FSF_URL) {
  SOURCES.push({
    id: 'eu-fsf',
    label: 'EU Financial Sanctions Files (FSF)',
    async fetchEntities() {
      const res = await fetchText(process.env.EU_FSF_URL);
      const xml = await res.text();
      const entities = new Map();
      const entryRe = /<sanctionEntity\b([^>]*)>([\s\S]*?)<\/sanctionEntity>/g;
      let m;
      while ((m = entryRe.exec(xml))) {
        const idMatch = m[1].match(/logicalId="([^"]*)"/);
        const id = idMatch ? idMatch[1] : null;
        if (!id) continue;
        const nameMatch = m[2].match(/<nameAlias\b[^>]*\bwholeName="([^"]*)"/);
        const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : '';
        if (!name) continue;
        entities.set(id, { name, list: 'EU FSF' });
      }
      if (entities.size === 0) throw new Error('eu-fsf: parsed 0 entities - schema may have changed');
      return { resolvedUrl: '(EU_FSF_URL, not logged - contains a token)', entities };
    },
  });
}

// ---- Page-diff sources: single page -> normalized text lines ----
const PAGE_SOURCES = [
  {
    id: 'fcc-covered-list',
    label: 'FCC Covered List',
    async fetchLines() {
      const url = 'https://www.fcc.gov/supplychain/coveredlist';
      const res = await fetchText(url);
      return { resolvedUrl: url, lines: normalizePage(await res.text()) };
    },
  },
  {
    id: 'mofcom-unreliable-entity-list',
    label: '中国商務部 不可靠実体清単',
    async fetchLines() {
      const url = 'https://www.mofcom.gov.cn/zcfb/dwmygl/';
      const res = await fetchText(url, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      return { resolvedUrl: url, lines: normalizePage(await res.text(), [stripMofcomSidebar]) };
    },
  },
  {
    id: 'mofcom-export-control',
    label: '中国商務部 輸出管制公告',
    async fetchLines() {
      const url = 'https://exportcontrol.mofcom.gov.cn/zcfgList.shtml';
      const res = await fetchText(url, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      return { resolvedUrl: url, lines: normalizePage(await res.text()) };
    },
  },
  {
    id: 'acquisition-section-889',
    label: 'acquisition.gov Section 889',
    async fetchLines() {
      const url = 'https://www.acquisition.gov/Section-889-Policies';
      const res = await fetchText(url);
      return { resolvedUrl: url, lines: normalizePage(await res.text()) };
    },
  },
  // FCC Section 214 authorization revocations have no stable, regularly
  // updated LIST page (confirmed via research, 2026-07-12) - only scattered
  // per-carrier order PDFs/press releases exist, so there is nothing
  // meaningful to page-diff. Deferred; see the step-10 report.
];

// ---- Federal Register: new documents since last run, add-only ----
const FR_SOURCE_ID = 'federal-register';
const FR_AGENCY_SLUGS = [
  'industry-and-security-bureau', // BIS
  'foreign-assets-control-office', // OFAC
  'state-department',
  'defense-department',
];
const FR_KEYWORDS = ['1260H', 'Entity List', 'connected vehicles', 'ICTS', 'UFLPA'];
const FR_API_BASE = 'https://www.federalregister.gov/api/v1/documents.json';
const FR_PER_PAGE = 20;
const FR_SEEN_CAP = 1000;

async function fetchFederalRegisterDocs() {
  const queries = [
    ...FR_AGENCY_SLUGS.map(
      (slug) => `${FR_API_BASE}?conditions%5Bagencies%5D%5B%5D=${slug}&per_page=${FR_PER_PAGE}&order=newest`,
    ),
    ...FR_KEYWORDS.map(
      (kw) => `${FR_API_BASE}?conditions%5Bterm%5D=${encodeURIComponent(kw)}&per_page=${FR_PER_PAGE}&order=newest`,
    ),
  ];
  const docs = new Map();
  for (const q of queries) {
    const res = await fetchText(q);
    const data = JSON.parse(await res.text());
    for (const d of data.results || []) {
      if (!d.document_number) continue;
      docs.set(d.document_number, { title: d.title, url: d.html_url, date: d.publication_date });
    }
  }
  return docs;
}

function loadSnapshot(id) {
  const p = resolve(WATCH_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function saveSnapshot(id, snapshot) {
  writeFileSync(resolve(WATCH_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
}

function loadAlerts() {
  if (!existsSync(ALERTS_PATH)) return { meta: { generated: null }, alerts: [] };
  return JSON.parse(readFileSync(ALERTS_PATH, 'utf-8'));
}

function saveAlerts(data) {
  writeFileSync(ALERTS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function pruneOldAlerts(alerts, nowMs) {
  const cutoff = nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return alerts.filter((a) => new Date(a.date).getTime() >= cutoff);
}

// ---- Alert linking (Step 11 Phase B): resolve each alert's source to a URL
// on data/econsec/sources.json, so entity add/remove and page-change alerts
// become clickable the same way fr-new already is. ----
function loadSourcesData() {
  if (!existsSync(SOURCES_PATH)) return { sources: [] };
  return JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));
}

function buildSourceUrlLookup(sourcesData) {
  const lookup = new Map();
  for (const s of sourcesData.sources || []) {
    const candidate = s.final_url || s.url;
    if (candidate && isSafeHttpUrl(candidate)) lookup.set(s.id, candidate);
  }
  return lookup;
}

// The watcher's internal source ids (SOURCES/PAGE_SOURCES above) were chosen
// independently of data/econsec/sources.json's OSINT source directory ids -
// the two lists serve different purposes and were curated separately, so
// only some ids happen to line up (csl, eu-fsf). This bridges the ones with
// a genuine 1:1 organizational match; anything not listed here (or not
// present in sources.json under either id) simply gets no alert link.
const WATCH_ID_TO_SOURCE_ID = {
  'ofac-sdn': 'ofac',
  'ofac-consolidated': 'ofac',
  uksl: 'ofsi',
  'un-consolidated': 'un-sc',
  'meti-foreign-user-list': 'meti-anpo',
  'fcc-covered-list': 'fcc-covered',
  'mofcom-unreliable-entity-list': 'mofcom',
  'mofcom-export-control': 'mofcom',
};

function resolveAlertUrl(ctx, watchId) {
  const sourceId = WATCH_ID_TO_SOURCE_ID[watchId] || watchId;
  return ctx.sourceUrlLookup.get(sourceId);
}

// One-time-per-run backfill: alerts written before this feature existed (or
// by a code path that could not resolve a url at creation time) get a url
// filled in retroactively wherever the lookup now resolves one. Alerts that
// already carry a url (fr-new's own document link, or anything resolved on
// a previous run) are left untouched.
function backfillAlertUrls(alerts, ctx) {
  for (const a of alerts) {
    if (a.url) continue;
    const url = resolveAlertUrl(ctx, a.source);
    if (url) a.url = url;
  }
}

// ---- Feed-history accumulation (Step 11 Phase A): every mr:"rss" source's
// feed items, deduped by link and capped per source, so alert consumers can
// browse a source's history beyond the 3-item card preview. ----
function feedHistoryCandidates(sourcesData) {
  return (sourcesData.sources || []).filter(
    (s) => Array.isArray(s.mr) && s.mr.includes('rss') && s.url && !isSkipFeedDomain(s.url),
  );
}

function loadFeedHistorySnapshot(id) {
  const p = resolve(FEED_HISTORY_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function saveFeedHistorySnapshot(id, snapshot) {
  writeFileSync(resolve(FEED_HISTORY_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
}

function saveFeedHistoryBundle(bundle) {
  writeFileSync(FEED_HISTORY_BUNDLE_PATH, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
}

// Merges freshly fetched feed items into existing history: dedup by link
// (a link already on file keeps its original title/date/firstSeen - a later
// fetch of the same link never overwrites it), then keeps the newest
// FEED_HISTORY_MAX_PER_SOURCE entries within FEED_HISTORY_RETENTION_DAYS,
// dropping the rest oldest-first. Ordering and pruning are keyed off
// firstSeen (this script's own run timestamp when the link was first
// observed), not the feed's own pubDate/date, because that field is often
// missing or inconsistently formatted across feeds.
export function mergeFeedHistory(existingItems, newItems, nowIso) {
  const byLink = new Map();
  for (const item of existingItems) byLink.set(item.link, item);
  for (const item of newItems) {
    if (byLink.has(item.link)) continue;
    byLink.set(item.link, { title: item.title, link: item.link, date: item.date, firstSeen: nowIso });
  }
  const cutoffMs = new Date(nowIso).getTime() - FEED_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return [...byLink.values()]
    .filter((item) => new Date(item.firstSeen).getTime() >= cutoffMs)
    .sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime())
    .slice(0, FEED_HISTORY_MAX_PER_SOURCE);
}

async function processFeedHistorySource(source, ctx) {
  console.log(`\n[feed-history:${source.id}] fetching...`);
  const existing = loadFeedHistorySnapshot(source.id);
  const existingItems = existing?.items || [];

  let newItems;
  try {
    const pageRes = await fetchText(source.url);
    const html = await pageRes.text();
    const feedUrl = discoverFeedUrl(html, source.url);
    if (!feedUrl) throw new Error('no <link rel=alternate> feed found');
    const feedRes = await fetchText(feedUrl);
    const xml = await feedRes.text();
    newItems = parseFeedItems(xml);
  } catch (err) {
    console.warn(`[feed-history:${source.id}] SKIP (fetch/parse failed): ${err.message}`);
    // Preserve whatever history already exists on disk in this run's bundle
    // - a transient fetch failure must not make the source vanish from
    // /internal/econsec/feed-history.json.
    if (existingItems.length > 0) ctx.feedHistory[source.id] = existingItems;
    ctx.feedHistorySummary.push({ id: source.id, status: 'skip', error: err.message });
    return;
  }

  const merged = mergeFeedHistory(existingItems, newItems, ctx.nowIso);
  saveFeedHistorySnapshot(source.id, { id: source.id, label: source.name, generated: ctx.nowIso, items: merged });
  ctx.feedHistory[source.id] = merged;
  ctx.feedHistorySummary.push({ id: source.id, status: 'ok', count: merged.length, fetched: newItems.length });
}

// Same worker-pool shape as api/internal/econsec-feeds.js's buildFeeds: with
// 40+ mr:"rss" sources, running these one at a time (as the entity/page/FR
// sources above do) risks pushing the CI job's overall runtime past its
// timeout, since each source is two sequential fetches (page + feed).
const FEED_HISTORY_CONCURRENCY = 6;

async function processFeedHistorySources(candidates, ctx) {
  const queue = [...candidates];
  const workers = Array.from({ length: FEED_HISTORY_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const source = queue.shift();
      if (!source) continue;
      await processFeedHistorySource(source, ctx);
    }
  });
  await Promise.all(workers);
}

function writeGithubOutput(newAlertsThisRun) {
  if (!process.env.GITHUB_OUTPUT) return;
  writeFileSync(process.env.GITHUB_OUTPUT, `new_alerts_count=${newAlertsThisRun.length}\n`, { flag: 'a' });
  if (newAlertsThisRun.length === 0) return;

  const bySource = {};
  for (const a of newAlertsThisRun) {
    (bySource[a.source] ||= []).push(a);
  }
  const lines = ['## econsec 規制リスト差分検知', ''];
  for (const [source, items] of Object.entries(bySource)) {
    lines.push(`### ${source} (${items.length}件)`);
    for (const item of items.slice(0, MAX_ENTITIES_PER_ISSUE_SOURCE)) {
      if (item.type === 'fr-new') {
        lines.push(`- [FR] ${item.entity}${item.url ? ` (${item.url})` : ''}`);
      } else if (item.type === 'page-change') {
        lines.push(`- [CHANGED] ${item.detail}`);
      } else {
        lines.push(`- [${item.type === 'add' ? '+' : '-'}] ${item.entity}${item.detail ? ` (${item.detail})` : ''}`);
      }
    }
    if (items.length > MAX_ENTITIES_PER_ISSUE_SOURCE) {
      lines.push(`...ほか${items.length - MAX_ENTITIES_PER_ISSUE_SOURCE}件`);
    }
    lines.push('');
  }
  writeFileSync(SUMMARY_PATH, lines.join('\n'), 'utf-8');
}

async function processEntitySource(source, ctx) {
  console.log(`\n[${source.id}] fetching...`);
  let result;
  try {
    result = await source.fetchEntities();
  } catch (err) {
    console.warn(`[${source.id}] SKIP (fetch/parse failed): ${err.message}`);
    ctx.summary.push({ id: source.id, status: 'skip', error: err.message });
    return;
  }

  const { resolvedUrl, entities } = result;
  const previous = loadSnapshot(source.id);
  console.log(`[${source.id}] fetched ${entities.size} entities from ${resolvedUrl}`);

  if (!previous) {
    console.log(`[${source.id}] no previous snapshot - writing baseline only (no diff)`);
  } else {
    const prevEntities = previous.entities || {};
    const prevIds = new Set(Object.keys(prevEntities));
    const currIds = new Set(entities.keys());

    const url = resolveAlertUrl(ctx, source.id);
    for (const id of currIds) {
      if (prevIds.has(id)) continue;
      const e = entities.get(id);
      const alert = { date: ctx.nowIso, source: source.id, type: 'add', entity: e.name, detail: e.list, url };
      ctx.alerts.push(alert);
      ctx.newAlertsThisRun.push(alert);
    }
    for (const id of prevIds) {
      if (currIds.has(id)) continue;
      const e = prevEntities[id];
      const alert = { date: ctx.nowIso, source: source.id, type: 'remove', entity: e.name, detail: e.list, url };
      ctx.alerts.push(alert);
      ctx.newAlertsThisRun.push(alert);
    }
  }

  saveSnapshot(source.id, {
    id: source.id,
    label: source.label,
    generated: ctx.nowIso,
    resolvedUrl,
    count: entities.size,
    entities: Object.fromEntries(entities),
  });

  ctx.summary.push({ id: source.id, status: 'ok', count: entities.size, resolvedUrl });
}

async function processPageSource(source, ctx) {
  console.log(`\n[${source.id}] fetching (page-diff)...`);
  let result;
  try {
    result = await source.fetchLines();
  } catch (err) {
    console.warn(`[${source.id}] SKIP (fetch/parse failed): ${err.message}`);
    ctx.summary.push({ id: source.id, status: 'skip', error: err.message });
    return;
  }

  const { resolvedUrl, lines } = result;
  const previous = loadSnapshot(source.id);
  console.log(`[${source.id}] fetched ${lines.length} normalized lines from ${resolvedUrl}`);

  if (!previous) {
    console.log(`[${source.id}] no previous snapshot - writing baseline only (no diff)`);
  } else {
    const prevLines = previous.lines || [];
    const changed = prevLines.length !== lines.length || prevLines.some((l, i) => l !== lines[i]);
    if (changed) {
      const { oldLine, newLine } = firstDiffLine(prevLines, lines);
      const detail = `${oldLine.slice(0, 200)} → ${newLine.slice(0, 200)}`;
      const url = resolveAlertUrl(ctx, source.id);
      const alert = { date: ctx.nowIso, source: source.id, type: 'page-change', entity: source.label, detail, url };
      ctx.alerts.push(alert);
      ctx.newAlertsThisRun.push(alert);
    }
  }

  saveSnapshot(source.id, { id: source.id, label: source.label, generated: ctx.nowIso, resolvedUrl, lines });
  ctx.summary.push({ id: source.id, status: 'ok', count: lines.length, resolvedUrl });
}

async function processFrSource(ctx) {
  console.log(`\n[${FR_SOURCE_ID}] fetching...`);
  let docs;
  try {
    docs = await fetchFederalRegisterDocs();
  } catch (err) {
    console.warn(`[${FR_SOURCE_ID}] SKIP (fetch/parse failed): ${err.message}`);
    ctx.summary.push({ id: FR_SOURCE_ID, status: 'skip', error: err.message });
    return;
  }
  console.log(`[${FR_SOURCE_ID}] fetched ${docs.size} candidate documents`);

  const previous = loadSnapshot(FR_SOURCE_ID);
  if (!previous) {
    console.log(`[${FR_SOURCE_ID}] no previous snapshot - writing baseline only (no diff)`);
  } else {
    const prevSeen = new Set(Object.keys(previous.seen || {}));
    for (const [docNumber, doc] of docs) {
      if (prevSeen.has(docNumber)) continue;
      const alert = {
        date: ctx.nowIso,
        source: FR_SOURCE_ID,
        type: 'fr-new',
        entity: doc.title,
        detail: doc.date,
        url: doc.url,
      };
      ctx.alerts.push(alert);
      ctx.newAlertsThisRun.push(alert);
    }
    // A document scrolling out of the "newest N" window on a later run is
    // not a removal event, so no alert is ever generated for that case.
  }

  const merged = new Map(Object.entries(previous?.seen || {}));
  for (const [docNumber, doc] of docs) merged.set(docNumber, doc);
  const seenEntries = [...merged.entries()].slice(-FR_SEEN_CAP);

  saveSnapshot(FR_SOURCE_ID, {
    id: FR_SOURCE_ID,
    label: 'Federal Register 新着',
    generated: ctx.nowIso,
    count: docs.size,
    seen: Object.fromEntries(seenEntries),
  });

  ctx.summary.push({ id: FR_SOURCE_ID, status: 'ok', count: docs.size });
}

async function main() {
  if (!existsSync(WATCH_DIR)) mkdirSync(WATCH_DIR, { recursive: true });
  if (!existsSync(FEED_HISTORY_DIR)) mkdirSync(FEED_HISTORY_DIR, { recursive: true });
  const now = new Date();
  const sourcesData = loadSourcesData();
  const ctx = {
    nowIso: now.toISOString(),
    alerts: loadAlerts().alerts || [],
    newAlertsThisRun: [],
    summary: [],
    sourceUrlLookup: buildSourceUrlLookup(sourcesData),
    feedHistory: {},
    feedHistorySummary: [],
  };

  // Backfill first, on the alerts loaded from disk, so any alert recorded
  // before this feature existed picks up a url wherever one now resolves.
  backfillAlertUrls(ctx.alerts, ctx);

  for (const source of SOURCES) {
    await processEntitySource(source, ctx);
  }
  for (const source of PAGE_SOURCES) {
    await processPageSource(source, ctx);
  }
  await processFrSource(ctx);

  await processFeedHistorySources(feedHistoryCandidates(sourcesData), ctx);
  saveFeedHistoryBundle({ meta: { generated: ctx.nowIso }, history: ctx.feedHistory });

  const alerts = pruneOldAlerts(ctx.alerts, now.getTime());
  saveAlerts({ meta: { generated: ctx.nowIso }, alerts });
  writeGithubOutput(ctx.newAlertsThisRun);

  console.log('\n=== summary ===');
  for (const s of ctx.summary) {
    console.log(
      `${s.id}: ${s.status}` + (s.count != null ? ` (${s.count})` : '') + (s.error ? ` - ${s.error}` : ''),
    );
  }
  console.log('\n=== feed-history summary ===');
  for (const s of ctx.feedHistorySummary) {
    console.log(
      `${s.id}: ${s.status}` + (s.count != null ? ` (${s.count})` : '') + (s.error ? ` - ${s.error}` : ''),
    );
  }
  console.log(`new alerts this run: ${ctx.newAlertsThisRun.length}`);
  console.log(`alerts total (last ${RETENTION_DAYS}d): ${alerts.length}`);
  console.log(`feed-history sources: ${Object.keys(ctx.feedHistory).length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERROR watcher failed:', err);
    process.exit(1);
  });
}
