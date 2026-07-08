// Shared Basic auth helpers for /internal/* protection (edge runtime).
// Credentials come from Vercel env vars only - never hardcoded.

const encoder = new TextEncoder();

async function sha256(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return new Uint8Array(hash);
}

// Timing-safe string comparison: compare fixed-length SHA-256 digests so the
// loop runs in constant time regardless of where the inputs differ.
export async function timingSafeEqual(a, b) {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}

// Returns true only when the request carries a valid Basic password.
// The username is intentionally ignored (not compared at all) - this is a
// single-operator internal tool, so a second shared credential adds no real
// access control, only UX friction (a username field to fill in every time).
// Fails closed when ECONSEC_BASIC_PASS is not set.
export async function checkBasicAuth(request) {
  const expectedPass = process.env.ECONSEC_BASIC_PASS;
  if (!expectedPass) return false;

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }

  // RFC 7617 still requires a "user-id:password" shape, so a colon must be
  // present - but the user-id half may be empty ("" is a valid username).
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const pass = decoded.slice(sep + 1);

  return timingSafeEqual(pass, expectedPass);
}

export function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="worldmonitor-internal", charset="UTF-8"',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store',
    },
  });
}
