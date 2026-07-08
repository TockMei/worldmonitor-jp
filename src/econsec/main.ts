// Entry for the internal econsec source directory page (/internal/econsec).
// Data is fetched from the auth-protected route handler, never bundled into
// public assets.
import './econsec.css';
import './panel-live.css';
import { EconsecMap } from './map';
import { EconsecLivePanel } from './live';
import type { EconsecData, EconsecFeedItem, EconsecFeedsResponse, EconsecFilterState, EconsecTier } from './types';
import {
  TIER_LABELS,
  TIER_ORDER,
  escapeHtml,
  filterSources,
  populateFeedContainers,
  renderSourceList,
  tierCounts,
  uniqueValues,
} from './render';

const SOURCES_URL = '/internal/econsec/sources.json';
const FEEDS_URL = '/internal/econsec/feeds.json';

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

// Region filter shared by the select box and the map markers.
function setRegion(region: string): void {
  state.region = region;
  ($('econsec-filter-region') as HTMLSelectElement).value = region;
  map?.setActiveRegion(region === 'all' ? null : region);
  renderList();
}

function bindEvents(): void {
  $('econsec-tabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tier-tab');
    if (!btn?.dataset.tier) return;
    state.tier = btn.dataset.tier as EconsecTier | 'all';
    renderTabs();
    renderList();
  });

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
}

init();
