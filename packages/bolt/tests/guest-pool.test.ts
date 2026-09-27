/// <reference types="node" />
// Prepared isolates (runner.ts, memory ivm-prepared-context-pipeline): evaluated ahead of time, used by exactly one
// invocation, bounded per program and process-wide, evicted when cold, and killed with their generation (rule 71a).
import { afterEach, describe, expect, it } from 'vitest';
import type { Bridge, GuestOutcome, Invocation } from '../src/engine/contracts.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { guestIsolates, guestRunner, type GuestOptions, warmLimits } from '../src/engine/guest/runner.ts';

const program = (body: string, prefix = '') => ({ source: `${prefix}\nexport default { automation: { a: { body: ${body} } } };\n` });
const invocation = (id = 'inv'): Invocation => ({ id, kind: 'automation', target: 'a', input: null,
	ctx: { actor: { kind: 'system', run: 'r1', by: { platform: 'test' } }, now: '2026-01-01T00:00:00.000Z', today: '2026-01-01', tz: 'UTC', seed: id },
	budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes } });
const bridge: Bridge = { cross: async (calls) => calls.map(() => ({ ok: true, value: null })) };
const lowerRead: GuestOptions['lowerRead'] = () => { throw new Error('no reads'); };
const runner = (source: { source: string }, signal?: AbortSignal) =>
	guestRunner(source, { lowerRead, console: () => {}, ...(signal === undefined ? {} : { signal }) });
const ok = (o: GuestOutcome) => {
	if (o.kind !== 'ok') throw new Error(`expected ok, got ${o.kind}: ${o.kind === 'failed' ? `${o.error.code} ${o.error.message}` : o.message}`);
	return o.output;
};
/** Background preparation has settled (bounded: 2 s). */
const settled = async () => {
	for (let i = 0; i < 400 && guestIsolates().preparing > 0; i++) await new Promise((r) => setTimeout(r, 5));
	expect(guestIsolates().preparing).toBe(0);
};
/** Every live isolate is an idle prepared one: nothing outlived its invocation. */
const noneRunning = () => expect(guestIsolates().live).toBe(guestIsolates().warm);
/** Drops every prepared isolate of every program (a cap of 0 evicts all on the next preparation). */
const evictAll = async () => {
	const saved = { ...warmLimits };
	Object.assign(warmLimits, { maxMiB: 0, depth: 1 });
	ok(await runner(program('async () => 0', `// flush ${Math.random()}`)).invoke(invocation(), bridge));
	await settled();
	Object.assign(warmLimits, saved);
	expect(guestIsolates().warm).toBe(0);
};

const defaults = { ...warmLimits };
afterEach(() => { Object.assign(warmLimits, defaults); });

describe('prepared isolates', () => {
	it('serves invocations from prepared isolates, and none sees another invocation\'s globals or module state', async () => {
		const r = runner(program('async () => [++count, typeof globalThis.leak, (globalThis.leak = 1)]', 'let count = 0;'));
		const before = guestIsolates().hits;
		expect(ok(await r.invoke(invocation('a'), bridge))).toEqual([1, 'undefined', 1]);
		await settled();
		for (const id of ['b', 'c', 'd']) {
			expect(ok(await r.invoke(invocation(id), bridge))).toEqual([1, 'undefined', 1]);
			await settled();
		}
		// concurrent invocations too: each its own isolate
		const all = await Promise.all(['e', 'f', 'g', 'h'].map((id) => r.invoke(invocation(id), bridge)));
		expect(all.map(ok)).toEqual(Array(4).fill([1, 'undefined', 1]));
		expect(guestIsolates().hits - before).toBeGreaterThanOrEqual(3);
		await settled();
		noneRunning();
	});

	it('binds the taking invocation\'s seed, and replays its entropy exactly', async () => {
		const r = runner(program('async () => crypto.randomUUID()'));
		const first = ok(await r.invoke(invocation('same'), bridge));
		await settled();
		expect(ok(await r.invoke(invocation('same'), bridge))).toBe(first); // served prepared: same seed, same draw
		expect(ok(await r.invoke(invocation('other'), bridge))).not.toBe(first);
	});

	it('disposes an over-budget isolate and never reuses it', async () => {
		const r = runner(program('async () => { if (globalThis.poisoned) return "reused"; globalThis.poisoned = true; for (;;) {} }'));
		const o = await r.invoke(invocation('spin'), bridge);
		expect(o.kind === 'failed' && o.error.code).toBe('cpuBudget');
		await settled();
		noneRunning();
		// the program's next isolate is a prepared one, and it never saw the poisoned heap
		const { hits } = guestIsolates();
		const again = await r.invoke(invocation('again'), bridge);
		expect(guestIsolates().hits).toBe(hits + 1);
		expect(again.kind === 'failed' && again.error.code).toBe('cpuBudget');
		await settled();
		noneRunning();
	}, 20_000);

	it('keeps at most `depth` prepared isolates per program', async () => {
		await evictAll();
		warmLimits.depth = 3;
		const r = runner(program('async () => 1', `// depth ${Math.random()}`));
		await Promise.all(Array.from({ length: 6 }, (_, i) => r.invoke(invocation(`d${i}`), bridge)));
		await settled();
		expect(guestIsolates().warm).toBeLessThanOrEqual(3);
		expect(guestIsolates().warm).toBeGreaterThan(0);
		warmLimits.depth = 0; // off: every invocation evaluates inline, nothing is kept
		await evictAll();
		ok(await r.invoke(invocation('none'), bridge));
		await settled();
		expect(guestIsolates().warm).toBe(0);
		noneRunning();
	});

	it('holds prepared bytes under the process cap, evicting the least recently invoked program first', async () => {
		await evictAll();
		warmLimits.depth = 2;
		const cold = runner(program('async () => "cold"', `// cold ${Math.random()}`));
		ok(await cold.invoke(invocation('c1'), bridge));
		await settled();
		expect(guestIsolates().warm).toBe(2);
		warmLimits.maxMiB = guestIsolates().warmBytes / 2 ** 20; // room for two prepared isolates
		const hot = runner(program('async () => "hot"', `// hot ${Math.random()}`));
		ok(await hot.invoke(invocation('h1'), bridge));
		await settled();
		expect(guestIsolates().warmBytes).toBeLessThanOrEqual(warmLimits.maxMiB * 2 ** 20);
		const { hits, misses } = guestIsolates();
		ok(await hot.invoke(invocation('h2'), bridge));
		expect(guestIsolates().hits).toBe(hits + 1); // the hot program kept its prepared isolate
		ok(await cold.invoke(invocation('c2'), bridge));
		expect(guestIsolates().misses).toBe(misses + 1); // the cold one was evicted
		await settled();
		expect(guestIsolates().warmBytes).toBeLessThanOrEqual(warmLimits.maxMiB * 2 ** 20);
	});

	it('drops a program\'s prepared isolates once it goes idle', async () => {
		await evictAll();
		warmLimits.idleMs = 50;
		const r = runner(program('async () => 1', `// idle ${Math.random()}`));
		ok(await r.invoke(invocation(), bridge));
		await settled();
		expect(guestIsolates().warm).toBeGreaterThan(0);
		for (let i = 0; i < 100 && guestIsolates().warm > 0; i++) await new Promise((r) => setTimeout(r, 10));
		expect(guestIsolates().warm).toBe(0);
		noneRunning();
	});

	it('kills prepared isolates with their generation (rule 71a) and prepares none after', async () => {
		await evictAll();
		const generation = new AbortController();
		const r = runner(program('async () => 1', `// gen ${Math.random()}`), generation.signal);
		ok(await r.invoke(invocation(), bridge));
		await settled();
		expect(guestIsolates().warm).toBeGreaterThan(0);
		generation.abort();
		expect(guestIsolates().warm).toBe(0);
		const o = await r.invoke(invocation('late'), bridge);
		expect(o.kind === 'failed' && o.error.code).toBe('interrupted');
		await settled();
		expect(guestIsolates().warm).toBe(0);
		noneRunning();
	});
});
