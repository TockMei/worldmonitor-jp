#!/usr/bin/env node
// Entity-level diff watcher for export-control / sanctions screening lists
// (econsec Step 9, Phase A).
//
// For each source below: fetch the current bulk file, normalize it into
// {id -> {name, list}} entities, diff against the last snapshot in
// data/econsec/watch/<id>.json, and append add/remove events to
// data/econsec/alerts.json (pruned to the last 90 days).
//
// First run per source writes a baseline snapshot only - no diff is taken
// against an empty/missing snapshot, so the initial full list never floods
// alerts.json as a wall of "additions".
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
const SUMMARY_PATH = resolve(ROOT, 'econsec-watch-summary.md');

const TIMEOUT_MS = 30000;
const RETENTION_DAYS = 90;
const MAX_ENTITIES_PER_ISSUE_SOURCE = 50;
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
  return createHash('sha1').update(parts.join('')).digest('hex').slice(0, 16);
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
];

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
      lines.push(`- [${item.type === 'add' ? '+' : '-'}] ${item.entity}${item.detail ? ` (${item.detail})` : ''}`);
    }
    if (items.length > MAX_ENTITIES_PER_ISSUE_SOURCE) {
      lines.push(`...ほか${items.length - MAX_ENTITIES_PER_ISSUE_SOURCE}件`);
    }
    lines.push('');
  }
  writeFileSync(SUMMARY_PATH, lines.join('\n'), 'utf-8');
}

async function main() {
  if (!existsSync(WATCH_DIR)) mkdirSync(WATCH_DIR, { recursive: true });
  const now = new Date();
  const nowIso = now.toISOString();

  const alertsData = loadAlerts();
  let alerts = alertsData.alerts || [];
  const newAlertsThisRun = [];
  const summary = [];

  for (const source of SOURCES) {
    console.log(`\n[${source.id}] fetching...`);
    let result;
    try {
      result = await source.fetchEntities();
    } catch (err) {
      console.warn(`[${source.id}] SKIP (fetch/parse failed): ${err.message}`);
      summary.push({ id: source.id, status: 'skip', error: err.message });
      continue;
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

      for (const id of currIds) {
        if (prevIds.has(id)) continue;
        const e = entities.get(id);
        const alert = { date: nowIso, source: source.id, type: 'add', entity: e.name, detail: e.list };
        alerts.push(alert);
        newAlertsThisRun.push(alert);
      }
      for (const id of prevIds) {
        if (currIds.has(id)) continue;
        const e = prevEntities[id];
        const alert = { date: nowIso, source: source.id, type: 'remove', entity: e.name, detail: e.list };
        alerts.push(alert);
        newAlertsThisRun.push(alert);
      }
    }

    saveSnapshot(source.id, {
      id: source.id,
      label: source.label,
      generated: nowIso,
      resolvedUrl,
      count: entities.size,
      entities: Object.fromEntries(entities),
    });

    summary.push({ id: source.id, status: 'ok', count: entities.size, resolvedUrl });
  }

  alerts = pruneOldAlerts(alerts, now.getTime());
  saveAlerts({ meta: { generated: nowIso }, alerts });
  writeGithubOutput(newAlertsThisRun);

  console.log('\n=== summary ===');
  for (const s of summary) {
    console.log(
      `${s.id}: ${s.status}` + (s.count != null ? ` (${s.count} entities)` : '') + (s.error ? ` - ${s.error}` : ''),
    );
  }
  console.log(`new alerts this run: ${newAlertsThisRun.length}`);
  console.log(`alerts total (last ${RETENTION_DAYS}d): ${alerts.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('ERROR watcher failed:', err);
    process.exit(1);
  });
}
