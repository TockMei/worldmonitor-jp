// Entry for the internal econsec source directory page (/internal/econsec).
// Data is fetched from the auth-protected route handler, never bundled into
// public assets.
import './econsec.css';
import './panel-live.css';
import { EconsecMap } from './map';
import { EconsecLivePanel } from './live';
import type {
  EconsecAlertsResponse,
  EconsecData,
  EconsecFeedHistoryItem,
  EconsecFeedHistoryResponse,
  EconsecFeedItem,
  EconsecFeedsResponse,
  EconsecFilterState,
  EconsecTier,
} from './types';
import {
  TIER_LABELS,
  TIER_ORDER,
  escapeHtml,
  filterSources,
  populateFeedContainers,
  renderAlertsPanel,
  renderFeedHistoryList,
  renderSourceList,
  tierCounts,
  uniqueValues,
} from './render';

const SOURCES_URL = '/internal/econsec/sources.json';
const FEEDS_URL = '/internal/econsec/feeds.json';
const ALERTS_URL = '/internal/econsec/alerts.json';
const FEED_HISTORY_URL = '/internal/econsec/feed-history.json';

const state: EconsecFilterState = {
  tier: 'all',
  region: 'all',
  category: 'all',
  cost: 'all',
  query: '',
};

let data: EconsecData | null = null;
let map: EconsecMap | null = null;
let feeds: Record<string, EconsecFeedItem[]> | null = null;
let feedHistory: Record<string, EconsecFeedHistoryItem[]> | null = null;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element: ${id}`);
  return el;
}

function renderTabs(): void {
  if (!data) return;
  const counts = tierCounts(data.sources);
  $('econsec-tabs').innerHTML = TIER_ORDER.map((tier) => {
    const active = state.tier === tier ? ' active' : '';
    return `<button class="tier-tab${active}" data-tier="${tier}">${TIER_LABELS[tier]}<span class="tier-count">${counts[tier]}</span></button>`;
  }).join('');
}

function populateSelect(id: string, values: string[]): void {
  const select = $(id) as HTMLSelectElement;
  select.innerHTML =
    '<option value="all">すべて</option>' +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function renderList(): void {
  if (!data) return;
  const filtered = filterSources(data.sources, state);
  $('econsec-list').innerHTML = renderSourceList(filtered);
  $('econsec-count').textContent = `${filtered.length} / ${data.sources.length} 件`;
  if (feeds) populateFeedContainers(feeds);
}

// Best-effort: a feed-fetch failure must not affect the source directory
// itself, so errors here are swallowed and cards simply stay link-only.
async function loadFeeds(): Promise<void> {
  try {
    const res = await fetch(FEEDS_URL, { credentials: 'same-origin' });
    if (!res.ok) return;
    const payload = (await res.json()) as EconsecFeedsResponse;
    feeds = payload.feeds;
    populateFeedContainers(feeds);
  } catch {
    // no feeds this session - cards already render link-only
  }
}

// Best-effort: an alerts-fetch failure must not affect the source directory
// itself, so errors here are swallowed and the panel is simply left empty.
async function loadAlerts(): Promise<void> {
  try {
    const res = await fetch(ALERTS_URL, { credentials: 'same-origin' });
    if (!res.ok) return;
    const payload = (await res.json()) as EconsecAlertsResponse;
    $('econsec-alerts-panel').innerHTML = renderAlertsPanel(payload);
  } catch {
    // no alerts panel this session - rest of the page already rendered
  }
}

// Best-effort, same as loadFeeds/loadAlerts: fetched once up front, then
// each card's history toggle renders from this cached object on demand
// (populateHistoryToggle) rather than issuing a request per click.
async function loadFeedHistory(): Promise<void> {
  try {
    const res = await fetch(FEED_HISTORY_URL, { credentials: 'same-origin' });
    if (!res.ok) return;
    const payload = (await res.json()) as EconsecFeedHistoryResponse;
    feedHistory = payload.history;
  } catch {
    // no history toggles populate this session - cards already render
    // link-only/latest-3, same degradation as a feeds.json failure
  }
}

// Region filter shared by the select box and the map markers.
function setRegion(region: string): void {
  state.region = region;
  ($('econsec-filter-region') as HTMLSelectElement).value = region;
  map?.setActiveRegion(region === 'all' ? null : region);
  renderList();
}

// Toggles a card's full history open/closed; content is rendered from the
// already-fetched `feedHistory` cache on first expand only (dataset.populated
// guards against re-rendering on every click). Delegated on the list
// container since renderList() replaces all source-row elements on every
// filter change, which would otherwise orphan a per-row listener.
function bindHistoryToggle(list: HTMLElement): void {
  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.source-history-toggle');
    if (!btn?.dataset.historyToggle) return;
    const id = btn.dataset.historyToggle;
    const container = list.querySelector<HTMLElement>(`[data-history-for="${CSS.escape(id)}"]`);
    if (!container) return;

    const expanded = !container.hidden;
    if (expanded) {
      container.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!container.dataset.populated) {
      container.innerHTML = renderFeedHistoryList(feedHistory?.[id] || []);
      container.dataset.populated = '1';
    }
    container.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });
}

// Toggles an alert row's detail text between its 80-char preview and the
// full text. Delegated on the panel container (not the individual rows)
// since loadAlerts() replaces the panel's innerHTML wholesale on every
// fetch, which would otherwise orphan a per-row listener - same reasoning
// as bindHistoryToggle above.
function bindAlertDetailToggle(panel: HTMLElement): void {
  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.econsec-alert-detail-toggle');
    if (!btn?.dataset.detailToggle) return;
    const row = btn.closest<HTMLElement>('.econsec-alert-detail');
    const shortEl = row?.querySelector<HTMLElement>('[data-detail-view="short"]');
    const fullEl = row?.querySelector<HTMLElement>('[data-detail-view="full"]');
    if (!shortEl || !fullEl) return;

    const expanded = !fullEl.hidden;
    fullEl.hidden = expanded;
    shortEl.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  });
}

function toggleAlertGroup(summary: HTMLElement): void {
  const group = summary.closest<HTMLElement>('.econsec-alert-group');
  const members = group?.querySelector<HTMLElement>('.econsec-alert-group-members');
  if (!members) return;

  const expanded = !members.hidden;
  members.hidden = expanded;
  summary.setAttribute('aria-expanded', expanded ? 'false' : 'true');
}

// Expands/collapses an aggregated alert group's member rows. Delegated on
// the panel container for the same reason as bindAlertDetailToggle above.
// The whole summary row is the click target (not a dedicated button), per
// spec; a click landing on the source link inside it still toggles the
// group in addition to opening the link in a new tab, which is harmless.
// The summary is a div with role="button"/tabindex="0" (it contains a
// nested <a>, which HTML doesn't allow inside a real <button>), so Enter/
// Space are wired explicitly - a native button gets this for free, a div
// does not.
function bindAlertGroupToggle(panel: HTMLElement): void {
  panel.addEventListener('click', (e) => {
    const summary = (e.target as HTMLElement).closest<HTMLElement>('.econsec-alert-group-summary');
    if (summary) toggleAlertGroup(summary);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const summary = (e.target as HTMLElement).closest<HTMLElement>('.econsec-alert-group-summary');
    if (!summary) return;
    e.preventDefault();
    toggleAlertGroup(summary);
  });
}

function bindEvents(): void {
  $('econsec-tabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tier-tab');
    if (!btn?.dataset.tier) return;
    state.tier = btn.dataset.tier as EconsecTier | 'all';
    renderTabs();
    renderList();
  });

  bindHistoryToggle($('econsec-list'));
  bindAlertDetailToggle($('econsec-alerts-panel'));
  bindAlertGroupToggle($('econsec-alerts-panel'));

  const bindSelect = (id: string, key: 'category' | 'cost') => {
    $(id).addEventListener('change', (e) => {
      state[key] = (e.target as HTMLSelectElement).value;
      renderList();
    });
  };
  $('econsec-filter-region').addEventListener('change', (e) => {
    setRegion((e.target as HTMLSelectElement).value);
  });
  bindSelect('econsec-filter-category', 'category');
  bindSelect('econsec-filter-cost', 'cost');

  $('econsec-search').addEventListener('input', (e) => {
    state.query = (e.target as HTMLInputElement).value;
    renderList();
  });
}

async function init(): Promise<void> {
  const list = $('econsec-list');
  try {
    const res = await fetch(SOURCES_URL, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as EconsecData;
  } catch (err) {
    list.innerHTML = `<div class="source-empty">ソースデータの取得に失敗しました (${
      err instanceof Error ? err.message : 'unknown'
    })</div>`;
    return;
  }

  $('econsec-meta').textContent =
    `${data.meta.name} v${data.meta.version} (generated: ${data.meta.generated})`;
  populateSelect('econsec-filter-region', uniqueValues(data.sources, 'region'));
  populateSelect('econsec-filter-category', uniqueValues(data.sources, 'category'));
  populateSelect('econsec-filter-cost', uniqueValues(data.sources, 'cost'));
  renderTabs();
  renderList();
  bindEvents();

  // World map: chokepoints + region markers. Marker click filters the list
  // below by region (clicking the active region again clears the filter).
  map = new EconsecMap($('econsec-map'), {
    onRegionSelect: (region) => {
      setRegion(state.region === region ? 'all' : region);
    },
    getSourceById: (id) => data?.sources.find((s) => s.id === id),
  });
  void map.init();

  // Live video panel: official YouTube embeds verified at startup, with an
  // automatic link-list fallback when no channel is embeddable.
  const live = new EconsecLivePanel();
  $('live-news').appendChild(live.getElement());
  void live.init();

  // RSS feed digests: fetched separately from the source directory itself so
  // a slow/failing feed aggregation never blocks the initial card render.
  void loadFeeds();

  // Regulatory alert panel: fetched separately so a slow/failing check never
  // blocks the initial card render.
  void loadAlerts();

  // Per-source feed history: fetched separately (and rendered lazily, only
  // when a card's history toggle is expanded) so a slow/failing fetch never
  // blocks the initial card render.
  void loadFeedHistory();
}

init();
