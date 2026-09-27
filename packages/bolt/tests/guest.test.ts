/// <reference types="node" />
import { createHash } from 'node:crypto';
import ivm from 'isolated-vm';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { type Bridge, type CrossAnswer, type CrossCall, type GuestOutcome, type Invocation, type InvocationKind, LIMITS } from '../src/engine/contracts.ts';
import type { IsolateGlobals } from '../src/engine/guest/globals.ts';
import { PRELUDE } from '../src/engine/guest/prelude.ts';
import { bodyPath, type GuestOptions, type GuestProgram, guestRunner } from '../src/engine/guest/runner.ts';
import { buildSnapshot } from '../src/compiler/artifact/snapshot.ts';
import { EventLog } from '../src/engine/guest/telemetry.ts';
import { transient } from '../src/engine/runs/index.ts';

// A guest program: one automation `a` whose body is `body`.
const automation = (body: string, prefix = '') => `${prefix}\nexport default { automation: { a: { body: ${body} } } };\n`;
const invocation = (input: Json = null, budget: Partial<Invocation['budget']> = {}, kind: InvocationKind = 'automation', target = 'a'): Invocation => ({
	id: 'inv-1', kind, target, input,
	ctx: { actor: { kind: 'system', run: 'r1', by: { platform: 'test' } }, now: '2026-01-01T20:00:00.000Z', today: '2026-01-01', tz: 'UTC', seed: 'seed-1' },
	budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes, ...budget },
});
const lowerRead: GuestOptions['lowerRead'] = (member, args) => ({ kind: 'get', collection: String(args[0]), id: String(args[1] ?? member), select: { fields: null, relations: {} } });
/** A bridge answering each call with `answer`, recording every crossing. */
const recorder = (answer: (call: CrossCall) => CrossAnswer | Promise<CrossAnswer> = () => ({ ok: true, value: 1 })) => {
	const crossings: (readonly CrossCall[])[] = [];
	const bridge: Bridge = { cross: async (calls) => { crossings.push(calls); return Promise.all(calls.map(answer)); } };
	return { crossings, bridge };
};
const runIn = (source: string, inv = invocation(), bridge = recorder().bridge, options: Partial<GuestOptions> = {}) =>
	guestRunner({ source }, { lowerRead, console: () => {}, ...options }).invoke(inv, bridge);
const ok = (o: GuestOutcome) => {
	if (o.kind !== 'ok') throw new Error(`expected ok, got ${o.kind}: ${o.kind === 'failed' ? `${o.error.code} ${o.error.message}` : o.message}`);
	return o.output;
};
const failure = (o: GuestOutcome) => (o.kind === 'failed' ? { code: o.error.code, message: o.error.message } : o);

describe('next guest runner', () => {
	it('runs a body and returns its JSON output with its CPU', async () => {
		const o = await runIn(automation('async (input, ctx) => ({ twice: input.n * 2, today: ctx.today, inv: ctx.invocationId, tokyo: ctx.todayIn("Asia/Tokyo") })'), invocation({ n: 21 }));
		expect(ok(o)).toEqual({ twice: 42, today: '2026-01-01', inv: 'inv-1', tokyo: '2026-01-02' });
		expect(o.cpuMs).toBeGreaterThan(0);
	});

	it('finds each kind of body in the default export', () => {
		expect(bodyPath('query', 'orders.open')).toEqual(['collection', 'orders', 'bodies', 'queries', 'open']);
		expect(bodyPath('transform', 'orders')).toEqual(['collection', 'orders', 'bodies', 'transform']);
		expect(bodyPath('validation', 'iban')).toEqual(['custom_field', 'iban', 'check']);
		expect(bodyPath('mapping', 'integration.orders.resolve')).toEqual(['integration', 'orders', 'resolve']);
	});

	it('gives every invocation a fresh heap', async () => {
		const source = automation('async () => ++globalThis.count', 'globalThis.count = 0;');
		expect(ok(await runIn(source))).toBe(1);
		expect(ok(await runIn(source))).toBe(1);
	});

	it('crosses the calls made before the microtask queue drains together (rule 12)', async () => {
		const { crossings, bridge } = recorder((c) => ({ ok: true, value: c.op === 'read' && c.read.kind === 'get' ? c.read.id : null }));
		const o = await runIn(automation(`async (_, ctx) => {
			const [a, b, c] = await Promise.all([ctx.get('t', 'x'), ctx.get('t', 'y'), ctx.read('t', 'z')]);
			const d = await ctx.get('t', 'w');
			return [a, b, c, d];
		}`), invocation(), bridge);
		expect(ok(o)).toEqual(['x', 'y', 'z', 'w']);
		expect(crossings.map((c) => c.length)).toEqual([3, 1]);
	});

	it('lowers writes and facilities to the contract calls', async () => {
		const { crossings, bridge } = recorder((c) => ({ ok: true, value: c.op === 'act' ? { kind: 'committed', output: null, records: [] } : null }));
		ok(await runIn(automation(`async (_, ctx) => {
			await Promise.all([ctx.act('t.create', { a: 1 }, { key: 'k' }), ctx.schedule('b', {}, { key: 'q' }), ctx.notify({ to: { team: 'x' }, title: 'hi' }),
				ctx.send('mail', { to: 'a' }), ctx.http('crm').post('/x', { output: { kind: 'json' } }), ctx.web.read('https://a.test')]);
		}`), invocation(), bridge));
		// each facility call crosses alone (it lands as soon as it answers); the writes cross together, in order
		expect(crossings).toEqual([
			[{ op: 'facility', facility: 'http', method: 'post', args: ['crm', '/x', { output: { kind: 'json' } }] }],
			[{ op: 'facility', facility: 'web', method: 'read', args: ['https://a.test'] }],
			[
				{ op: 'act', callable: 't.create', input: { a: 1 }, options: { key: 'k' } },
				{ op: 'schedule', automation: 'b', input: {}, key: 'q' },
				{ op: 'notify', notices: { to: { team: 'x' }, title: 'hi' } },
				{ op: 'send', channel: 'mail', message: { to: 'a' } },
			],
		]);
	});

	it('moves bytes beside the JSON as $bin, both ways (§5.8.1)', async () => {
		const { crossings, bridge } = recorder((c) => c.op === 'facility' && c.method === 'get'
			? { ok: true, value: { $bin: 0 }, bins: [new Uint8Array([9, 8, 7])] } : { ok: true, value: { id: 'f1' } });
		const o = await runIn(automation(`async (_, ctx) => {
			const bytes = await ctx.files.get({ id: 'f0' });
			await ctx.files.put(new Uint8Array([1, 2]), { name: 'x', mime: 'a/b', for: 'a' });
			return [bytes instanceof Uint8Array, Array.from(bytes)];
		}`), invocation(), bridge);
		expect(ok(o)).toEqual([true, [9, 8, 7]]);
		expect(crossings[1]).toEqual([{ op: 'facility', facility: 'files', method: 'put', args: [{ $bin: 0 }, { name: 'x', mime: 'a/b', for: 'a' }], bins: [new Uint8Array([1, 2])] }]);
	});

	it('turns an answer the host cannot encode into a typed failure, never a hang (memory ivm-bridge-answers-must-be-json)', async () => {
		const { bridge } = recorder(() => ({ ok: true, value: 10n as unknown as Json }));
		const o = await runIn(automation('async (_, ctx) => ctx.get("t", "x").then(() => "resolved", (e) => e.code)'), invocation(), bridge);
		expect(ok(o)).toBe('badAnswer');
	});

	it('throws facility errors, returns them from .try, and returns geo errors as values', async () => {
		const { bridge } = recorder(() => ({ ok: false, error: { kind: 'unavailable', facility: 'x', reason: 'none' } }));
		const lines: string[] = [];
		const events = new EventLog({ invocation: 'inv-1' }, undefined, (l) => lines.push(l));
		const o = await runIn(automation(`async (_, ctx) => {
			const thrown = await ctx.web.read('https://a.test').catch((e) => e.kind);
			return [thrown, (await ctx.web.read.try('https://a.test')).kind, (await ctx.geo.search('x')).kind];
		}`), invocation(), bridge, { events });
		expect(ok(o)).toEqual(['unavailable', 'unavailable', 'unavailable']);
		expect(lines.map((l) => JSON.parse(l) as { event: string; severity: string })).toContainEqual(expect.objectContaining({ event: 'facility.failed', severity: 'warn' }));
	});

	it('act throws a refusal, act.try returns it, ctx.refuse refuses with its field', async () => {
		const refused = { kind: 'refused', code: 'refused', message: 'no' };
		const { bridge } = recorder(() => ({ ok: true, value: refused }));
		expect(ok(await runIn(automation('async (_, ctx) => [await ctx.act("t.create", {}).catch((e) => e.message), (await ctx.act.try("t.create", {})).kind]'), invocation(), bridge)))
			.toEqual(['no', 'refused']);
		const action = 'export default { collection: { t: { bodies: { actions: { go: async (_, ctx) => ctx.refuse("too late", { field: "day" }) } } } } };';
		expect(await runIn(action, invocation(null, {}, 'action', 't.go'))).toMatchObject({ kind: 'refused', message: 'too late', field: 'day' });
	});

	it('keeps a guest throw as the cause, with its stack and line (rule 72a)', async () => {
		const o = await runIn(automation('async () => {\n  throw new TypeError("");\n}'));
		expect(o.kind).toBe('failed');
		if (o.kind !== 'failed') return;
		expect(o.error.code).toBe('guestError');
		expect(o.error.message).toBe('Workspace code failed.');
		expect(o.error.cause).toMatchObject({ name: 'TypeError', at: 'guest.mjs:3' });
	});

	it('fails a body that returns while a ctx call is pending, naming the line', async () => {
		const o = await runIn(automation('async (_, ctx) => {\n  ctx.get("t", "x");\n  return 1;\n}'));
		expect(failure(o)).toEqual({ code: 'internal', message: 'unawaited: the body returned while a ctx call was pending at guest.mjs:3' });
	});

	it('fails a body that awaits nothing a crossing can settle', async () => {
		const o = await runIn(automation('async (_, ctx) => { await ctx.get("t", "x"); await new Promise(() => {}); }'));
		expect(failure(o)).toMatchObject({ code: 'stalled', message: expect.stringMatching(/^stalled/) });
		expect(o.kind === 'failed' && o.error.phase).toBe('guest');
		expect(transient(o)).toBe(false);
	});

	it('counts each call as a crossing, not each batch (rule 12)', async () => {
		const o = await runIn(automation('async (_, ctx) => {\n  await Promise.all([ctx.get("t", "a"), ctx.get("t", "b")]);\n  await Promise.all([ctx.get("t", "c"), ctx.get("t", "d")]);\n}'), invocation(null, { crossings: 3 }));
		expect(failure(o)).toEqual({ code: 'crossingBudget', message: 'the invocation made more than 3 crossings; the next was at guest.mjs:4' });
	});

	it('charges no crossing for a journal hit (rules 12, 55)', async () => {
		const { bridge } = recorder(() => ({ ok: true, value: 1, journal: true }));
		const o = await runIn(automation('async (_, ctx) => {\n  for (let i = 0; i < 50; i++)\n    await ctx.get("t", "x");\n  return 1;\n}'), invocation(null, { crossings: 40 }), bridge);
		expect(ok(o)).toBe(1);
	});

	it('names a missing body', async () => {
		expect(failure(await runIn(automation('1'), invocation(null, {}, 'automation', 'nope')))).toMatchObject({ code: 'missingBody' });
	});

	it('stops the crossing past the budget and names its line (rule 12)', async () => {
		const o = await runIn(automation('async (_, ctx) => {\n  for (let i = 0; i < 50; i++)\n    await ctx.get("t", "x");\n}'), invocation(null, { crossings: 40 }));
		expect(failure(o)).toEqual({ code: 'crossingBudget', message: 'the invocation made more than 40 crossings; the next was at guest.mjs:4' });
	});

	it('refuses read bytes past the invocation budget (rule 72)', async () => {
		const { bridge } = recorder(() => ({ ok: true, value: 'x'.repeat(600) }));
		const o = await runIn(automation('async (_, ctx) => { await ctx.get("t", "a"); await ctx.get("t", "b"); }'), invocation(null, { readBytes: 1_000 }), bridge);
		expect(failure(o)).toMatchObject({ code: 'readBudgetExceeded' });
	});

	it('refuses a crossing answer over 4 MiB (rule 9)', async () => {
		const { bridge } = recorder(() => ({ ok: true, value: 'x'.repeat(LIMITS.crossingBytes) }));
		expect(failure(await runIn(automation('async (_, ctx) => ctx.get("t", "a")'), invocation(), bridge))).toMatchObject({ code: 'tooLarge' });
	});

	it('stops a guest spinning past its CPU budget across awaits (rule 71)', async () => {
		const spin = 'const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };';
		const o = await runIn(automation('async (_, ctx) => { for (let i = 0; i < 3; i++) { spin(150); await ctx.get("t", "x"); } return "done"; }', spin), invocation(null, { cpuMs: 300 }));
		expect(failure(o)).toMatchObject({ code: 'cpuBudget' });
		expect(o.cpuMs).toBeGreaterThanOrEqual(300);
	});

	it('does not count I/O waits, and has no invocation wall clock (rule 71)', async () => {
		const { bridge } = recorder(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, value: 1 }), 400)));
		const o = await runIn(automation('async (_, ctx) => { for (let i = 0; i < 3; i++) await ctx.get("t", "x"); return "done"; }'), invocation(null, { cpuMs: 300 }), bridge);
		expect(ok(o)).toBe('done');
		expect(o.cpuMs).toBeLessThan(300);
	});

	it('reports crossings and statements with the CPU (L-COL-109)', async () => {
		const seen: { crossings: number; statements: number }[] = [];
		const o = await runIn(automation('async (_, ctx) => { await ctx.get("t", "x"); await Promise.all([ctx.get("t", "y"), ctx.web.read.try("https://a.test")]); return "done"; }'),
			invocation(), recorder().bridge, { cpu: (_i, _ms, counts) => { seen.push({ ...counts }); } });
		expect(ok(o)).toBe('done');
		expect(seen).toEqual([{ crossings: 3, statements: 2 }]);
	});

	it('bounds each crossing by the per-call wall, as a typed timeout (X-28)', async () => {
		const { bridge } = recorder(() => new Promise(() => {}));
		const o = await runIn(automation('async (_, ctx) => (await ctx.web.read.try("https://a.test")).kind'), invocation(), bridge, { callWallMs: 50 });
		expect(ok(o)).toBe('timeout');
	});

	it('stops a guest past 256 MiB', async () => {
		const o = await runIn(automation('async () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }'));
		expect(failure(o)).toMatchObject({ code: 'memory' });
	}, 20_000);
});

describe('next guest globals (rule 6)', () => {
	// tsc holds this literal to exactly the keys of IsolateGlobals; the test holds the isolate to exactly this literal.
	const surface = { console: true, URL: true, URLSearchParams: true, TextEncoder: true, TextDecoder: true, crypto: true, structuredClone: true, atob: true, btoa: true,
		queueMicrotask: true, setTimeout: true, clearTimeout: true, AbortController: true, AbortSignal: true } as const satisfies Record<keyof IsolateGlobals, true>;
	const guest = async (body: string) => ok(await runIn(automation(`async () => { ${body} }`)));

	it('installs exactly the IsolateGlobals surface, and nothing of the host', async () => {
		const bare = new ivm.Isolate({ memoryLimit: 32 });
		const names = new Set(await (await bare.createContext()).eval('Object.getOwnPropertyNames(globalThis)', { copy: true }) as string[]);
		bare.dispose();
		const seen = await guest('return Object.getOwnPropertyNames(globalThis);') as string[];
		expect(seen.filter((n) => !names.has(n) || n === 'console').sort()).toEqual(Object.keys(surface).sort());
		expect(await guest('return [Object.keys(crypto).sort(), Object.keys(crypto.subtle), typeof setInterval, typeof fetch, typeof Buffer, typeof process];'))
			.toEqual([['getRandomValues', 'randomUUID', 'subtle'], ['digest'], 'undefined', 'undefined', 'undefined', 'undefined']);
		expect(PRELUDE).not.toContain('`');
	});

	it('keeps a URL query written through searchParams in href (memory guest-url-shim-froze-href)', async () => {
		const host = new URL('/v1/events?a=1', 'https://api.test/base/');
		host.searchParams.set('pageToken', "t 2!'~");
		host.searchParams.append('a', '3');
		expect(await guest(`const u = new URL('/v1/events?a=1', 'https://api.test/base/'); u.searchParams.set('pageToken', "t 2!'~"); u.searchParams.append('a', '3');
			return [u.href, u.search, u.origin, URL.canParse('nope')];`))
			.toEqual([host.href, host.search, host.origin, false]);
	});

	it('encodes and decodes text, base64 and clones as the platform does', async () => {
		const text = 'aé中\u{1F600}';
		expect(await guest(`const t = ${JSON.stringify(text)}; const bytes = new TextEncoder().encode(t);
			return [Array.from(bytes), new TextDecoder().decode(bytes), new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62])),
				(() => { try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])); return 'no'; } catch (e) { return e.name; } })(),
				btoa('hi?'), atob(' aGk/ '), (() => { const a = { d: new Date(5), m: new Map([[1, new Set([2])]]) }; a.self = a;
					const b = structuredClone(a); return [b.self === b, b.d.getTime(), b.m.get(1).has(2), b !== a]; })()];`))
			.toEqual([Array.from(Buffer.from(text)), text, 'a�b', 'TypeError', Buffer.from('hi?').toString('base64'), 'hi?', [true, 5, true, true]]);
	});

	it('digests with the host byte for byte and draws random values from the invocation seed', async () => {
		const out = await guest(`const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
			return [Array.from(new Uint8Array(d)), crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];`) as [number[], string, number[]];
		expect(out[0]).toEqual(Array.from(createHash('sha256').update('abc').digest()));
		expect(out[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(await guest(`await crypto.subtle.digest('SHA-256', new Uint8Array(0));
			return [Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')))), crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];`)).toEqual(out);
	});

	it('runs queueMicrotask and zero-delay timers as tasks within the invocation, refusing any other delay (rule 6)', async () => {
		expect(await guest(`const log = [];
			setTimeout((x) => log.push('t1' + x), 0, '!'); const gone = setTimeout(() => log.push('cleared')); clearTimeout(gone);
			queueMicrotask(() => log.push('m')); Promise.resolve().then(() => setTimeout(() => log.push('t2')));
			await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r));
			const refused = (() => { try { setTimeout(() => {}, 5); return 'no'; } catch (e) { return [e.name, e.code]; } })();
			return [log, refused];`)).toEqual([['m', 't1!', 't2'], ['BoltError', 'timerDelay']]);
		const o = await runIn(automation('async () => { clearTimeout(setTimeout(() => {}, 0)); await new Promise(() => {}); }'));
		expect(failure(o)).toMatchObject({ code: 'stalled' });
	});

	it('decodes windows-1252 under its WHATWG labels, and still refuses other encodings (L-COL-097)', async () => {
		const bytes = [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x20, 0x93, 0x71, 0x94, 0x81];
		expect(await guest(`const b = new Uint8Array(${JSON.stringify(bytes)});
			return [new TextDecoder('latin1').decode(b), new TextDecoder('Windows-1252').encoding, new TextDecoder('ascii').decode(b),
				(() => { try { new TextDecoder('shift_jis'); return 'no'; } catch (e) { return e.name; } })()];`))
			.toEqual([new TextDecoder('latin1').decode(new Uint8Array(bytes)), 'windows-1252', new TextDecoder('latin1').decode(new Uint8Array(bytes)), 'RangeError']);
	});

	it('aborts through AbortController as the platform does (L-COL-097)', async () => {
		expect(await guest(`const c = new AbortController(), log = [];
			c.signal.addEventListener('abort', (e) => log.push(e.type), { once: true });
			c.signal.onabort = () => log.push('on');
			const before = c.signal.aborted;
			c.abort('why'); c.abort('again');
			const any = AbortSignal.any([new AbortController().signal, AbortSignal.abort()]);
			const thrown = (() => { try { c.signal.throwIfAborted(); return 'no'; } catch (e) { return e; } })();
			return [before, c.signal.aborted, c.signal.reason, log, thrown, any.aborted, any.reason.name, typeof AbortSignal.timeout,
				(() => { try { new AbortSignal(); return 'no'; } catch (e) { return e.name; } })()];`))
			.toEqual([false, true, 'why', ['abort', 'on'], 'why', true, 'AbortError', 'undefined', 'TypeError']);
	});

	it('reads a `?bytes` server asset by sha256, and names a missing one (L-COL-099)', async () => {
		const bytes = new Uint8Array([0, 97, 255, 10]), sha = createHash('sha256').update(bytes).digest('hex');
		const source = automation(`async () => Array.from(globalThis[Symbol.for('norbital.bolt.asset')](${JSON.stringify(sha)}))`);
		const run = (assets?: Record<string, Uint8Array>) => guestRunner({ source, ...(assets === undefined ? {} : { assets }) }, { lowerRead, console: () => {} }).invoke(invocation(), recorder().bridge);
		expect(ok(await run({ [sha]: bytes }))).toEqual([0, 97, 255, 10]);
		expect(failure(await run())).toMatchObject({ code: 'guestError', message: `the artifact has no server asset ${sha}` });
	});

	it('restores a program from its guest snapshot and runs it as the evaluated one; evaluation that calls the host gets none', async () => {
		// guest.mjs as vite writes it: the default export on its own line
		const source = `globalThis.count = 0;\nconst d = { automation: { a: { body: async (_, ctx) => [++globalThis.count, crypto.randomUUID(), await ctx.get('t', 'x')] } } };\nexport { d as default };\n`;
		const snap = buildSnapshot({ source });
		if (!('bytes' in snap)) throw new Error(snap.refused);
		const run = (program: GuestProgram) => guestRunner(program, { lowerRead, console: () => {} }).invoke(invocation(), recorder().bridge);
		const evaluated = ok(await run({ source }));
		expect(ok(await run({ source, snapshot: snap.bytes }))).toEqual(evaluated);
		expect(ok(await run({ source, snapshot: snap.bytes }))).toEqual(evaluated); // a fresh heap each time
		expect(buildSnapshot({ source: `console.log('loaded');\nconst d = {};\nexport { d as default };\n` })).toEqual({ refused: 'Error: guest.mjs calls the host while it evaluates' });
		expect(buildSnapshot({ source: `const f = new Intl.DateTimeFormat('en');\nexport { f as default };\n` })).toMatchObject({ refused: expect.stringMatching(/^V8 aborted/) });
	});

	it('labels guest console lines for the host', async () => {
		const lines: string[] = [];
		await runIn(automation('async () => { console.warn("careful", { n: 1 }); }'), invocation(), undefined, { console: (level, line, inv) => lines.push(`${inv.id} ${level} ${line}`) });
		expect(lines).toEqual(['inv-1 warn careful {"n":1}']);
	});
});
