import { type NextRequest, NextResponse } from 'next/server';
import { GATE_COOKIE, checkSiteGate } from '@/lib/site-gate';

export const config = {
  matcher: '/:path*',
};

const BASE_PATH = process.env.BASE_PATH || '';

// Fork-only: HTTP Basic auth in front of the dashboard. See src/lib/site-gate.ts.
export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { result, cookie } = await checkSiteGate(
    {
      method: req.method,
      pathname,
      authorization: req.headers.get('authorization'),
      gateCookie: req.cookies.get(GATE_COOKIE)?.value,
    },
    BASE_PATH,
  );

  if (result === 'allow') {
    const res = NextResponse.next();

    if (cookie) {
      res.cookies.set(GATE_COOKIE, cookie.value, {
        httpOnly: true,
        sameSite: 'lax',
        secure:
          req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https',
        path: BASE_PATH || '/',
        maxAge: cookie.maxAge,
      });
    }

    return res;
  }

  if (result === 'misconfigured') {
    return new NextResponse('Site gate is not configured', { status: 503 });
  }

  // Only pages get a Basic prompt. A 401 challenge on the app's own fetch() calls could
  // pop a credentials dialog mid-session.
  const isApi = pathname.replace(BASE_PATH, '').startsWith('/api/');

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      ...(isApi ? {} : { 'WWW-Authenticate': 'Basic realm="Umami", charset="UTF-8"' }),
      'Cache-Control': 'no-store',
    },
  });
}
