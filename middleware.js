// Vercel Edge Middleware: Basic auth gate for internal-only routes.
// Protects both the /internal/* pages and the /api/internal/* handlers that
// back them, so the JSON delivery path cannot be reached by skipping the
// rewrite (see vercel.json).
import { checkBasicAuth, unauthorized } from './api/_basic-auth.js';

export const config = {
  matcher: ['/internal/:path*', '/api/internal/:path*'],
};

export default async function middleware(request) {
  if (!(await checkBasicAuth(request))) {
    return unauthorized();
  }

  // x-middleware-next lets the request continue to the origin; extra headers
  // on this response are merged into the final response.
  return new Response(null, {
    headers: {
      'x-middleware-next': '1',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
