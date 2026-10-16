// Tokens must never reach the structured (pino) log, in either form:
//   - as an OBJECT field (authorization header, apiKey, token, ...)
//   - as FREE TEXT (a URL with ?token=, an error message embedding a
//     bearer token, a bare sk-ant-/ghp_ token)
//
// src/ had no redaction on either path; the tool-capture hook only
// masks its own transcript. Every assertion below has a red probe
// behind it (documented in the PR): remove the corresponding branch
// of redactLogMessage or the pino redact option and the matching `it`
// goes red.
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import {
  createLogger,
  maskError,
  redactLogMessage,
  REDACTED,
  REDACT_PATHS,
  SECRET_NAMES,
} from '../logger.js';

// FAKE values only. A real-shaped token here would trip the repo's own
// secret gate (secret-gate.test.ts); this file is not on the allowlist.
const BEARER = 'Bearer sk-ant-' + 'a'.repeat(32);
const BEARER_VALUE = BEARER.replace(/^Bearer\s+/, '');
const QUERY_URL = 'https://example.test/api/v1?key=abc123&token=' + 'g'.repeat(24) + '#/done';
const QUERY_TOKEN_VALUE = 'g'.repeat(24);
const GITHUB = 'ghp_' + 'H'.repeat(36);
const PLAIN_MSG = 'heartbeat tick completed, next in 30s';

describe('redactLogMessage (free-text layer)', () => {
  it('masks a Bearer token in the message', () => {
    const out = redactLogMessage(`auth failed: ${BEARER}`);
    expect(out).toContain('Bearer ');
    expect(out).not.toContain(BEARER_VALUE);
    expect(out).not.toContain(BEARER);
    expect(out).toContain(REDACTED);
  });

  it('masks a Bearer token that has no known token shape (only the Bearer rule can)', () => {
    const value = 'q'.repeat(30);
    const out = redactLogMessage(`Authorization: Bearer ${value} rejected`);
    expect(out).not.toContain(value);
    expect(out).toBe(`Authorization: Bearer ${REDACTED} rejected`);
  });

  it('masks a lowercase or uppercase bearer keyword and keeps it as typed', () => {
    const v = 'e'.repeat(30);
    expect(redactLogMessage(`auth bearer ${v} failed`)).toBe(`auth bearer ${REDACTED} failed`);
    expect(redactLogMessage(`AUTH BEARER ${v}`)).toBe(`AUTH BEARER ${REDACTED}`);
  });

  it('masks every Bearer value on a line, not only the first', () => {
    const a = 'a'.repeat(20), b = 'b'.repeat(20);
    const out = redactLogMessage(`first Bearer ${a}, retry Bearer ${b}`);
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
  });

  it('masks access_token= / refresh_token= / id_token= / api_key= parameters anywhere in the text', () => {
    for (const name of ['access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'token']) {
      const v = 'v'.repeat(24);
      const out = redactLogMessage(`POST /login ${name}=${v}&next=/home`);
      expect(out, name).not.toContain(v);
      expect(out, name).toContain(`${name}=${REDACTED}`);
      expect(out, name).toContain('&next=/home');
    }
  });

  it('does not touch look-alikes: max_tokens=, tokenizer=, token_type=', () => {
    const line = 'max_tokens=100 tokenizer=fast token_type=bearer';
    expect(redactLogMessage(line)).toBe(line);
  });

  it('masks JSON string fields in a stringified payload', () => {
    const v = 'j'.repeat(24);
    const out = redactLogMessage(`body {"user":"u","access_token":"${v}","Authorization": "Bearer ${v}"}`);
    expect(out).not.toContain(v);
    expect(out).toContain('"user":"u"');
  });

  it('an empty token value does not swallow the next parameter', () => {
    expect(redactLogMessage('GET /x?token=&next=1')).toBe('GET /x?token=&next=1');
  });

  it('masks the other GitHub token shapes: ghu_, ghr_, github_pat_', () => {
    const ghu = 'ghu_' + 'U'.repeat(36), ghr = 'ghr_' + 'R'.repeat(36), pat = 'github_pat_' + 'P'.repeat(30);
    for (const t of [ghu, ghr, pat]) expect(redactLogMessage(`x ${t} y`)).toBe(`x ${REDACTED} y`);
    expect(redactLogMessage('gh_' + 'x'.repeat(30))).toBe('gh_' + 'x'.repeat(30));
  });

  it('the Bearer rule needs a token-shaped value: at least 16 token characters, horizontal whitespace only', () => {
    expect(redactLogMessage('Bearer token expired')).toBe('Bearer token expired');
    expect(redactLogMessage('Bearer authentication failed')).toBe('Bearer authentication failed');
    expect(redactLogMessage('Bearer\n' + 'n'.repeat(30))).toBe('Bearer\n' + 'n'.repeat(30));
    expect(redactLogMessage('Bearer\t' + 'n'.repeat(30))).toBe(`Bearer ${REDACTED}`);
    expect(redactLogMessage('Bearer ' + 'n'.repeat(16))).toBe(`Bearer ${REDACTED}`);
    expect(redactLogMessage('Bearer ' + 'n'.repeat(15))).toBe('Bearer ' + 'n'.repeat(15));
  });

  it('Basic is masked only in the Authorization header shape, never the bare word', () => {
    const b64 = 'dXNlcjpwYXNzd29yZA==';
    expect(redactLogMessage(`Authorization: Basic ${b64}`)).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redactLogMessage(`authorization=basic ${b64}`)).toContain(REDACTED);
    expect(redactLogMessage(`authorization=basic ${b64}`)).not.toContain(b64);
    expect(redactLogMessage('Basic usage instructions are in the docs')).toBe('Basic usage instructions are in the docs');
    expect(redactLogMessage('Basic auth failed for user bob')).toBe('Basic auth failed for user bob');
  });

  it('masks password=, secret= and client_secret= and stops the value at a delimiter', () => {
    for (const name of ['password', 'secret', 'client_secret']) {
      expect(redactLogMessage(`login ${name}=hunter2value, retry`), name).toBe(`login ${name}=${REDACTED}, retry`);
    }
    expect(redactLogMessage('url?token=abc123(x)&n=1')).toBe(`url?token=${REDACTED}(x)&n=1`);
  });

  it('leaves next_page_token=, max_tokens= and tokenizer= alone', () => {
    const line = 'next_page_token=CAESABC max_tokens=100 tokenizer=fast my_token_count=3';
    expect(redactLogMessage(line)).toBe(line);
  });

  it('masks a Telegram bot token, also inside a bot API URL, and a JWT', () => {
    const tg = '1234567890' + ':' + 'A'.repeat(35);
    expect(redactLogMessage(`GET https://api.example.test/bot${tg}/sendMessage`)).toBe(`GET https://api.example.test/bot${REDACTED}/sendMessage`);
    expect(redactLogMessage(`token ${tg} rejected`)).toBe(`token ${REDACTED} rejected`);
    const jwt = ['eyJ' + 'h'.repeat(12), 'p'.repeat(12), 's'.repeat(12)].join('.');
    expect(redactLogMessage(`session ${jwt} expired`)).toBe(`session ${REDACTED} expired`);
    // look-alikes stay: a clock time, a short id pair, a dotted version
    expect(redactLogMessage('at 12:30:45 id 123:456 v1.2.3')).toBe('at 12:30:45 id 123:456 v1.2.3');
  });

  it('masks a ?token=/&token=/;token= query value', () => {
    const out = redactLogMessage(QUERY_URL);
    expect(out).not.toContain(QUERY_TOKEN_VALUE);
    expect(out).toContain('token=' + REDACTED);
    expect(out).toContain('key=abc123');
    expect(out).toContain('#/done');
  });

  it('masks a bare sk-ant- token shape', () => {
    const tok = 'sk-ant-' + 'k'.repeat(40);
    const out = redactLogMessage('refused ' + tok);
    expect(out).not.toContain(tok);
    expect(out).toContain(REDACTED);
  });

  it('masks a bare ghp_/gho_ GitHub token shape', () => {
    const gho = 'gho_' + 'J'.repeat(40);
    expect(redactLogMessage('push ok ' + GITHUB)).not.toContain(GITHUB);
    expect(redactLogMessage('token ' + gho)).not.toContain(gho);
  });

  it('leaves a benign line byte-for-byte unchanged', () => {
    expect(redactLogMessage(PLAIN_MSG)).toBe(PLAIN_MSG);
    expect(redactLogMessage(REDACTED)).toBe(REDACTED);
    // "token=" with nothing to strip stays intact
    expect(redactLogMessage('docs say to use ?token= for login'))
      .toBe('docs say to use ?token= for login');
    // empty / non-string input is a pass-through
    expect(redactLogMessage('')).toBe('');
  });
});

describe('pino field-name redaction (redact option)', () => {
  it('masks every REDACT_PATHS entry before serialization', async () => {
    // Drive a fresh pino instance with the SAME config the repo's logger
    // ships, capture its write, and assert every listed path comes out
    // as REDACTED. Using REDACT_PATHS directly means the test follows
    // the shipped config: drop an entry from the array and this goes
    // red on that field.
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no line captured')), 500);
      const stream = pino(
        {
          level: 'info',
          redact: { paths: REDACT_PATHS, censor: REDACTED },
        },
        { write: (l: string) => { clearTimeout(timer); resolve(l); } },
      );
      stream.info(
        {
          req: { headers: { authorization: BEARER } },
          headers: { authorization: BEARER },
          authorization: BEARER,
          token: 't_' + 'z'.repeat(20),
          apiKey: GITHUB,
          api_key: GITHUB,
        },
        'probe',
      );
    });
    const parsed = JSON.parse(line);
    // pino writes a dotted path as a NESTED object, not as a flat dotted key.
    expect(parsed.req.headers.authorization).toBe(REDACTED);
    expect(parsed.headers.authorization).toBe(REDACTED);
    expect(parsed.authorization).toBe(REDACTED);
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.api_key).toBe(REDACTED);
    // A sibling field next to a redacted one survives intact.
    expect(parsed.msg).toBe('probe');
  });
});

// The shipped logger options (redact + hooks) run through createLogger(), the same
// function that builds the exported singleton; a destination only swaps the output.
const capture = () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l: string) => { lines.push(l); } });
  log.level = 'trace';
  return { log, lines, last: () => JSON.parse(lines[lines.length - 1]!) };
};

describe('the shipped logger masks free text in object values, bindings, format arguments and Error fields', () => {
  const V = 'z'.repeat(30);

  it('string values anywhere in the log object, arrays included', () => {
    const c = capture();
    c.log.info({ a: { b: { url: `/x?access_token=${V}&n=1` } }, list: [`Bearer ${V}`, 'ok'], plain: 'fine' }, 'hello');
    const j = c.last();
    expect(JSON.stringify(j)).not.toContain(V);
    expect(j.a.b.url).toBe(`/x?access_token=${REDACTED}&n=1`);
    expect(j.list).toEqual([`Bearer ${REDACTED}`, 'ok']);
    expect(j.plain).toBe('fine');
  });

  it('child logger bindings are masked', () => {
    const c = capture();
    c.log.child({ upstream: `https://h.test/?token=${V}`, tag: 'x' }).info('child line');
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().tag).toBe('x');
    // a grandchild inherits the masking, and its own binding is masked too
    c.log.child({ a: 1 }).child({ auth: `Bearer ${V}` }).info('grandchild line');
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().a).toBe(1);
  });

  it('a %j / %o argument is masked after it is formatted into the message', () => {
    const c = capture();
    c.log.info('payload %j', { auth: `Bearer ${V}` });
    expect(c.last().msg).not.toContain(V);
    c.log.info('payload %o', { u: `/x?token=${V}` });
    expect(c.last().msg).not.toContain(V);
  });

  it('the %s placeholder shift cannot leak: a secret passed as a format argument is masked', () => {
    const c = capture();
    c.log.info('token=%s user=%s', 'secretvalue', 'bob');
    expect(c.last().msg).not.toContain('secretvalue');
    expect(c.last().msg).toContain('bob');
    c.log.info({ a: 1 }, 'user=%s password=%s', 'bob', 'hunter2value');
    expect(c.last().msg).not.toContain('hunter2value');
    expect(c.last().msg).toContain('user=bob');
  });

  it('extra Error fields are masked (code, detail, a nested cause)', () => {
    const c = capture();
    const e = Object.assign(new Error('failed'), { detail: `refresh_token=${V}`, code: 'E_AUTH' });
    c.log.error({ err: e }, 'request failed');
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().err.code).toBe('E_AUTH');
  });
});

describe('{ err } without a message, key-name masking at any depth, and pino message parity', () => {
  const V = 'm'.repeat(30);

  it('log.error({ err }) with no message: err.message, err.stack and the log message are all masked', () => {
    const c = capture();
    c.log.error({ err: new Error(`upstream said Bearer ${V}`) });
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().msg).toBe(`upstream said Bearer ${REDACTED}`);
    expect(c.last().err.message).toBe(`upstream said Bearer ${REDACTED}`);
  });

  it('{ err, msg } keeps the caller\'s msg and does not add err.message as the message (plain pino parity)', () => {
    const c = capture();
    c.log.error({ err: new Error(`upstream said Bearer ${V}`), msg: 'x' });
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().msg).toBe('x');
    expect(c.last().err.message).toBe(`upstream said Bearer ${REDACTED}`);
    // the same call on plain pino gives the same msg
    const plain: string[] = [];
    pino({}, { write: (s: string) => { plain.push(s); } }).error({ err: new Error('boom'), msg: 'x' });
    expect(JSON.parse(plain.join('')).msg).toBe('x');
  });

  it('a %j argument that cannot be stringified (circular, BigInt) logs a marker, does not throw and leaks nothing', () => {
    const c = capture();
    const cyc: Record<string, unknown> = { token: V };
    cyc.self = cyc;
    c.log.info('v=%j', cyc);
    (c.log.info as (...a: unknown[]) => void)('n=%j', 10n);
    expect(c.lines.join('')).not.toContain(V);
    expect(JSON.parse(c.lines[0]).msg).toBe('v="[Circular]"');
    expect(JSON.parse(c.lines[1]).msg).toBe('n="[Circular]"');
  });

  it('SECRET_NAMES: every entry is lowercase [a-z0-9_] (safe in a regex), and the regex and the key set follow the array', () => {
    expect(SECRET_NAMES.length).toBeGreaterThan(0);
    for (const n of SECRET_NAMES) expect(n).toMatch(/^[a-z0-9_]+$/);
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
    const v = 'z'.repeat(12);
    for (const n of SECRET_NAMES) {
      // free text: name=value
      expect(redactLogMessage(`x ${n}=${v}`)).toBe(`x ${n}=${REDACTED}`);
      // JSON string field
      expect(redactLogMessage(`{"${n}":"${v}"}`)).toBe(`{"${n}":"${REDACTED}"}`);
      // object key (any depth)
      const c = capture();
      c.log.info({ a: { b: { [n]: v } } }, 'k'); // two levels down: beyond pino's own one-level redact paths
      expect(c.last().a.b[n]).toBe(REDACTED);
    }
  });

  it('a field whose NAME is a secret name is masked at any depth, whatever the value', () => {
    const c = capture();
    c.log.info({
      a: { b: { password: 'hunter2value', note: 'ok', c: [{ client_secret: 'x1', keep: 1 }] } },
      cfg: { 'api-key': { nested: 'object-value' }, AccessToken: 12345, secret: true },
    }, 'deep');
    const j = c.last();
    expect(j.a.b.password).toBe(REDACTED);
    expect(j.a.b.note).toBe('ok');
    expect(j.a.b.c[0].client_secret).toBe(REDACTED);
    expect(j.a.b.c[0].keep).toBe(1);
    expect(j.cfg['api-key']).toBe(REDACTED);
    expect(j.cfg.AccessToken).toBe(REDACTED);
    expect(j.cfg.secret).toBe(REDACTED);
    expect(JSON.stringify(j)).not.toContain('hunter2value');
  });

  it('look-alike field names stay: tokenizer, max_tokens, next_page_token, tokens', () => {
    const c = capture();
    c.log.info({ x: { tokenizer: 'fast', max_tokens: 100, next_page_token: 'abc', tokens: 3 } }, 'names');
    expect(c.last().x).toEqual({ tokenizer: 'fast', max_tokens: 100, next_page_token: 'abc', tokens: 3 });
  });

  it('child bindings are masked by key name at any depth', () => {
    const c = capture();
    c.log.child({ db: { password: 'hunter2value', host: 'h' } }).info('child');
    expect(c.lines.join('')).not.toContain('hunter2value');
    expect(c.last().db.host).toBe('h');
  });

  it('an Error own field named like a secret is masked', () => {
    const c = capture();
    const e = Object.assign(new Error('failed'), { password: 'raw-password-value', clientSecret: 'raw-secret-value', code: 'E_X' });
    c.log.error({ err: e }, 'req');
    expect(c.lines.join('')).not.toContain('raw-password-value');
    expect(c.lines.join('')).not.toContain('raw-secret-value');
    expect(c.last().err.code).toBe('E_X');
  });

  // The message pino itself would log (no redaction needed in these cases) must not change: extra arguments beyond the
  // placeholders are dropped, a placeholder with no usable argument stays, %% collapses, %j/%o stringify.
  it('the message is exactly what plain pino logs, for the call shapes that carry no secret', () => {
    const native: string[] = [];
    const plain = pino({ level: 'trace' }, { write: (l: string) => { native.push(l); } });
    const cases: unknown[][] = [
      ['hello', 'world', 3],
      ['x %s y', 'A', 'B'],
      ['100%', 'sure'],
      ['no placeholder %', 'arg'],
      ['%d items', '5'],
      ['%d items', null],
      ['%i', '7.9'],
      ['%f', '1.50'],
      ['%j', { a: 1 }],
      ['%o', 'str'],
      ['%O', { z: [1, 2] }],
      ['%%', 'x'],
      ['%s'],
      ['a %s b %s', 'only one'],
      ['%s and %d', 'one'],
      [{ k: 1 }, 'with obj %s', 'v', 'extra'],
    ];
    for (const args of cases) (plain.info as (...a: unknown[]) => void)(...args);
    const c = capture();
    for (const args of cases) (c.log.info as (...a: unknown[]) => void)(...args);
    const msgs = (lines: string[]) => lines.map((l) => (JSON.parse(l) as { msg?: string }).msg);
    expect(msgs(c.lines)).toEqual(msgs(native));
  });

  it('extra arguments with no placeholder in the template are dropped exactly as pino drops them, secret or not', () => {
    const c = capture();
    (c.log.info as (...a: unknown[]) => void)('plain message', `Bearer ${V}`, { token: V });
    expect(c.last().msg).toBe('plain message');
    expect(c.lines.join('')).not.toContain(V);
  });
});

describe('maskError keeps the Error shape', () => {
  const V = 'k'.repeat(30);

  it('keeps the prototype, name and extra fields; masks message, stack and cause; the original is untouched', () => {
    const inner = new RangeError(`inner Bearer ${V}`);
    const e = Object.assign(new TypeError(`outer Bearer ${V}`, { cause: inner }), { code: 'E_X' });
    const m = maskError(e);
    expect(m).toBeInstanceOf(TypeError);
    expect(m.name).toBe('TypeError');
    expect((m as unknown as { code: string }).code).toBe('E_X');
    expect(m.message).toBe(`outer Bearer ${REDACTED}`);
    expect(m.stack).not.toContain(V);
    const cause = (m as Error & { cause?: Error }).cause!;
    expect(cause).toBeInstanceOf(RangeError);
    expect(cause.message).toBe(`inner Bearer ${REDACTED}`);
    expect(e.message).toContain(V);
    expect(inner.message).toContain(V);
  });

  it('masks the errors of an AggregateError and survives a cyclic cause', () => {
    const a = new AggregateError([new Error(`one Bearer ${V}`), new Error('two')], `agg Bearer ${V}`);
    const m = maskError(a) as AggregateError;
    expect(m).toBeInstanceOf(AggregateError);
    expect(m.message).not.toContain(V);
    expect(m.errors[0]!.message).toBe(`one Bearer ${REDACTED}`);
    expect(m.errors[1]!.message).toBe('two');
    const loop = new Error('loop');
    (loop as Error & { cause?: unknown }).cause = loop;
    expect(() => maskError(loop)).not.toThrow();
    // a true cycle is named, not followed until the depth cap
    expect(((maskError(loop) as Error & { cause?: Error }).cause as Error & { cause?: unknown }).cause).toBe('[Circular]');
  });

  it('the shipped logger logs a TypeError with a cause masked and typed', () => {
    const c = capture();
    c.log.error(new TypeError(`outer Bearer ${V}`, { cause: new Error(`inner Bearer ${V}`) }));
    expect(c.lines.join('')).not.toContain(V);
    expect(c.last().err.type).toBe('TypeError');
  });
});

describe('every REDACT_PATHS entry masks', () => {
  it('each listed path, set to a value, comes out as REDACTED through the shipped logger', () => {
    for (const path of REDACT_PATHS) {
      const keys = path.split('.').map((k) => (k === '*' ? 'any' : k));
      const obj: Record<string, unknown> = {};
      let cur: Record<string, unknown> = obj;
      keys.forEach((k, i) => {
        if (i === keys.length - 1) cur[k] = 'v'.repeat(24);
        else { const next: Record<string, unknown> = {}; cur[k] = next; cur = next; }
      });
      const c = capture();
      c.log.info(obj, 'path probe');
      let got: unknown = c.last();
      for (const k of keys) got = (got as Record<string, unknown>)?.[k];
      expect(got, path).toBe(REDACTED);
    }
  });
});

describe('the shipped logger masks Error objects and nested fields', () => {
  it('an Error as the first argument: its message and stack are masked, the original is untouched', () => {
    const c = capture();
    const e = new Error(`upstream refused ${BEARER}`);
    c.log.error(e);
    expect(c.last().msg).not.toContain(BEARER_VALUE);
    expect(JSON.stringify(c.last())).not.toContain(BEARER_VALUE);
    expect(e.message).toContain(BEARER_VALUE);
  });

  it('{ err } in the object: err.message and err.stack are masked', () => {
    const c = capture();
    c.log.warn({ err: new Error(`failed ${BEARER}`) }, 'request failed');
    expect(c.last().msg).toBe('request failed');
    expect(JSON.stringify(c.last().err)).not.toContain(BEARER_VALUE);
  });

  it('one level down: { cfg: { token, apiKey, accessToken } } and capitalised headers are masked', () => {
    const c = capture();
    c.log.info({ cfg: { token: 'a'.repeat(20), apiKey: 'b'.repeat(20), accessToken: 'c'.repeat(20), keep: 'ok' },
      headers: { Authorization: BEARER } }, 'cfg');
    const j = c.last();
    expect(j.cfg.token).toBe(REDACTED);
    expect(j.cfg.apiKey).toBe(REDACTED);
    expect(j.cfg.accessToken).toBe(REDACTED);
    expect(j.cfg.keep).toBe('ok');
    expect(j.headers.Authorization).toBe(REDACTED);
  });
});

describe('the shipped logger masks free text on every call shape and on child loggers', () => {
  it('(msg): the message is masked', () => {
    const c = capture();
    c.log.info(`rejected ${BEARER}`);
    expect(c.last().msg).not.toContain(BEARER_VALUE);
    expect(c.last().msg).toContain('Bearer ' + REDACTED);
  });

  it('(obj, msg) with a Bearer value of no known shape: masked by the Bearer rule', () => {
    const c = capture();
    const value = 'w'.repeat(30);
    c.log.info({ a: 1 }, `header Bearer ${value}`);
    expect(c.last().msg).toBe(`header Bearer ${REDACTED}`);
  });

  it('(obj, msg): the message is masked, the object is logged', () => {
    const c = capture();
    c.log.info({ a: 1 }, `rejected ${BEARER}`);
    expect(c.last().a).toBe(1);
    expect(c.last().msg).not.toContain(BEARER_VALUE);
    expect(c.last().msg).toContain('Bearer ' + REDACTED);
  });

  it('(obj, msg, ...format args): a string format argument is masked too', () => {
    const c = capture();
    c.log.warn({ a: 1 }, 'upstream said %s', BEARER);
    expect(c.last().msg).not.toContain(BEARER_VALUE);
  });

  it('a child logger masks the message', () => {
    const c = capture();
    c.log.child({ x: 1 }).info(`request ${QUERY_URL}`);
    expect(c.last().x).toBe(1);
    expect(c.last().msg).not.toContain(QUERY_TOKEN_VALUE);
    expect(c.last().msg).toContain('token=' + REDACTED);
  });

  it('every level masks', () => {
    for (const lvl of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const c = capture();
      c.log.level = 'trace';
      c.log[lvl](`x ${BEARER}`);
      expect(c.last().msg, lvl).not.toContain(BEARER_VALUE);
    }
  });

  it('a benign message and the object field layer are unchanged', () => {
    const c = capture();
    c.log.info({ token: 'z'.repeat(20), keep: 'ok' }, PLAIN_MSG);
    expect(c.last().msg).toBe(PLAIN_MSG);
    expect(c.last().token).toBe(REDACTED);
    expect(c.last().keep).toBe('ok');
  });

  it('a non-string first argument (an error object) still logs', () => {
    const c = capture();
    c.log.error(new Error('boom'), `rejected ${BEARER}`);
    expect(c.last().err.message).toBe('boom');
    expect(c.last().msg).not.toContain(BEARER_VALUE);
  });
});
