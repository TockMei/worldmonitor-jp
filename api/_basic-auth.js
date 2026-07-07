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

// Returns true only when the request carries valid Basic credentials.
// Fails closed when ECONSEC_BASIC_USER / ECONSEC_BASIC_PASS are not set.
export async function checkBasicAuth(request) {
  const expectedUser = process.env.ECONSEC_BASIC_USER;
  const expectedPass = process.env.ECONSEC_BASIC_PASS;
  if (!expectedUser || !expectedPass) return false;

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  // Evaluate both comparisons unconditionally to avoid a user-enumeration
  // timing shortcut.
  const [userOk, passOk] = await Promise.all([
    timingSafeEqual(user, expectedUser),
    timingSafeEqual(pass, expectedPass),
  ]);
  return userOk && passOk;
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
