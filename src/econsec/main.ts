// Entry for the internal econsec source directory page (/internal/econsec).
// Data is fetched from the auth-protected route handler, never bundled into
// public assets.
import './econsec.css';
import type { EconsecData, EconsecFilterState, EconsecTier } from './types';
import {
  TIER_LABELS,
  TIER_ORDER,
  escapeHtml,
  filterSources,
  renderSourceList,
  tierCounts,
  uniqueValues,
} from './render';

const SOURCES_URL = '/internal/econsec/sources.json';

const state: EconsecFilterState = {
  tier: 'all',
  region: 'all',
  category: 'all',
  cost: 'all',
  query: '',
};

let data: EconsecData | null = null;

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
}

function bindEvents(): void {
  $('econsec-tabs').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tier-tab');
    if (!btn?.dataset.tier) return;
    state.tier = btn.dataset.tier as EconsecTier | 'all';
    renderTabs();
    renderList();
  });

  const bindSelect = (id: string, key: 'region' | 'category' | 'cost') => {
    $(id).addEventListener('change', (e) => {
      state[key] = (e.target as HTMLSelectElement).value;
      renderList();
    });
  };
  bindSelect('econsec-filter-region', 'region');
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
}

init();
