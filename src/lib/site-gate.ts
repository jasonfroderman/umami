import { matchesConfiguredPath } from '@/lib/match-configured-path';

// HTTP Basic auth gate for the whole site. Fork-only (not part of upstream Umami).
//
// Public, so tracking keeps working from other sites:
//   - the tracker script (GET /script.js and any TRACKER_SCRIPT_NAME aliases)
//   - collection (POST/OPTIONS /api/send, /api/batch, /api/record, COLLECT_API_ENDPOINT)
//   - the recorder script and its config
//
// Everything else, including /api/auth/login, needs either Basic credentials or the
// signed gate cookie. The browser sends Basic credentials on page loads, and the gate
// answers with the cookie. The cookie matters because the app's own fetch() calls set
// an Authorization header (a Bearer token) that replaces the browser's Basic
// credentials, so Basic alone can't cover them.
//
// Config: BASIC_AUTH_USER / BASIC_AUTH_PASS (required, fails closed if unset) and
// GATE_ALLOW_API_BEARER=1 to also let /api/* through when it carries a Bearer token
// (API keys, MCP). Off by default.

export type SiteGateResult = 'allow' | 'challenge' | 'misconfigured';

export interface SiteGateInput {
  method: string;
  pathname: string;
  authorization?: string | null;
  gateCookie?: string | null;
}

export interface SiteGateDecision {
  result: SiteGateResult;
  // Set when the response should carry a fresh gate cookie.
  cookie?: { value: string; maxAge: number };
}

export const GATE_COOKIE = 'site_gate';
export const GATE_COOKIE_TTL = 12 * 60 * 60; // seconds

const TRACKER_PATH = '/script.js';
const RECORDER_PATH = '/recorder.js';
const COLLECT_PATHS = ['/api/send', '/api/batch', '/api/record'];
const API_PREFIX = '/api/';
const MIN_BEARER_LENGTH = 32;

function matchesAny(pathname: string, paths: string[], basePath: string) {
  return paths.some(path => matchesConfiguredPath(pathname, path, basePath));
}

function splitList(value?: string) {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function stripBasePath(pathname: string, basePath: string) {
  const base = basePath ? `/${basePath.replace(/^\/+|\/+$/g, '')}` : '';

  return base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

// Length-independent comparison so response time doesn't leak a matching prefix.
function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }

  return diff === 0;
}

function parseBasic(authorization?: string | null) {
  const match = /^Basic\s+(\S+)$/i.exec(authorization || '');

  if (!match) {
    return null;
  }

  try {
    const bytes = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const index = decoded.indexOf(':');

    return index < 0 ? null : { user: decoded.slice(0, index), pass: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

// Rejects the empty tokens the app sends while logged out ("Bearer null"). This is a
// sanity filter, not verification: Umami still validates the token on every route.
function hasPlausibleBearer(authorization?: string | null) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization || '');

  return Boolean(match && match[1].length >= MIN_BEARER_LENGTH);
}

// Cookies are signed with the app secret plus the Basic password, so rotating either
// one invalidates every outstanding cookie.
async function sign(payload: string, user: string, pass: string) {
  const material = `${process.env.APP_SECRET || process.env.DATABASE_URL || ''}|${user}|${pass}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));

  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function createGateCookie(user: string, pass: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + GATE_COOKIE_TTL;

  return `${expires}.${await sign(String(expires), user, pass)}`;
}

// Returns the seconds left on a valid cookie, or 0 if it is missing, forged or expired.
async function gateCookieRemaining(
  cookie: string | null | undefined,
  user: string,
  pass: string,
  now: number,
) {
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(cookie || '');

  if (!match) {
    return 0;
  }

  const remaining = Number(match[1]) - Math.floor(now / 1000);

  if (remaining <= 0 || !safeEqual(match[2], await sign(match[1], user, pass))) {
    return 0;
  }

  return remaining;
}

export function isPublicRoute(method: string, pathname: string, basePath = '') {
  const verb = method.toUpperCase();
  const path = stripBasePath(pathname, basePath);

  if (verb === 'GET' || verb === 'HEAD') {
    const scripts = [TRACKER_PATH, RECORDER_PATH, ...splitList(process.env.TRACKER_SCRIPT_NAME)];

    // Recorder config is fetched anonymously by recorder.js from the tracked site.
    return (
      matchesAny(pathname, scripts, basePath) || /^\/api\/websites\/[^/]+\/recorder$/.test(path)
    );
  }

  if (verb === 'POST' || verb === 'OPTIONS') {
    const collect = [...COLLECT_PATHS, ...splitList(process.env.COLLECT_API_ENDPOINT)];

    return matchesAny(pathname, collect, basePath);
  }

  return false;
}

export async function checkSiteGate(
  input: SiteGateInput,
  basePath = '',
  now = Date.now(),
): Promise<SiteGateDecision> {
  const { method, pathname, authorization, gateCookie } = input;

  if (isPublicRoute(method, pathname, basePath)) {
    return { result: 'allow' };
  }

  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  if (!user || !pass) {
    return { result: 'misconfigured' };
  }

  const remaining = await gateCookieRemaining(gateCookie, user, pass, now);

  if (remaining > 0) {
    // Slide the expiry forward once half the lifetime is gone.
    return remaining < GATE_COOKIE_TTL / 2
      ? {
          result: 'allow',
          cookie: { value: await createGateCookie(user, pass, now), maxAge: GATE_COOKIE_TTL },
        }
      : { result: 'allow' };
  }

  const credentials = parseBasic(authorization);

  if (credentials && safeEqual(credentials.user, user) && safeEqual(credentials.pass, pass)) {
    return {
      result: 'allow',
      cookie: { value: await createGateCookie(user, pass, now), maxAge: GATE_COOKIE_TTL },
    };
  }

  const isApi = stripBasePath(pathname, basePath).startsWith(API_PREFIX);

  if (isApi && process.env.GATE_ALLOW_API_BEARER === '1' && hasPlausibleBearer(authorization)) {
    return { result: 'allow' };
  }

  return { result: 'challenge' };
}
