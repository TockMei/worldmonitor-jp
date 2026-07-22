// Pure rendering/filtering logic for the econsec source directory.
// Kept DOM-free so it can be unit-tested in node.
import type {
  EconsecAlert,
  EconsecAlertsResponse,
  EconsecAlertType,
  EconsecFeedHistoryItem,
  EconsecFeedItem,
  EconsecFilterState,
  EconsecSource,
  EconsecTier,
} from './types';

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

const MR_DESCRIPTION = '機械取得可能な配信形式。自動監視・履歴蓄積の対象にできる';

const STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  redirect: 'REDIRECT',
  blocked: 'BLOCKED',
  dead: 'DEAD',
  dead_candidate: 'DEAD候補',
  skip: 'SKIP',
};

// Mirrors scripts/econsec-check.mjs's status semantics (see its header
// comment): dead_candidate is the unconfirmed first failure, dead is only
// set after a second consecutive failing run.
const STATUS_DESCRIPTIONS: Record<string, string> = {
  ok: '正常応答',
  redirect: 'URL移転を検知（リンクは新URLへ）',
  blocked: 'bot対策等で自動確認不可（サイト自体は稼働の可能性が高い）',
  dead_candidate: '初回失敗を検知・未確定（要再確認）',
  dead: '連続失敗で確定・要確認',
  skip: 'SNS等、自動死活チェック対象外',
};
const STATUS_UNCHECKED_DESCRIPTION = '自動チェック未実施';

const COST_DESCRIPTIONS: Record<string, string> = {
  free: '無料',
  freemium: '一部無料',
  paid: '有償',
};

// Japanese-first labels for the alert panel's source column. Sources with
// an established Japanese short name use it; the rest follow the "country
// abbreviation + original name" convention (e.g. "EU FSF") rather than a
// forced translation.
const ALERT_SOURCE_LABELS: Record<string, string> = {
  csl: '米CSL統合スクリーニング',
  'ofac-sdn': '米OFAC SDN',
  'ofac-consolidated': '米OFAC Non-SDN(NS-CMIC含む)',
  uksl: '英UKSL',
  'un-consolidated': '国連統合リスト',
  'meti-foreign-user-list': 'METI外国ユーザーリスト',
  'mof-sanctions': '財務省制裁リスト',
  'dhs-uflpa': '米UFLPA EL',
  'eu-fsf': 'EU FSF',
  'fcc-covered-list': '米FCC対象機器リスト',
  'mofcom-unreliable-entity-list': '中国商務部 不可靠実体清単',
  'mofcom-export-control': '中国商務部 輸出管制公告',
  'acquisition-section-889': '米国防権限法889',
  'federal-register': '米官報FR',
};

const ALERT_WINDOW_DAYS = 30;
const ALERT_DETAIL_TRUNCATE_CHARS = 80;

// scripts/econsec-watch.mjs's page-change detail can carry multiple
// "－old／＋new" lines joined by \n; escapeHtml alone would render them
// run-together, so line breaks are re-inserted as <br> after escaping.
function renderMultilineText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

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
    .map((m) => `<span class="badge badge-mr badge-mr-${m}" title="${escapeHtml(MR_BADGES[m] || m)}: ${escapeHtml(MR_DESCRIPTION)}">${MR_BADGES[m]}</span>`)
    .join('');
}

function renderStatusBadge(s: EconsecSource): string {
  if (!s.status) {
    return `<span class="badge badge-status badge-status-unchecked" title="${escapeHtml(STATUS_UNCHECKED_DESCRIPTION)}">未チェック</span>`;
  }
  const label = STATUS_LABELS[s.status] || escapeHtml(s.status);
  const description = STATUS_DESCRIPTIONS[s.status] || '';
  const checked = s.last_checked ? `（checked: ${escapeHtml(s.last_checked)}）` : '';
  return `<span class="badge badge-status badge-status-${escapeHtml(s.status)}" title="${escapeHtml(label)}: ${escapeHtml(description)}${checked}">${label}</span>`;
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
    : '<span class="badge badge-nolink" title="URLが未収録">リンクなし</span>';
  const tags = [
    `<span class="tag tag-tier" title="${escapeHtml(TIER_LABELS[s.tier])}">T${escapeHtml(s.tier)}</span>`,
    `<span class="tag">${escapeHtml(s.region)}</span>`,
    `<span class="tag">${escapeHtml(s.category)}</span>`,
    `<span class="tag">${escapeHtml(s.lang)}</span>`,
    `<span class="tag tag-cost-${escapeHtml(s.cost)}" title="${escapeHtml(COST_DESCRIPTIONS[s.cost] || s.cost)}">${escapeHtml(s.cost)}</span>`,
  ].join('');
  // Feed items are filled in later (client-side, once /internal/econsec/feeds.json
  // resolves) via populateFeedContainer; only sources tagged mr:"rss" get a
  // container at all, so a plain link is all a non-RSS source ever shows.
  // The history toggle (populated from /internal/econsec/feed-history.json,
  // lazily on first expand) sits alongside it for the same rss-only sources.
  const feedContainer = s.mr.includes('rss')
    ? `<div class="source-feed" data-feed-for="${escapeHtml(s.id)}"></div>
       <button type="button" class="source-history-toggle" data-history-toggle="${escapeHtml(s.id)}" aria-expanded="false">履歴</button>
       <div class="source-history" data-history-for="${escapeHtml(s.id)}" hidden></div>`
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

const STATUS_LEGEND_ORDER = ['ok', 'redirect', 'blocked', 'dead_candidate', 'dead', 'skip'] as const;
const COST_LEGEND_ORDER: Array<'free' | 'freemium' | 'paid'> = ['free', 'freemium', 'paid'];
const TIER_LEGEND_ORDER: EconsecTier[] = ['0', '1', '2', '3', 'raw'];

// Legend content behind the source directory's "?" toggle: what each
// implemented badge/tag means, using the same markup (badge span + label)
// shown on the source cards themselves so the legend's colors always match
// what's on screen. Same toggle-behind-"?", default-closed pattern as the
// alert panel (renderAlertLegend above).
export function renderSourceLegend(): string {
  const statusList = STATUS_LEGEND_ORDER
    .map(
      (status) =>
        `<span class="badge badge-status badge-status-${status}">${STATUS_LABELS[status]}</span>${escapeHtml(STATUS_DESCRIPTIONS[status] || '')}`,
    )
    .join('');
  const uncheckedItem = `<span class="badge badge-status badge-status-unchecked">未チェック</span>${escapeHtml(STATUS_UNCHECKED_DESCRIPTION)}`;

  const mrList = Object.entries(MR_BADGES)
    .map(([m, label]) => `<span class="badge badge-mr badge-mr-${m}">${label}</span>`)
    .join('');

  const costList = COST_LEGEND_ORDER
    .map((cost) => `<span class="tag tag-cost-${cost}">${cost}</span>${escapeHtml(COST_DESCRIPTIONS[cost] || '')}`)
    .join('');

  const tierList = TIER_LEGEND_ORDER
    .map((tier) => `<span class="tag tag-tier">T${tier}</span>${escapeHtml(TIER_LABELS[tier])}`)
    .join('');

  return `
    <div class="econsec-source-legend" id="econsec-source-legend" hidden>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">ステータス</span>
        <span class="econsec-legend-badges">${statusList}${uncheckedItem}</span>
      </div>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">機械可読</span>
        <span class="econsec-legend-badges">${mrList}</span>
        <span class="econsec-legend-text">${escapeHtml(MR_DESCRIPTION)}</span>
      </div>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">費用</span>
        <span class="econsec-legend-badges">${costList}</span>
      </div>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">分類</span>
        <span class="econsec-legend-badges">${tierList}</span>
        <span class="econsec-legend-text">ほか地域・言語タグ</span>
      </div>
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

// Full per-source history (newest first, already sorted/capped server-side
// by scripts/econsec-watch.mjs), rendered on demand when a card's history
// toggle is first expanded. Same defense-in-depth link scheme as
// renderFeedItems: third-party content, so the scheme is re-checked here
// even though econsec-watch.mjs already filters non-http(s) links.
export function renderFeedHistoryList(items: EconsecFeedHistoryItem[]): string {
  const safeItems = items.filter((item) => isSafeHttpUrl(item.link));
  if (safeItems.length === 0) return '<div class="source-history-empty">履歴なし</div>';
  return `<ul class="source-history-list">${safeItems
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>${
          item.date ? `<span class="source-history-date">${escapeHtml(item.date)}</span>` : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

function formatJst(iso: string | null): string {
  if (!iso) return '未実行';
  const jst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(
    jst.getUTCHours(),
  )}:${pad(jst.getUTCMinutes())} JST`;
}

const ALERT_TYPE_BADGES: Record<string, string> = {
  add: '<span class="badge alert-badge-add">追加</span>',
  remove: '<span class="badge alert-badge-remove">削除</span>',
  'page-change': '<span class="badge alert-badge-page">変更</span>',
  'fr-new': '<span class="badge alert-badge-fr">官報</span>',
};

// Order for the 7-day summary badge and the legend's badge-meaning list -
// same 4 types as ALERT_TYPE_BADGES, kept as a separate ordered array since
// Record key order isn't guaranteed by the type system.
const ALERT_TYPE_ORDER: EconsecAlertType[] = ['add', 'remove', 'page-change', 'fr-new'];

const WEEKLY_BADGE_LABELS: Record<EconsecAlertType, string> = {
  add: '追加',
  remove: '削除',
  'page-change': '変更',
  'fr-new': '官報',
};

// The alert panel's entity-total figure is not derivable client-side: the
// per-list entity counts only exist in data/econsec/watch/*.json, which is
// not fetched by the browser (only sources/feeds/alerts/feed-history are
// proxied - see vercel.json). Fixed per the 2026-07-22 display-layer-only
// scope decision rather than wiring a new data endpoint for one label.
const ENTITY_TOTAL_LABEL = '約5万件';

const ALERT_WEEK_DAYS = 7;

// yyyy-mm-dd in JST - same +9h shift as formatJst, so "same day" grouping
// always matches the calendar date a human reading the JST-labeled
// timestamps in the panel would expect (an alert at 23:58 UTC and one at
// 00:02 UTC the next day can be the same JST day, or vice versa).
function jstDateKey(iso: string): string {
  const jst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
}

const ALERT_GROUP_MIN_SIZE = 4;

export interface EconsecAlertGroup {
  source: string;
  type: EconsecAlertType;
  alerts: EconsecAlert[];
}

export type EconsecAlertDisplayItem =
  | { kind: 'single'; alert: EconsecAlert }
  | { kind: 'group'; group: EconsecAlertGroup };

// Collapses runs of ALERT_GROUP_MIN_SIZE+ consecutive alerts (consecutive in
// the already newest-first sorted list, not a global group-by) sharing the
// same JST calendar day, source, and type into one aggregate item - e.g. a
// 30-entity OFAC SDN add batch from one run becomes one summary row instead
// of 30. Runs of ALERT_GROUP_MIN_SIZE-1 or fewer stay as individual items,
// and grouping only ever merges alerts that were already adjacent in the
// time-sorted display, so it never reorders anything.
export function groupAlertsForDisplay(alerts: EconsecAlert[]): EconsecAlertDisplayItem[] {
  const items: EconsecAlertDisplayItem[] = [];
  let i = 0;
  while (i < alerts.length) {
    const first = alerts[i];
    if (!first) break;
    const day = jstDateKey(first.date);
    let j = i + 1;
    for (; j < alerts.length; j++) {
      const next = alerts[j];
      if (!next || jstDateKey(next.date) !== day || next.source !== first.source || next.type !== first.type) break;
    }
    const run = alerts.slice(i, j);
    if (run.length >= ALERT_GROUP_MIN_SIZE) {
      items.push({ kind: 'group', group: { source: first.source, type: first.type, alerts: run } });
    } else {
      for (const alert of run) items.push({ kind: 'single', alert });
    }
    i = j;
  }
  return items;
}

// Single alert row - shared by the top-level list and by a group's expanded
// members, so the expanded format is guaranteed identical to the
// non-grouped case (same link/detail-truncation/toggle markup either way).
function renderAlertRow(a: EconsecAlert, key: string): string {
  const label = ALERT_SOURCE_LABELS[a.source] || a.source;
  const badge = ALERT_TYPE_BADGES[a.type] || '';
  const entity =
    a.url && isSafeHttpUrl(a.url)
      ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.entity)}</a>`
      : escapeHtml(a.entity);
  const isLong = a.detail.length > ALERT_DETAIL_TRUNCATE_CHARS;
  const detail = isLong
    ? `<span class="econsec-alert-detail-text" data-detail-view="short">${escapeHtml(
        `${a.detail.slice(0, ALERT_DETAIL_TRUNCATE_CHARS).replace(/\n/g, ' ')}…`,
      )}</span><span class="econsec-alert-detail-text" data-detail-view="full" hidden>${renderMultilineText(
        a.detail,
      )}</span><button type="button" class="econsec-alert-detail-toggle" data-detail-toggle="${key}" aria-expanded="false">詳細</button>`
    : renderMultilineText(a.detail);
  return `
      <div class="econsec-alert-row">
        <span class="econsec-alert-source">${escapeHtml(label)}</span>
        ${badge}
        <span class="econsec-alert-entity">${entity}</span>
        <span class="econsec-alert-detail">${detail}</span>
        <span class="econsec-alert-date">${escapeHtml(formatJst(a.date))}</span>
      </div>`;
}

// Aggregate summary row for a 4+ run: source label (linked to the group's
// representative page, the first member that has one - same source+type
// alerts resolve to the same source-level url in practice) + type badge +
// count. Clicking it expands/collapses the member rows underneath, each
// rendered by the same renderAlertRow used for non-grouped alerts.
function renderAlertGroupRow(group: EconsecAlertGroup, keyPrefix: string): string {
  const label = ALERT_SOURCE_LABELS[group.source] || group.source;
  const badge = ALERT_TYPE_BADGES[group.type] || '';
  const representativeUrl = group.alerts.find((a) => a.url && isSafeHttpUrl(a.url))?.url;
  const sourceLabel = representativeUrl
    ? `<a href="${escapeHtml(representativeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  const members = group.alerts.map((a, i) => renderAlertRow(a, `${keyPrefix}-${i}`)).join('');

  return `
      <div class="econsec-alert-group">
        <div class="econsec-alert-row econsec-alert-group-summary" role="button" tabindex="0" aria-expanded="false">
          <span class="econsec-alert-source">${sourceLabel}</span>
          ${badge}
          <span class="econsec-alert-group-count">${group.alerts.length}件</span>
        </div>
        <div class="econsec-alert-group-members" hidden>${members}</div>
      </div>`;
}

// Counts alerts from the last ALERT_WEEK_DAYS days by type, for the alert
// panel's header summary badge. Independent of the 30-day display window
// used by renderAlertsPanel below (7 days is always a subset of it, but this
// stays correct even if that window changes).
export function countRecentAlertsByType(
  alerts: EconsecAlert[],
  now: number = Date.now(),
): Record<EconsecAlertType, number> {
  const cutoff = now - ALERT_WEEK_DAYS * 24 * 60 * 60 * 1000;
  const counts: Record<EconsecAlertType, number> = { add: 0, remove: 0, 'page-change': 0, 'fr-new': 0 };
  for (const a of alerts) {
    if (new Date(a.date).getTime() >= cutoff) counts[a.type] += 1;
  }
  return counts;
}

// "追加n・削除n・変更n・官報n" - zero-count types are omitted entirely (a
// quiet week for one list type shouldn't show a "0" badge next to the ones
// that did move).
function renderWeeklyBadges(counts: Record<EconsecAlertType, number>): string {
  const parts = ALERT_TYPE_ORDER.filter((t) => counts[t] > 0).map(
    (t) => `<span class="econsec-weekly-badge econsec-weekly-badge-${t}">${WEEKLY_BADGE_LABELS[t]}${counts[t]}</span>`,
  );
  if (parts.length === 0) return '';
  return `<span class="econsec-weekly-badges">${parts.join('<span class="econsec-weekly-sep">・</span>')}</span>`;
}

// Legend content behind the header's "?" toggle: the monitored-list names
// (Japanese, same labels the alert rows themselves use), what the 4 badge
// types mean, and that a grouped/aggregate row expands on click.
function renderAlertLegend(): string {
  const sourceNames = Object.values(ALERT_SOURCE_LABELS).join('、');
  const badgeMeanings = [
    ['add', '新規指定'],
    ['remove', '指定解除'],
    ['page-change', '規制ページの記載変更'],
    ['fr-new', '官報への新規掲載'],
  ] as const;
  const badgeList = badgeMeanings
    .map(([type, meaning]) => `${ALERT_TYPE_BADGES[type]}${escapeHtml(meaning)}`)
    .join('');

  return `
    <div class="econsec-alert-legend" id="econsec-alert-legend" hidden>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">監視対象リスト</span>
        <span class="econsec-legend-text">${escapeHtml(sourceNames)}</span>
      </div>
      <div class="econsec-legend-row">
        <span class="econsec-legend-label">バッジの意味</span>
        <span class="econsec-legend-badges">${badgeList}</span>
      </div>
      <div class="econsec-legend-row">
        <span class="econsec-legend-text">件数でまとめられた集約行はクリックで個別エントリを展開できます。</span>
      </div>
    </div>`;
}

// Renders the regulatory-list/regulatory-page diff log watched by
// scripts/econsec-watch.mjs: last 30 days, newest first, empty state shows
// the last successful run time so a quiet week reads as "checked", not
// "broken". Any alert carrying a url (fr-new's own document link, or a
// sources.json-resolved link for add/remove/page-change) renders its entity
// text as a link; alerts with no resolvable url stay plain text. Runs of 4+
// same-day/source/type alerts collapse into one expandable group row (see
// groupAlertsForDisplay) so a bulk list refresh doesn't flood the panel.
export function renderAlertsPanel(data: EconsecAlertsResponse): string {
  const cutoff = Date.now() - ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = data.alerts
    .filter((a) => new Date(a.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const weeklyCounts = countRecentAlertsByType(data.alerts);

  const header = `
    <div class="econsec-alerts-header">
      <div class="econsec-alerts-titlebar">
        <h2>規制アラート<span class="econsec-alerts-sublabel">制裁・輸出管理リスト差分検知</span></h2>
        <button type="button" class="econsec-alert-legend-toggle" aria-expanded="false" aria-controls="econsec-alert-legend" title="凡例">?</button>
        <span class="econsec-alerts-updated">最終確認: ${escapeHtml(formatJst(data.meta.generated))}</span>
      </div>
      <div class="econsec-alerts-status">
        <span class="econsec-status-dot" aria-hidden="true"></span>
        <span class="econsec-status-text">${escapeHtml(ENTITY_TOTAL_LABEL)}・日次照合</span>
        ${renderWeeklyBadges(weeklyCounts)}
      </div>
      ${renderAlertLegend()}
    </div>`;

  if (recent.length === 0) {
    return `${header}<div class="econsec-alerts-empty">差分なし</div>`;
  }

  const rows = groupAlertsForDisplay(recent)
    .map((item, i) =>
      item.kind === 'group' ? renderAlertGroupRow(item.group, `g${i}`) : renderAlertRow(item.alert, `s${i}`),
    )
    .join('');

  return `${header}<div class="econsec-alerts-list">${rows}</div>`;
}
