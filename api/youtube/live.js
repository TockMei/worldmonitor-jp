// YouTube Live Stream Detection API
// Uses YouTube's live page (not oEmbed) to check for an active live stream
// and extract its video id.

export const config = {
  runtime: 'edge',
};

// Core lookup, factored out of the HTTP handler so both the edge function
// and the Vite dev server (vite.config.ts) can call it directly without a
// network round-trip - keeping dev/prod behavior identical.
export async function resolveLiveVideoId(channel) {
  const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
  const liveUrl = `https://www.youtube.com/${channelHandle}/live`;

  const response = await fetch(liveUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    return { videoId: null };
  }

  const html = await response.text();
  const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const isLiveMatch = html.match(/"isLive":\s*true/);

  if (videoIdMatch && isLiveMatch) {
    return { videoId: videoIdMatch[1], isLive: true };
  }
  return { videoId: null, isLive: false };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const channel = url.searchParams.get('channel');

  if (!channel) {
    return new Response(JSON.stringify({ error: 'Missing channel parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await resolveLiveVideoId(channel);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=300', // Cache for 5 minutes
      },
    });
  } catch (error) {
    console.error('YouTube live check error:', error);
    return new Response(JSON.stringify({ videoId: null, error: error.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
