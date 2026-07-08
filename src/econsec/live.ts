// Live video panel for the internal econsec page. Self-contained (no
// dashboard Panel dependency) because the channel lineup and failure
// handling differ from the public dashboard's LiveNewsPanel.
//
// Startup flow: resolve each candidate's current live video id via
// /api/youtube/live, then verify embeddability with a hidden muted player.
// YouTube IFrame API error 101/150 means the owner disabled embedding, so
// only verified channels (max 3) are adopted. When nothing is embeddable
// the panel degrades to a plain list of links to the official live pages.

interface LiveCandidate {
  id: string;
  name: string;
  handle: string; // official YouTube channel handle
  fallbackVideoId?: string; // known 24/7 stream id, used when live detection fails
}

interface AdoptedChannel extends LiveCandidate {
  videoId: string;
}

const CANDIDATES: LiveCandidate[] = [
  { id: 'aljazeera', name: 'Al Jazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24English', fallbackVideoId: 'Ap-UM1O9RBU' },
  { id: 'dw', name: 'DW News', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'abc-au', name: 'ABC News AU', handle: '@abcnewsaustralia' },
  { id: 'ann', name: 'ANN', handle: '@ANNnewsCH' },
  { id: 'tbs', name: 'TBS NEWS DIG', handle: '@tbsnewsdig' },
];

const MAX_ADOPTED = 3;
const VERIFY_TIMEOUT_MS = 8000;
const EMBED_BLOCKED_CODES = [101, 150];
// YT.PlayerState values that prove the embed is allowed to play.
const STATE_PLAYING = 1;
const STATE_BUFFERING = 3;

// Local IFrame API types: the dashboard's LiveNewsPanel declares a narrower
// global Window.YT, so this module keeps its own types and casts instead of
// re-declaring the global (tsc rejects conflicting declarations).
type YtPlayer = {
  mute(): void;
  unMute(): void;
  loadVideoById(videoId: string): void;
  destroy(): void;
};

type YtNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady?: () => void;
        onError?: (event: { data: number }) => void;
        onStateChange?: (event: { data: number }) => void;
      };
    },
  ) => YtPlayer;
};

type YtWindow = {
  YT?: YtNamespace;
  onYouTubeIframeAPIReady?: () => void;
};

function ytWindow(): YtWindow {
  return window as unknown as YtWindow;
}

let apiPromise: Promise<YtNamespace> | null = null;

function loadYouTubeApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const w = ytWindow();
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    const previousReady = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(ytWindow().YT!);
    };
    if (!document.querySelector('script[data-youtube-iframe-api="true"]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = 'true';
      script.onerror = () => reject(new Error('Failed to load YouTube IFrame API'));
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

async function fetchLiveVideoId(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/youtube/live?channel=${encodeURIComponent(handle)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { videoId?: string | null };
    return data.videoId || null;
  } catch {
    return null;
  }
}

// Loads the video in an offscreen muted player and waits for a verdict.
// A timeout without an explicit error counts as playable: adopting a slow
// channel beats dropping everything into the link fallback.
function verifyEmbeddable(yt: YtNamespace, videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px;';
    const target = document.createElement('div');
    host.appendChild(target);
    document.body.appendChild(host);

    let player: YtPlayer | null = null;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        player?.destroy();
      } catch {
        // player already torn down
      }
      host.remove();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(true), VERIFY_TIMEOUT_MS);

    player = new yt.Player(target, {
      videoId,
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, origin: window.location.origin, enablejsapi: 1 },
      events: {
        onError: (e) => {
          if (EMBED_BLOCKED_CODES.includes(e.data)) {
            console.info(`[EconsecLive] ${videoId}: embedding disabled (error ${e.data})`);
          }
          finish(false);
        },
        onStateChange: (e) => {
          if (e.data === STATE_PLAYING || e.data === STATE_BUFFERING) finish(true);
        },
      },
    });
  });
}

export class EconsecLivePanel {
  private readonly element: HTMLElement;
  private readonly content: HTMLElement;
  private readonly switcher: HTMLElement;
  private muteBtn: HTMLButtonElement;
  private adopted: AdoptedChannel[] = [];
  private active: AdoptedChannel | null = null;
  private player: YtPlayer | null = null;
  private isPlayerReady = false;
  private isMuted = true;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'panel panel-wide';

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML =
      '<div class="panel-header-left"><span class="panel-title">Live News</span></div>';
    this.muteBtn = document.createElement('button');
    this.muteBtn.className = 'live-mute-btn';
    this.muteBtn.title = 'Toggle sound';
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    header.appendChild(this.muteBtn);
    this.updateMuteIcon();

    this.switcher = document.createElement('div');
    this.switcher.className = 'live-news-switcher';
    this.switcher.hidden = true;

    this.content = document.createElement('div');
    this.content.className = 'panel-content';

    this.element.append(header, this.switcher, this.content);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public async init(): Promise<void> {
    this.content.innerHTML =
      '<div class="live-offline"><div class="offline-text">配信元を確認中…</div></div>';

    const resolved = await Promise.all(
      CANDIDATES.map(async (candidate) => {
        const liveId = await fetchLiveVideoId(candidate.handle);
        const videoId = liveId || candidate.fallbackVideoId;
        return videoId ? { ...candidate, videoId } : null;
      }),
    );
    const withVideo = resolved.filter((c): c is AdoptedChannel => c !== null);

    let yt: YtNamespace;
    try {
      yt = await loadYouTubeApi();
    } catch {
      this.renderFallback();
      return;
    }

    const verdicts = await Promise.all(withVideo.map((c) => verifyEmbeddable(yt, c.videoId)));
    this.adopted = withVideo.filter((_, i) => verdicts[i]).slice(0, MAX_ADOPTED);

    if (this.adopted.length === 0) {
      this.renderFallback();
      return;
    }
    this.renderSwitcher();
    this.playChannel(this.adopted[0]!);
  }

  // Automatic fallback: plain links to the official live pages instead of
  // an error message.
  private renderFallback(): void {
    this.destroyPlayer();
    this.switcher.hidden = true;
    this.muteBtn.hidden = true;
    const links = CANDIDATES.map(
      (c) =>
        `<li><a href="https://www.youtube.com/${encodeURIComponent(c.handle)}/live" target="_blank" rel="noopener noreferrer">${c.name}</a></li>`,
    ).join('');
    this.content.innerHTML = `
      <div class="live-fallback">
        <div class="live-fallback-note">埋め込み再生できる配信がありません。公式ライブページから直接視聴してください。</div>
        <ul class="live-fallback-links">${links}</ul>
      </div>`;
  }

  private renderSwitcher(): void {
    this.switcher.hidden = this.adopted.length === 0;
    this.switcher.innerHTML = '';
    for (const channel of this.adopted) {
      const btn = document.createElement('button');
      btn.className = `live-channel-btn${channel.id === this.active?.id ? ' active' : ''}`;
      btn.dataset.channelId = channel.id;
      btn.textContent = channel.name;
      btn.addEventListener('click', () => this.playChannel(channel));
      this.switcher.appendChild(btn);
    }
  }

  private playChannel(channel: AdoptedChannel): void {
    this.active = channel;
    this.renderSwitcher();
    if (this.player && this.isPlayerReady) {
      this.player.loadVideoById(channel.videoId);
      this.syncMute();
      return;
    }
    if (!this.player) void this.createPlayer(channel);
  }

  private async createPlayer(channel: AdoptedChannel): Promise<void> {
    const yt = await loadYouTubeApi();
    this.content.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'live-news-player';
    const target = document.createElement('div');
    container.appendChild(target);
    this.content.appendChild(container);

    this.isPlayerReady = false;
    this.player = new yt.Player(target, {
      videoId: channel.videoId,
      playerVars: { autoplay: 1, mute: 1, rel: 0, playsinline: 1, origin: window.location.origin, enablejsapi: 1 },
      events: {
        onReady: () => {
          this.isPlayerReady = true;
          this.syncMute();
        },
        // Streams rotate: a channel verified at startup can still turn
        // embed-blocked or offline later. Drop it and move on.
        onError: (e) => {
          if (this.active) this.dropChannel(this.active, e.data);
        },
      },
    });
  }

  private dropChannel(channel: AdoptedChannel, errorCode: number): void {
    const reason = EMBED_BLOCKED_CODES.includes(errorCode) ? 'embedding disabled' : 'playback error';
    console.warn(`[EconsecLive] ${channel.name}: ${reason} (error ${errorCode})`);
    this.adopted = this.adopted.filter((c) => c.id !== channel.id);
    if (this.adopted.length === 0) {
      this.renderFallback();
      return;
    }
    if (this.active?.id === channel.id) {
      this.playChannel(this.adopted[0]!);
    } else {
      this.renderSwitcher();
    }
  }

  private destroyPlayer(): void {
    try {
      this.player?.destroy();
    } catch {
      // player already torn down
    }
    this.player = null;
    this.isPlayerReady = false;
  }

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    this.updateMuteIcon();
    this.syncMute();
  }

  private syncMute(): void {
    if (!this.player || !this.isPlayerReady) return;
    if (this.isMuted) {
      this.player.mute();
    } else {
      this.player.unMute();
    }
  }

  private updateMuteIcon(): void {
    this.muteBtn.innerHTML = this.isMuted
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    this.muteBtn.classList.toggle('unmuted', !this.isMuted);
  }
}
