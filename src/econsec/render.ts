// Pure rendering/filtering logic for the econsec source directory.
// Kept DOM-free so it can be unit-tested in node.
import type { EconsecAlertsResponse, EconsecFeedItem, EconsecFilterState, EconsecSource, EconsecTier } from './types';

export const TIER_LABELS: Record<EconsecTier | 'all', string> = {
  all: 'すべて',
  '0': '一次発信',
  '1': '機械可読DB',
  '2': '分析',
  '3': '個人',
  raw: '生情報',
};

export const TIER_ORDER: Array<EconsecTier | 'all'> = ['all', '0', '1', '2', '3', 'raw'];

const MR_BADGES: Record<string, string> = {
  rss: 'RSS',
  api: 'API',
  csv: 'CSV',
  xml: 'XML',
};

const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  redirect: 'REDIRECT',
  blocked: 'BLOCKED',
  dead: 'DEAD',
  dead_candidate: 'DEAD候補',
  skip: 'SKIP',
};

const ALERT_SOURCE_LABELS: Record<string, string> = {
  csl: 'Trade.gov CSL',
  'ofac-sdn': 'OFAC SDN',
  'ofac-consolidated': 'OFAC Non-SDN(NS-CMIC含む)',
  uksl: '英UKSL',
  'un-consolidated': '国連統合リスト',
  'meti-foreign-user-list': 'METI外国ユーザーリスト',
  'mof-sanctions': '財務省制裁リスト',
};

const ALERT_WINDOW_DAYS = 30;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escapeHtml only neutralizes HTML metacharacters, not the URL scheme - an
// href="javascript:..." still executes on click even when escaped. Feed
// items in particular come from third-party RSS/Atom content fetched over
// the network (econsec-feeds.js), so every href must be scheme-checked
// before being placed in markup, not just HTML-escaped.
export function isSafeHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function uniqueValues(sources: EconsecSource[], key: 'region' | 'category' | 'cost'): string[] {
  return [...new Set(sources.map((s) => s[key]))].sort();
}

export function filterSources(sources: EconsecSource[], state: EconsecFilterState): EconsecSource[] {
  const query = state.query.trim().toLowerCase();
  return sources.filter((s) => {
    if (state.tier !== 'all' && s.tier !== state.tier) return false;
    if (state.region !== 'all' && s.region !== state.region) return false;
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (state.cost !== 'all' && s.cost !== state.cost) return false;
    if (query) {
      const haystack = [s.name, s.id, s.notes, s.url || '', s.region, s.category, s.lang]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function tierCounts(sources: EconsecSource[]): Record<EconsecTier | 'all', number> {
  const counts = { all: sources.length, '0': 0, '1': 0, '2': 0, '3': 0, raw: 0 };
  for (const s of sources) counts[s.tier] += 1;
  return counts;
}

function renderMrBadges(mr: string[]): string {
  return mr
    .filter((m) => m in MR_BADGES)
    .map((m) => `<span class="badge badge-mr badge-mr-${m}">${MR_BADGES[m]}</span>`)
    .join('');
}

function renderStatusBadge(s: EconsecSource): string {
  if (!s.status) return '<span class="badge badge-status badge-status-unchecked">未チェック</span>';
  const label = STATUS_LABELS[s.status] || escapeHtml(s.status);
  const checked = s.last_checked ? ` title="checked: ${escapeHtml(s.last_checked)}"` : '';
  return `<span class="badge badge-status badge-status-${escapeHtml(s.status)}"${checked}>${label}</span>`;
}

export function renderSourceRow(s: EconsecSource): string {
  const name = s.url && isSafeHttpUrl(s.url)
    ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.name)}</a>`
    : `<span class="source-name-nolink">${escapeHtml(s.name)}</span>`;
  const verifyBadge = s.verify
    ? `<span class="badge badge-verify" title="${escapeHtml(s.verify)}">要確認</span>`
    : '';
  const noLinkNote = s.url
    ? ''
    : '<span class="badge badge-nolink">リンクなし</span>';
  const tags = [
    `<span class="tag tag-tier">T${escapeHtml(s.tier)}</span>`,
    `<span class="tag">${escapeHtml(s.region)}</span>`,
    `<span class="tag">${escapeHtml(s.category)}</span>`,
    `<span class="tag">${escapeHtml(s.lang)}</span>`,
    `<span class="tag tag-cost-${escapeHtml(s.cost)}">${escapeHtml(s.cost)}</span>`,
  ].join('');
  // Feed items are filled in later (client-side, once /internal/econsec/feeds.json
  // resolves) via populateFeedContainer; only sources tagged mr:"rss" get a
  // container at all, so a plain link is all a non-RSS source ever shows.
  const feedContainer = s.mr.includes('rss')
    ? `<div class="source-feed" data-feed-for="${escapeHtml(s.id)}"></div>`
    : '';
  return `
    <div class="source-row" data-id="${escapeHtml(s.id)}" data-tier="${escapeHtml(s.tier)}">
      <div class="source-row-main">
        <span class="source-name">${name}</span>
        ${noLinkNote}
        ${renderMrBadges(s.mr)}
        ${renderStatusBadge(s)}
        ${verifyBadge}
      </div>
      <div class="source-row-tags">${tags}</div>
      <div class="source-row-notes">${escapeHtml(s.notes)}</div>
      ${feedContainer}
    </div>`;
}

export function renderSourceList(sources: EconsecSource[]): string {
  if (sources.length === 0) {
    return '<div class="source-empty">該当するソースがありません</div>';
  }
  return sources.map(renderSourceRow).join('\n');
}

export function renderFeedItems(items: EconsecFeedItem[]): string {
  // Defense-in-depth: econsec-feeds.js already drops non-http(s) links
  // server-side, but item.link is third-party network content, so it is
  // re-checked here before ever reaching an href.
  const safeItems = items.filter((item) => isSafeHttpUrl(item.link));
  if (safeItems.length === 0) return '';
  return `<ul class="source-feed-list">${safeItems
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>${
          item.date ? `<span class="source-feed-date">${escapeHtml(item.date)}</span>` : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

// Fills every rendered source card's feed container from the aggregated
// /internal/econsec/feeds.json payload. Cards for sources with no returned
// items (feed fetch failed/skipped/empty) are left untouched - link-only.
export function populateFeedContainers(feeds: Record<string, EconsecFeedItem[]>): void {
  document.querySelectorAll<HTMLElement>('[data-feed-for]').forEach((el) => {
    const items = feeds[el.dataset.feedFor || ''];
    if (items && items.length > 0) {
      el.innerHTML = renderFeedItems(items);
    }
  });
}

function formatJst(iso: string | null): string {
  if (!iso) return '未実行';
  const jst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(
    jst.getUTCHours(),
  )}:${pad(jst.getUTCMinutes())} JST`;
}

// Renders the entity-level diff log for the six regulatory sources watched
// by scripts/econsec-watch.mjs: last 30 days, newest first, empty state
// shows the last successful run time so a quiet week reads as "checked",
// not "broken".
export function renderAlertsPanel(data: EconsecAlertsResponse): string {
  const cutoff = Date.now() - ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = data.alerts
    .filter((a) => new Date(a.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const header = `
    <div class="econsec-alerts-header">
      <h2>規制アラート</h2>
      <span class="econsec-alerts-updated">最終確認: ${escapeHtml(formatJst(data.meta.generated))}</span>
    </div>`;

  if (recent.length === 0) {
    return `${header}<div class="econsec-alerts-empty">差分なし</div>`;
  }

  const rows = recent
    .map((a) => {
      const label = ALERT_SOURCE_LABELS[a.source] || a.source;
      const badge =
        a.type === 'add'
          ? '<span class="badge alert-badge-add">追加</span>'
          : '<span class="badge alert-badge-remove">削除</span>';
      return `
      <div class="econsec-alert-row">
        ${badge}
        <span class="econsec-alert-entity">${escapeHtml(a.entity)}</span>
        <span class="econsec-alert-source">${escapeHtml(label)}</span>
        <span class="econsec-alert-detail">${escapeHtml(a.detail)}</span>
        <span class="econsec-alert-date">${escapeHtml(formatJst(a.date))}</span>
      </div>`;
    })
    .join('');

  return `${header}<div class="econsec-alerts-list">${rows}</div>`;
}
