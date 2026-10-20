import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkSiteGate, createGateCookie, GATE_COOKIE_TTL } from './site-gate';

const USER = 'jason';
const PASS = 'p@ss:word';
const TOKEN = 'a'.repeat(64);
const NOW = 1_800_000_000_000;
const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

async function gate(
  method: string,
  pathname: string,
  extra: { authorization?: string; gateCookie?: string } = {},
  basePath = '',
) {
  return checkSiteGate({ method, pathname, ...extra }, basePath, NOW);
}

async function result(...args: Parameters<typeof gate>) {
  return (await gate(...args)).result;
}

describe('site gate', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env.BASIC_AUTH_USER = USER;
    process.env.BASIC_AUTH_PASS = PASS;
    process.env.APP_SECRET = 'test-secret';
    delete process.env.TRACKER_SCRIPT_NAME;
    delete process.env.COLLECT_API_ENDPOINT;
    delete process.env.GATE_ALLOW_API_BEARER;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  test.each([
    ['GET', '/script.js'],
    ['HEAD', '/script.js'],
    ['GET', '/recorder.js'],
    ['POST', '/api/send'],
    ['OPTIONS', '/api/send'],
    ['POST', '/api/batch'],
    ['OPTIONS', '/api/batch'],
    ['POST', '/api/record'],
    ['GET', '/api/websites/ef168f4e-d18f-41fb-b7ba-89be5bf49455/recorder'],
  ])('%s %s is public', async (method, pathname) => {
    expect(await result(method, pathname)).toBe('allow');
  });

  test.each([
    ['GET', '/'],
    ['GET', '/login'],
    ['GET', '/websites'],
    ['GET', '/api/websites'],
    ['GET', '/api/send'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/auth/login'],
    ['DELETE', '/api/send'],
    ['POST', '/api/websites'],
    ['GET', '/share/abc'],
    ['GET', '/p/abc'],
    ['GET', '/script.js/../api/users'],
    ['GET', '/api/websites/abc/recorder/extra'],
  ])('%s %s requires auth', async (method, pathname) => {
    expect(await result(method, pathname)).toBe('challenge');
  });

  test('accepts valid Basic credentials, including a colon in the password', async () => {
    expect(await result('GET', '/', { authorization: basic(USER, PASS) })).toBe('allow');
  });

  test('sets a gate cookie when Basic credentials are accepted', async () => {
    const { cookie } = await gate('GET', '/', { authorization: basic(USER, PASS) });

    expect(cookie?.maxAge).toBe(GATE_COOKIE_TTL);
    expect(cookie?.value).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  test.each([
    basic(USER, 'wrong'),
    basic('other', PASS),
    basic(USER, ''),
    basic(USER, `${PASS}-extra`),
    'Basic !!!not-base64!!!',
    `Basic ${btoa('nocolon')}`,
    'Basic',
    'Digest abc',
  ])('rejects bad credentials (%s)', async authorization => {
    expect(await result('GET', '/', { authorization })).toBe('challenge');
  });

  describe('gate cookie', () => {
    test('lets every non-public request through, including login', async () => {
      const gateCookie = await createGateCookie(USER, PASS, NOW);

      expect(await result('GET', '/websites', { gateCookie })).toBe('allow');
      expect(await result('GET', '/api/websites', { gateCookie })).toBe('allow');
      expect(await result('POST', '/api/auth/login', { gateCookie })).toBe('allow');
    });

    test('overrides a stale Bearer header', async () => {
      const gateCookie = await createGateCookie(USER, PASS, NOW);

      expect(
        await result('POST', '/api/auth/login', { gateCookie, authorization: 'Bearer null' }),
      ).toBe('allow');
    });

    test('is not reissued while fresh, and slides once half the lifetime is gone', async () => {
      const fresh = await createGateCookie(USER, PASS, NOW);
      const aged = await createGateCookie(USER, PASS, NOW - GATE_COOKIE_TTL * 0.6 * 1000);

      expect((await gate('GET', '/', { gateCookie: fresh })).cookie).toBeUndefined();
      expect((await gate('GET', '/', { gateCookie: aged })).cookie).toBeDefined();
    });

    test('rejects expired, forged and malformed cookies', async () => {
      const expired = await createGateCookie(USER, PASS, NOW - (GATE_COOKIE_TTL + 1) * 1000);
      const valid = await createGateCookie(USER, PASS, NOW);
      const [expires] = valid.split('.');
      const forged = `${Number(expires) + 99999}.${valid.split('.')[1]}`;

      for (const gateCookie of [expired, forged, 'garbage', `${expires}.${'0'.repeat(64)}`, '']) {
        expect(await result('GET', '/api/websites', { gateCookie })).toBe('challenge');
      }
    });

    test('is invalidated by changing the password or the app secret', async () => {
      const gateCookie = await createGateCookie(USER, PASS, NOW);

      process.env.BASIC_AUTH_PASS = 'new-password';
      expect(await result('GET', '/', { gateCookie })).toBe('challenge');

      process.env.BASIC_AUTH_PASS = PASS;
      process.env.APP_SECRET = 'rotated';
      expect(await result('GET', '/', { gateCookie })).toBe('challenge');
    });
  });

  describe('API Bearer tokens', () => {
    test('are blocked by default', async () => {
      expect(await result('GET', '/api/websites', { authorization: `Bearer ${TOKEN}` })).toBe(
        'challenge',
      );
    });

    test('pass on /api/* only when GATE_ALLOW_API_BEARER=1 and the token looks real', async () => {
      process.env.GATE_ALLOW_API_BEARER = '1';

      expect(await result('GET', '/api/websites', { authorization: `Bearer ${TOKEN}` })).toBe(
        'allow',
      );
      expect(await result('GET', '/api/websites', { authorization: 'Bearer null' })).toBe(
        'challenge',
      );
      expect(await result('GET', '/websites', { authorization: `Bearer ${TOKEN}` })).toBe(
        'challenge',
      );
    });
  });

  test('fails closed when credentials are not configured', async () => {
    delete process.env.BASIC_AUTH_PASS;
    expect(await result('GET', '/')).toBe('misconfigured');

    process.env.BASIC_AUTH_PASS = 'x';
    delete process.env.BASIC_AUTH_USER;
    expect(await result('GET', '/', { authorization: basic('', 'x') })).toBe('misconfigured');
  });

  test('public routes stay open even when credentials are not configured', async () => {
    delete process.env.BASIC_AUTH_USER;
    delete process.env.BASIC_AUTH_PASS;

    expect(await result('POST', '/api/send')).toBe('allow');
    expect(await result('GET', '/script.js')).toBe('allow');
  });

  test('honours TRACKER_SCRIPT_NAME and COLLECT_API_ENDPOINT', async () => {
    process.env.TRACKER_SCRIPT_NAME = 'a.js, /stats.js';
    process.env.COLLECT_API_ENDPOINT = '/x/collect';

    expect(await result('GET', '/a.js')).toBe('allow');
    expect(await result('GET', '/stats.js')).toBe('allow');
    expect(await result('POST', '/x/collect')).toBe('allow');
    expect(await result('GET', '/x/collect')).toBe('challenge');
    expect(await result('GET', '/other.js')).toBe('challenge');
  });

  test('works under a BASE_PATH', async () => {
    const base = '/analytics';

    expect(await result('GET', '/analytics/script.js', {}, base)).toBe('allow');
    expect(await result('POST', '/analytics/api/send', {}, base)).toBe('allow');
    expect(await result('POST', '/analytics/api/auth/login', {}, base)).toBe('challenge');
    expect(await result('GET', '/analytics/websites', {}, base)).toBe('challenge');

    process.env.GATE_ALLOW_API_BEARER = '1';
    expect(
      await result('GET', '/analytics/api/websites', { authorization: `Bearer ${TOKEN}` }, base),
    ).toBe('allow');
  });
});
