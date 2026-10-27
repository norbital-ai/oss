/// <reference types="node" />
// The guest edge (D8): generator bodies run through `runBody` over the lifted ctx, in the real isolate runner, over a
// bundle `bolt check` builds. Typed failures settle as an async body's do (refused message and field, guestError name
// and message); a concurrent `Effect.all` crosses once; an interrupted sibling never leaves a call unawaited; an unyielded
// call never crosses; scheduler yields are microtasks; a bundle without generator bodies carries no Effect.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Schema } from 'effect';
import { Guest, type Bridge, type CrossCall } from '../src/engine/services.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { check } from '../src/compiler/check/index.ts';
import { attached } from '../src/decl/body.ts';
import { install as installEdge } from '../src/decl/runtime/guest.ts';
import type { Json } from '../src/decl/values.ts';
import {
	type CrossAnswer,
	type GuestOutcome,
	type Invocation,
	type InvocationKind,
	LIMITS
} from '../src/engine/contracts.ts';
import { type GuestOptions, type GuestProgram } from '../src/engine/guest/runner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const EFFECT = JSON.stringify(createRequire(import.meta.url).resolve('effect'));
const ERRORS = JSON.stringify(fileURLToPath(new URL('../src/decl/errors.ts', import.meta.url)));
const BUILD_MS = 120_000;

// two generator automations and one over the facilities; none imports the edge:
// `bolt check` installs it in a module that holds a generator body
const EDGE_BODIES = `import { automation } from '@norbital-ai/bolt';
import { Effect } from ${EFFECT};
import { Refusal } from ${ERRORS};
const gen = function* (input, ctx) {
	switch (input.case) {
		case 'refuse': return yield* Effect.fail(new Refusal({ message: 'no', field: 'x' }));
		case 'act': return yield* ctx.act('t.create', [{}]);
		case 'boom': throw new Error('boom');
		case 'read': return yield* ctx.query({ t: { where: { id: { eq: 'x' } } } });
		case 'caught': return yield* ctx.act('t.create', [{}]).pipe(Effect.catchTag('ActRefused', (refused) => Effect.succeed(refused.code)));
		case 'all': return yield* Effect.all([ctx.query({ t: { where: { id: { eq: 'x' } } } }), ctx.query({ t: { where: { id: { eq: 'y' } } } }), ctx.query({ t: { where: { id: { eq: 'z' } } } })], { concurrency: 'unbounded' });
		case 'sequential': return yield* Effect.all([ctx.query({ t: { where: { id: { eq: 'x' } } } }), ctx.query({ t: { where: { id: { eq: 'y' } } } }), ctx.query({ t: { where: { id: { eq: 'z' } } } })]);
		case 'sibling': return yield* Effect.all([ctx.query({ t: { where: { id: { eq: 'x' } } } }), Effect.die(new Error('sibling'))], { concurrency: 'unbounded' });
		case 'unyielded': { ctx.act('t.create', [{}]); return 1; }
		case 'timers': {
			const real = globalThis.setTimeout;
			let timers = 0;
			globalThis.setTimeout = (...args) => { timers++; return real(...args); };
			try { yield* Effect.forEach(Array.from({ length: 5000 }, (_, i) => i), () => Effect.void); } finally { globalThis.setTimeout = real; }
			return timers;
		}
	}
};
const reference = function* (input, ctx) {
	switch (input.case) {
		case 'refuse': return yield* Effect.fail(new Refusal({ message: 'no', field: 'x' }));
		case 'act': return yield* ctx.act('t.create', [{}]);
		case 'boom': throw new Error('boom');
		case 'read': return yield* ctx.query({ t: { where: { id: { eq: 'x' } } } });
	}
};
`;
const edgeAutomation = (body: 'gen' | 'reference') => `${EDGE_BODIES}
export default automation('edge_${body}', {
	description: 'The guest edge', runAs: 'trigger', input: { case: { kind: 'text' } }, run: ${body}
});
`;
const AUTOMATION = `import { automation } from '@norbital-ai/bolt';
import { Effect } from ${EFFECT};
export default automation('facility', { description: 'Facilities', runAs: 'trigger', input: { case: { kind: 'text' } }, run: function* (input, ctx) {
	switch (input.case) {
		case 'uncaught': return yield* ctx.web.read('https://a.test');
		case 'caught': return yield* ctx.web.read('https://a.test').pipe(Effect.catchTag('FacilityFailure', (failure) => Effect.succeed(failure.kind)));
		case 'geo': return yield* ctx.geo.search('x').pipe(Effect.catchTag('Unavailable', (unavailable) => Effect.succeed(unavailable.reason)));
	}
} });
`;

const model = (name: string) => ({
	[`src/data/model/${name}/+model.ts`]: `import { model } from '@norbital-ai/bolt';
export default model('${name}', { description: 'A ${name}', label: 'title', fields: { title: { kind: 'text' } }, read: 'all' });
`
});

const roots: string[] = [];
/** A workspace of `files` under a fresh directory, through `bolt check`: its guest program (declaration errors aside). */
function built(files: Readonly<Record<string, string>>) {
	return Effect.gen(function* () {
		const root = mkdtempSync(join(tmpdir(), 'norbital-edge-'));
		roots.push(root);
		for (const [path, source] of Object.entries({
			'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
			...files
		})) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), source);
		}
		const { guest, errors } = yield* check(root);
		if (guest === undefined)
			throw new Error(
				`no guest program:\n${errors.map((e) => `${e.code} ${e.message}`).join('\n')}`
			);
		return guest;
	}).pipe(Effect.provide(NodeServices.layer));
}
let edge: GuestProgram, blank: GuestProgram;
beforeAll(async () => {
	edge = await Effect.runPromise(
		built({
			'src/automation/+edge_gen.automation.ts': edgeAutomation('gen'),
			'src/automation/+edge_reference.automation.ts': edgeAutomation('reference'),
			'src/automation/+facility.automation.ts': AUTOMATION
		})
	);
	blank = await Effect.runPromise(built(model('notes')));
}, BUILD_MS);
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const invocation = (kind: InvocationKind, target: string, input: Json): Invocation => ({
	id: 'inv-1',
	kind,
	target,
	input,
	ctx: {
		actor: { kind: 'system', run: 'r1', by: { platform: 'test' } },
		now: '2026-01-01T20:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 'seed-1'
	},
	budget: {
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
});
/** The stub lowers a read request `{ <model>: { where: { id: { eq } } } }` as one record. */
const IdRequest = Schema.Record(
	Schema.String,
	Schema.Struct({ where: Schema.Struct({ id: Schema.Struct({ eq: Schema.String }) }) })
);
const lowerRead: GuestOptions['lowerRead'] = (_member, args) => {
	const [root = '', layer] = Object.entries(Schema.decodeUnknownSync(IdRequest)(args[0]))[0] ?? [];
	return {
		kind: 'get',
		model: root,
		id: layer?.where.id.eq ?? '',
		select: { fields: null, relations: {} }
	};
};
/** A bridge answering each call with `answer`, recording every crossing. */
const recorder = (answer: (call: CrossCall) => CrossAnswer = () => ({ ok: true, value: 1 })) => {
	const crossings: (readonly CrossCall[])[] = [];
	const bridge: Bridge = {
		cross: (calls) =>
			Effect.sync(() => {
				crossings.push(calls);
				return calls.map(answer);
			})
	};
	return { crossings, bridge };
};
const run = (kind: InvocationKind, target: string, input: Json, bridge = recorder().bridge) =>
	Guest.pipe(
		Effect.flatMap((guest) => guest.invoke(invocation(kind, target, input), bridge)),
		Effect.provide(guestLayer(edge, { lowerRead, console: () => {} }))
	);
const edgeRun = (
	body: 'gen' | 'reference',
	input: Json,
	answer?: (call: CrossCall) => CrossAnswer
) => run('automation', `edge_${body}`, input, recorder(answer).bridge);
/** What parity compares: the settled kind, native refusal metadata, and a failure's code and message. */
const shape = (o: GuestOutcome) =>
	o.kind === 'failed'
		? { kind: o.kind, code: o.error.code, message: o.error.message }
		: o.kind === 'refused'
			? {
					kind: o.kind,
					message: o.message,
					...(o.code === undefined ? {} : { code: o.code }),
					...(o.field === undefined ? {} : { field: o.field }),
					...(o.row === undefined ? {} : { row: o.row }),
					...(o.rows === undefined ? {} : { rows: o.rows }),
					...(o.rule === undefined ? {} : { rule: o.rule }),
					...(o.data === undefined ? {} : { data: o.data }),
					...(o.records === undefined ? {} : { records: o.records }),
					...(o.invocation === undefined ? {} : { invocation: o.invocation })
				}
			: { kind: o.kind, output: o.output };
const ok = (o: GuestOutcome): Json => {
	if (o.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(shape(o))}`);
	return o.output;
};

describe('typed failures settle as an async body settles', () => {
	const acts =
		(value: Json) =>
		(call: CrossCall): CrossAnswer =>
			call._tag === 'act' ? { ok: true, value } : { ok: true, value: null };
	const cases: readonly {
		readonly name: string;
		readonly input: Json;
		readonly answer?: (call: CrossCall) => CrossAnswer;
		readonly expected: object;
	}[] = [
		{
			name: 'refuse',
			input: { case: 'refuse' },
			expected: { kind: 'refused', code: 'refused', message: 'no', field: 'x' }
		},
		{
			name: 'a refused act',
			input: { case: 'act' },
			answer: acts({ kind: 'refused', code: 'unique', message: 'taken', field: 'y' }),
			expected: { kind: 'refused', code: 'unique', message: 'taken', field: 'y' }
		},
		{
			name: 'a conflicted act',
			input: { case: 'act' },
			answer: acts({ kind: 'conflict', records: [{ model: 't', id: '1', fields: ['a'] }] }),
			expected: {
				kind: 'refused',
				code: 'conflict',
				message: 'another write changed these records since they were read',
				records: [{ model: 't', id: '1', fields: ['a'] }]
			}
		},
		{
			name: 'an unknown act',
			input: { case: 'act' },
			answer: acts({ kind: 'unknown', invocation: 'inv-9' }),
			expected: {
				kind: 'refused',
				code: 'unknown',
				message: 'the outcome of inv-9 could not be confirmed',
				invocation: 'inv-9'
			}
		},
		{
			name: 'a throw',
			input: { case: 'boom' },
			expected: { kind: 'failed', code: 'guestError', message: 'boom' }
		},
		{
			name: 'an engine fault',
			input: { case: 'read' },
			answer: () => ({ ok: false, error: { kind: 'bolt', code: 'forbidden', message: 'no read' } }),
			expected: { kind: 'failed', code: 'guestError', message: 'no read' }
		}
	];
	for (const c of cases)
		it.live(c.name, () =>
			Effect.gen(function* () {
				const [gen, reference] = [
					yield* edgeRun('gen', c.input, c.answer),
					yield* edgeRun('reference', c.input, c.answer)
				];
				expect(shape(gen)).toEqual(c.expected);
				expect(shape(reference)).toEqual(shape(gen));
				if (gen.kind === 'failed' && reference.kind === 'failed')
					expect(gen.error.cause).toMatchObject({
						name: Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
							reference.error.cause
						).name
					});
			})
		);

	it.live('a caught ActRefused is a value', () =>
		Effect.gen(function* () {
			expect(
				ok(
					yield* edgeRun(
						'gen',
						{ case: 'caught' },
						acts({ kind: 'refused', code: 'unique', message: 'taken' })
					)
				)
			).toBe('unique');
		})
	);
	it.live(
		'a facility fails with FacilityFailure, its kind on the prelude tuple; Unavailable is caught by its tag',
		() =>
			Effect.gen(function* () {
				const timeout = recorder(() => ({
					ok: false,
					error: { kind: 'timeout', message: 'slow' }
				}));
				expect(
					yield* run('automation', 'facility', { case: 'uncaught' }, timeout.bridge)
				).toMatchObject({
					kind: 'failed',
					error: { code: 'guestError', message: 'slow', cause: { name: 'FacilityFailure' } }
				});
				expect(ok(yield* run('automation', 'facility', { case: 'caught' }, timeout.bridge))).toBe(
					'timeout'
				);
				const absent = recorder(() => ({
					ok: false,
					error: { kind: 'unavailable', facility: 'geo', reason: 'no geocoder' }
				}));
				expect(ok(yield* run('automation', 'facility', { case: 'geo' }, absent.bridge))).toBe(
					'no geocoder'
				);
			})
	);
});

describe('crossings', () => {
	const ids = (call: CrossCall): CrossAnswer => ({
		ok: true,
		value: call._tag === 'read' && call.read.kind === 'get' ? call.read.id : null
	});
	it.live('a concurrent Effect.all crosses once; a sequential one crosses per call', () =>
		Effect.gen(function* () {
			const together = recorder(ids),
				apart = recorder(ids);
			expect(ok(yield* run('automation', 'edge_gen', { case: 'all' }, together.bridge))).toEqual([
				'x',
				'y',
				'z'
			]);
			expect(together.crossings.map((c) => c.length)).toEqual([3]);
			expect(
				ok(yield* run('automation', 'edge_gen', { case: 'sequential' }, apart.bridge))
			).toEqual(['x', 'y', 'z']);
			expect(apart.crossings.map((c) => c.length)).toEqual([1, 1, 1]);
		})
	);
	it.live("a sibling's failure waits for the call it interrupts: never `unawaited`", () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder(ids);
			expect(shape(yield* run('automation', 'edge_gen', { case: 'sibling' }, bridge))).toEqual({
				kind: 'failed',
				code: 'guestError',
				message: 'sibling'
			});
			expect(crossings.map((c) => c.length)).toEqual([1]);
		})
	);
	it.live('an unyielded act makes no crossing', () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder();
			expect(ok(yield* run('automation', 'edge_gen', { case: 'unyielded' }, bridge))).toBe(1);
			expect(crossings).toEqual([]);
		})
	);
	it.live("the scheduler yields on microtasks, never the prelude's zero-delay timer", () =>
		Effect.gen(function* () {
			expect(ok(yield* edgeRun('gen', { case: 'timers' }))).toBe(0);
		})
	);
});

describe('the bundle', () => {
	const sources = (program: GuestProgram): readonly string[] =>
		Schema.decodeUnknownSync(
			Schema.fromJsonString(Schema.Struct({ sources: Schema.Array(Schema.String) }))
		)(program.sourceMap ?? '{"sources":[]}').sources;
	it('carries the edge and Effect beside a generator body, and neither without one (blank)', () => {
		expect(sources(edge).some((s) => s.endsWith('decl/runtime/guest.ts'))).toBe(true);
		expect(sources(edge).some((s) => s.includes('/effect/dist/'))).toBe(true);
		expect(sources(blank).some((s) => s.endsWith('decl/model.ts'))).toBe(false);
		expect(
			sources(blank).filter((s) => s.includes('/effect/') || s.endsWith('decl/runtime/guest.ts'))
		).toEqual([]);
		expect(blank.source).not.toContain('[object GeneratorFunction]');
	});
	it.effect(
		'rejects missing edges and non-generator attachments while preserving generator metadata',
		() =>
			Effect.acquireUseRelease(
				Effect.sync(() => attached.wrap),
				() =>
					Effect.sync(() => {
						attached.wrap = undefined;
						const body = function* namedBody() {
							return 1;
						};
						expect(() => attached(body, -1)).toThrow(
							'ctx-bearing body must be a generator function; guest edge missing'
						);
						expect(() => attached(() => 1, -1)).toThrow(
							'ctx-bearing body must be a generator function; guest edge missing'
						);
						installEdge();
						for (const invalid of [
							() => 1,
							async () => 1,
							async function* () {
								yield 1;
							}
						])
							expect(() => attached(invalid, -1)).toThrow(
								'a ctx-bearing body must be a generator function'
							);
						const wrapped = attached(body, -1);
						expect(wrapped.name).toBe(body.name);
						expect(Reflect.get(wrapped, Symbol.for('norbital.bolt.generator'))).toBe(body);
					}),
				(previous) =>
					Effect.sync(() => {
						attached.wrap = previous;
					})
			)
	);
	it.live(
		'evaluates generator bodies from source while ignoring tenant native snapshot properties',
		() =>
			Effect.gen(function* () {
				const good = yield* check(join(here, 'fixtures/good')).pipe(
					Effect.provide(NodeServices.layer)
				);
				if (good.guest === undefined) throw new Error('the good fixture has no guest program');
				expect('snapshot' in good.guest).toBe(false);
				const untrusted = {
					...edge,
					get snapshot(): Uint8Array {
						throw new Error('a native snapshot must not be read');
					}
				};
				const evaluated = Guest.pipe(
					Effect.flatMap((guest) =>
						guest.invoke(
							invocation('automation', 'edge_gen', { case: 'refuse' }),
							recorder().bridge
						)
					),
					Effect.provide(guestLayer(untrusted, { lowerRead, console: () => {} }))
				);
				expect(shape(yield* evaluated)).toEqual({
					kind: 'refused',
					code: 'refused',
					message: 'no',
					field: 'x'
				});
			}),
		BUILD_MS
	);
});
