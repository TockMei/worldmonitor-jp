// World map for the econsec page. Reuses the dashboard's d3 + topojson
// rendering approach, world-atlas topology (MAP_URLS) and STRATEGIC_WATERWAYS
// coordinates from the shared geo config, without pulling in dashboard
// services. ISW ArcGIS layers are intentionally NOT embedded (internal rule:
// PDF-internal use only; only a plain link to understandingwar.org is allowed
// elsewhere).
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import { MAP_URLS, STRATEGIC_WATERWAYS } from '@/config/geo';
import { escapeHtml } from './render';
import type { EconsecSource } from './types';

const VIEW_W = 960;
const VIEW_H = 470;

// The 6 chokepoints required on this screen (subset of STRATEGIC_WATERWAYS).
const CHOKEPOINT_IDS = [
  'hormuz_strait',
  'bab_el_mandeb',
  'suez',
  'panama',
  'taiwan_strait',
  'malacca_strait',
] as const;

// Raw-information sources linked from each chokepoint popup (ids in
// sources.json). URLs are resolved from the loaded dataset so checker updates
// (final_url) propagate automatically.
const CHOKEPOINT_SOURCES: Record<string, string[]> = {
  hormuz_strait: ['ukmto', 'portwatch'],
  bab_el_mandeb: ['ukmto', 'portwatch'],
  suez: ['ukmto', 'portwatch'],
  panama: ['portwatch'],
  taiwan_strait: ['msa-cn', 'portwatch'],
  malacca_strait: ['ukmto', 'msa-cn', 'portwatch'],
};

interface RegionMarker {
  region: string;
  label: string;
  lat: number;
  lon: number;
}

// Region markers matching the region filter vocabulary of sources.json.
const REGION_MARKERS: RegionMarker[] = [
  { region: 'JP', label: 'JP', lat: 36.2, lon: 138.3 },
  { region: 'US', label: 'US', lat: 39.8, lon: -98.6 },
  { region: 'EU', label: 'EU', lat: 49.5, lon: 9.0 },
  { region: 'UK', label: 'UK', lat: 54.5, lon: -3.5 },
  { region: 'CN', label: 'CN', lat: 35.0, lon: 103.0 },
  { region: 'TW', label: 'TW', lat: 23.7, lon: 121.0 },
  { region: 'UA-RU', label: 'UA-RU', lat: 49.0, lon: 36.0 },
  { region: 'MIDEAST', label: 'MIDEAST', lat: 29.5, lon: 44.0 },
];

export interface EconsecMapOptions {
  onRegionSelect: (region: string) => void;
  getSourceById: (id: string) => EconsecSource | undefined;
}

export class EconsecMap {
  private container: HTMLElement;
  private options: EconsecMapOptions;
  private projection = d3.geoEquirectangular();
  private popup: HTMLDivElement | null = null;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;

  constructor(container: HTMLElement, options: EconsecMapOptions) {
    this.container = container;
    this.options = options;
    this.container.classList.add('econsec-map-container');
  }

  public async init(): Promise<void> {
    let world: Topology<{ countries: GeometryCollection }>;
    try {
      const res = await fetch(MAP_URLS.world);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      world = await res.json();
    } catch (err) {
      this.container.innerHTML = `<div class="econsec-map-error">地図データの取得に失敗しました (${
        err instanceof Error ? escapeHtml(err.message) : 'unknown'
      })</div>`;
      return;
    }
    this.render(world);
  }

  private render(world: Topology<{ countries: GeometryCollection }>): void {
    this.container.innerHTML = '';

    this.projection.fitExtent(
      [[0, -34], [VIEW_W, VIEW_H + 56]],
      { type: 'Sphere' },
    );
    const path = d3.geoPath().projection(this.projection);

    this.svg = d3
      .select(this.container)
      .append('svg')
      .attr('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('class', 'econsec-map-svg');

    this.svg
      .append('rect')
      .attr('width', VIEW_W)
      .attr('height', VIEW_H)
      .attr('class', 'econsec-map-sea');

    const countries = topojson.feature(world, world.objects.countries);
    const features = 'features' in countries ? countries.features : [countries];

    this.svg
      .append('g')
      .selectAll('path')
      .data(features)
      .join('path')
      .attr('d', path as never)
      .attr('class', 'econsec-map-country');

    this.renderRegionMarkers();
    this.renderChokepoints();

    // Popups close when clicking anywhere else on the map.
    this.svg.on('click', () => this.closePopup());
  }

  private point(lat: number, lon: number): [number, number] {
    return this.projection([lon, lat]) ?? [0, 0];
  }

  private renderRegionMarkers(): void {
    if (!this.svg) return;
    const g = this.svg.append('g');
    for (const marker of REGION_MARKERS) {
      const [x, y] = this.point(marker.lat, marker.lon);
      const node = g
        .append('g')
        .attr('class', 'econsec-region-marker')
        .attr('data-region', marker.region)
        .attr('transform', `translate(${x},${y})`)
        .style('cursor', 'pointer');
      node.append('circle').attr('r', 6);
      node
        .append('text')
        .attr('y', -10)
        .attr('text-anchor', 'middle')
        .text(marker.label);
      node.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.closePopup();
        this.options.onRegionSelect(marker.region);
      });
    }
  }

  private renderChokepoints(): void {
    if (!this.svg) return;
    const chokepoints = STRATEGIC_WATERWAYS.filter((w) =>
      (CHOKEPOINT_IDS as readonly string[]).includes(w.id),
    );
    const g = this.svg.append('g');
    for (const cp of chokepoints) {
      const [x, y] = this.point(cp.lat, cp.lon);
      const node = g
        .append('g')
        .attr('class', 'econsec-chokepoint')
        .attr('transform', `translate(${x},${y})`)
        .style('cursor', 'pointer');
      node
        .append('rect')
        .attr('x', -5)
        .attr('y', -5)
        .attr('width', 10)
        .attr('height', 10)
        .attr('transform', 'rotate(45)');
      node
        .append('text')
        .attr('y', 16)
        .attr('text-anchor', 'middle')
        .text(cp.name);
      node.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        this.showChokepointPopup(cp.id, cp.name, cp.description ?? '', x, y);
      });
    }
  }

  private showChokepointPopup(
    id: string,
    name: string,
    description: string,
    x: number,
    y: number,
  ): void {
    this.closePopup();

    const links = (CHOKEPOINT_SOURCES[id] || [])
      .map((sourceId) => this.options.getSourceById(sourceId))
      .filter((s): s is EconsecSource => Boolean(s && (s.final_url || s.url)))
      .map((s) => {
        const href = s.final_url || s.url!;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.name)}</a>`;
      })
      .join('');

    this.popup = document.createElement('div');
    this.popup.className = 'econsec-map-popup';
    this.popup.innerHTML = `
      <button class="econsec-popup-close" aria-label="close">✕</button>
      <div class="econsec-popup-title">${escapeHtml(name)}</div>
      <div class="econsec-popup-desc">${escapeHtml(description)}</div>
      <div class="econsec-popup-links-label">生情報ソース</div>
      <div class="econsec-popup-links">${links || '<span class="econsec-popup-none">なし</span>'}</div>
    `;

    // viewBox coordinates -> rendered pixel coordinates (uniform scale,
    // container width drives the SVG size)
    const rect = this.container.getBoundingClientRect();
    const scale = rect.width / VIEW_W;
    const px = Math.min(Math.max(x * scale, 90), rect.width - 90);
    const py = Math.max(y * scale, 30);
    this.popup.style.left = `${px}px`;
    this.popup.style.top = `${py}px`;

    this.popup.querySelector('.econsec-popup-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopup();
    });
    this.popup.addEventListener('click', (e) => e.stopPropagation());
    this.container.appendChild(this.popup);
  }

  public closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  public setActiveRegion(region: string | null): void {
    this.container.querySelectorAll('.econsec-region-marker').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-region') === region);
    });
  }
}
