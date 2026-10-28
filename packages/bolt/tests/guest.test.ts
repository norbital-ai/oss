/// <reference types="node" />
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { check } from '../src/compiler/check/index.ts';
import ivm from 'isolated-vm';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import {
	type CrossAnswer,
	type GuestOutcome,
	type Invocation,
	type InvocationKind,
	LIMITS
} from '../src/engine/contracts.ts';
import { isTransient } from '../src/engine/errors.ts';
import type { IsolateGlobals } from '../src/engine/guest/globals.ts';
import { PRELUDE } from '../src/engine/guest/prelude.ts';
import { GuestParking, type GuestOptions, type GuestProgram } from '../src/engine/guest/runner.ts';
import {
	Guest,
	type Bridge,
	type CrossCall,
	type InvocationEvents
} from '../src/engine/services.ts';
import { GuestIsolates } from '../src/engine/ports.ts';
import { guestIsolates, type GuestIsolatesOptions } from '../src/node/guest-isolates.ts';
import { guestLayer, program } from './support/guest-fixture.ts';
const node = NodeServices.layer;

// Generator fixtures carry the declaration edge. Pure global-shim programs exercise the raw prelude ABI.
const automation = (body: string, prefix = '') =>
	`${body.includes('function*') ? "import { Effect, Cause } from 'effect';" : ''}${prefix}\nexport default { automation: { a: { body: ${body} } } };\n`;
const invocation = (
	input: Json = null,
	budget: Partial<Invocation['budget']> = {},
	kind: InvocationKind = 'automation',
	target = 'a'
): Invocation => ({
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
		readBytes: LIMITS.readBytes,
		...budget
	}
});
/** A read request's first root and, when it filters `id: { eq }`, that id (the stub lowers it as one record). */
const IdRequest = Schema.Record(
	Schema.String,
	Schema.Struct({
		where: Schema.optionalKey(Schema.Struct({ id: Schema.Struct({ eq: Schema.String }) }))
	})
);
const lowerRead: GuestOptions['lowerRead'] = (member, args) => {
	const [root = member, layer] =
		Object.entries(Schema.decodeUnknownSync(IdRequest)(args[0]))[0] ?? [];
	return {
		kind: 'get',
		model: root,
		id: layer?.where?.id.eq ?? member,
		select: { fields: null, relations: {} }
	};
};
const recorder = (
	answer: (call: CrossCall) => CrossAnswer | Effect.Effect<CrossAnswer> = () => ({
		ok: true,
		value: 1
	})
) => {
	const crossings: (readonly CrossCall[])[] = [];
	const bridge: Bridge = {
		cross: (calls) =>
			Effect.gen(function* () {
				crossings.push(calls);
				return yield* Effect.forEach(
					calls,
					(call) => {
						const value = answer(call);
						return Effect.isEffect(value) ? value : Effect.succeed(value);
					},
					{ concurrency: 'unbounded' }
				);
			})
	};
	return { crossings, bridge };
};
const compiled = new Map<string, Effect.Effect<GuestProgram>>();
const sourceProgram = (source: string) => {
	let built = compiled.get(source);
	if (built === undefined) {
		built = source.includes('function*') ? program(source) : Effect.succeed({ source });
		compiled.set(source, built);
	}
	return built;
};
/** The Node host's guest isolates under `options` (a CPU budget, a meter). */
const hostIsolates = (options: GuestIsolatesOptions) =>
	Layer.unwrap(Effect.map(guestIsolates(options), (port) => GuestIsolates.fromAbi(port)));
const runProgram = (
	guest: GuestProgram,
	inv = invocation(),
	bridge = recorder().bridge,
	options: GuestOptions = {},
	events?: InvocationEvents,
	isolates?: Layer.Layer<GuestIsolates>
) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			guestLayer(
				guest,
				{ lowerRead, console: () => {}, ...options },
				events === undefined ? undefined : () => Effect.succeed(events),
				isolates
			)
		);
		return yield* Context.get(context, Guest).invoke(inv, bridge);
	});
const runIn = (
	source: string,
	inv = invocation(),
	bridge = recorder().bridge,
	options: GuestOptions = {},
	events?: InvocationEvents,
	isolates?: Layer.Layer<GuestIsolates>
) =>
	Effect.flatMap(sourceProgram(source), (guest) =>
		runProgram(guest, inv, bridge, options, events, isolates)
	);
const ok = (o: GuestOutcome) => {
	if (o.kind !== 'ok')
		throw new Error(
			`expected ok, got ${o.kind}: ${o.kind === 'failed' ? `${o.error.code} ${o.error.message}` : o.message}`
		);
	return o.output;
};
const failure = (o: GuestOutcome) =>
	o.kind === 'failed' ? { code: o.error.code, message: o.error.message } : o;

describe('next guest runner', () => {
	it.live(
		'runs supplied programs independently of activation and keys their source and assets separately',
		() =>
			Effect.gen(function* () {
				const activation: GuestProgram = {
					source: automation('() => "activation"')
				};
				const context = yield* Layer.build(guestLayer(activation, { console: () => {} }));
				const guest = Context.get(context, Guest);
				const page = (label: string, byte: number): GuestProgram => ({
					source: `let calls = 0; export default { page: { "portal/book": { body: () => [${JSON.stringify(label)}, ++calls, ...globalThis[Symbol.for('norbital.bolt.asset')]('page-data')] } } };`,
					assets: { 'page-data': new Uint8Array([byte]) }
				});
				const first = page('first', 1);
				const otherSource = page('other', 1);
				const otherAssets = page('first', 2);
				for (const [program, expected] of [
					[first, ['first', 1, 1]],
					[otherSource, ['other', 1, 1]],
					[otherAssets, ['first', 1, 2]],
					[first, ['first', 1, 1]]
				] as const)
					expect(
						ok(
							yield* guest.invokeProgram(
								program,
								invocation(null, {}, 'page', 'portal/book'),
								recorder().bridge
							)
						)
					).toEqual(expected);
				expect(ok(yield* guest.invoke(invocation(), recorder().bridge))).toBe('activation');
			})
	);

	it.live(
		'gives a page caller reads and safe clock and actor values without privileged context',
		() =>
			Effect.gen(function* () {
				const page =
					yield* program(`export default { page: { "portal/read": { body: function* (_, ctx) {
				const answer = yield* ctx.query({ orders: { limit: 1 } });
				return { answer, actor: ctx.actor, today: ctx.today, keys: Object.keys(ctx).sort() };
			} } } };`);
				const context = yield* Layer.build(
					guestLayer({ source: 'export default {};' }, { lowerRead })
				);
				const guest = Context.get(context, Guest);
				const base = invocation(null, {}, 'page', 'portal/read');
				const inv: Invocation = {
					...base,
					ctx: {
						...base.ctx,
						admin: true,
						policies: ['private'],
						configuration: { secret: 'hidden' }
					}
				};
				expect(ok(yield* guest.invokeProgram(page, inv, recorder().bridge))).toEqual({
					answer: 1,
					actor: base.ctx.actor,
					today: base.ctx.today,
					keys: [
						'actor',
						'aggregate',
						'history',
						'invocationId',
						'now',
						'query',
						'today',
						'todayIn',
						'tz'
					]
				});
				const raw: GuestProgram = {
					source:
						'export default { page: { "portal/read": { body: (_, ctx) => Object.keys(ctx).sort() } } };'
				};
				expect(ok(yield* guest.invokeProgram(raw, inv, recorder().bridge))).toEqual([
					'actor',
					'invocationId',
					'now',
					'today',
					'tz'
				]);
			})
	);

	it.live('refuses forged non-read page crossings before the host bridge can execute them', () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(guestLayer({ source: 'export default {};' }));
			const guest = Context.get(context, Guest);
			for (const member of ['act', 'db.query', 'schedule', 'files.get', 'ai.embed', 'request']) {
				const page: GuestProgram = {
					source: `export default { page: { "portal/read": { body: () => globalThis[Symbol.for('norbital.bolt.call')](${JSON.stringify(member)}, []) } } };`
				};
				const { crossings, bridge } = recorder();
				expect(
					failure(
						yield* guest.invokeProgram(page, invocation(null, {}, 'page', 'portal/read'), bridge)
					)
				).toEqual({ code: 'forbidden', message: `page rendering cannot call '${member}'` });
				expect(crossings).toEqual([]);
			}
		})
	);

	it.live('keeps one cumulative crossing budget for a supplied page program', () =>
		Effect.gen(function* () {
			const page =
				yield* program(`export default { page: { "portal/read": { body: function* (_, ctx) {
				yield* ctx.query({ orders: { limit: 1 } });
				return yield* ctx.query({ orders: { limit: 1 } });
			} } } };`);
			const context = yield* Layer.build(
				guestLayer({ source: 'export default {};' }, { lowerRead })
			);
			const { crossings, bridge } = recorder();
			const outcome = yield* Context.get(context, Guest).invokeProgram(
				page,
				invocation(null, { crossings: 1 }, 'page', 'portal/read'),
				bridge
			);
			expect(failure(outcome)).toMatchObject({ code: 'crossingBudget' });
			expect(crossings).toHaveLength(1);
		})
	);

	it.live('runs a body and returns its JSON output', () =>
		Effect.gen(function* () {
			const o = yield* runIn(
				automation(
					'function* (input, ctx) { return ({ twice: input.n * 2, today: ctx.today, inv: ctx.invocationId, tokyo: ctx.todayIn("Asia/Tokyo") }); }'
				),
				invocation({ n: 21 })
			);
			expect(ok(o)).toEqual({ twice: 42, today: '2026-01-01', inv: 'inv-1', tokyo: '2026-01-02' });
		})
	);

	it.live('finds each kind of body in the default export', () =>
		Effect.gen(function* () {
			const source = `export default {
			model: { orders: { bodies: {
				create: function* () { return ['model','orders','bodies','create']; },
				update: function* () { return ['model','orders','bodies','update']; },
				delete: function* () { return ['model','orders','bodies','delete']; },
				notify: function* () { return ['model','orders','bodies','notify']; },
				indexes: { hue: { vector: () => [1,2,3], probe: () => ({ vector: [1,2,3] }), rerank: (_, row) => row.score } },
				syncs: { crm: {
					read: function* () { return ['model','orders','bodies','syncs','crm','read']; },
					write: function* () { return ['model','orders','bodies','syncs','crm','write']; },
					parse: { 'application/json': function* () { return ['model','orders','bodies','syncs','crm','parse','application/json']; } }
				} }
			} } },
			custom_field: { iban: { check: (input) => 'custom_field.iban.check:' + input } },
			policy: { review: { grants: { orders: { create: { check: function* (_, ctx) { return ctx.approve((flow) => flow.step('Review', { teams: ['finance'] })); } } } } } }
		};`;
			for (const [kind, target, input, expected] of [
				['create', 'orders', [], ['model', 'orders', 'bodies', 'create']],
				['update', 'orders', [], ['model', 'orders', 'bodies', 'update']],
				['delete', 'orders', [], ['model', 'orders', 'bodies', 'delete']],
				['notify', 'orders', {}, ['model', 'orders', 'bodies', 'notify']],
				['vector', 'orders.hue', [{}], [[1, 2, 3]]],
				['probe', 'orders.hue', {}, { vector: [1, 2, 3] }],
				['rerank', 'orders.hue', [{}, [{ score: 3 }, { score: 1 }]], [3, 1]],
				['syncRead', 'orders.crm', {}, ['model', 'orders', 'bodies', 'syncs', 'crm', 'read']],
				['syncWrite', 'orders.crm', {}, ['model', 'orders', 'bodies', 'syncs', 'crm', 'write']],
				[
					'parse',
					'orders.crm.application/json',
					{},
					['model', 'orders', 'bodies', 'syncs', 'crm', 'parse', 'application/json']
				],
				['validation', 'iban', ['probe'], ['custom_field.iban.check:probe']],
				[
					'policy',
					'review.orders.create',
					[],
					{
						kind: 'approve',
						flow: {
							kind: 'steps',
							steps: [{ name: 'Review', teams: ['finance'], users: [] }],
							superseded_by: []
						}
					}
				]
			] as const)
				expect(ok(yield* runIn(source, invocation(input, {}, kind, target)))).toEqual(expected);
		})
	);

	it.live(
		"a policy check sees the PolicyCtx alone (clock, actor, policies, one reader, three verdicts) and answers its verdict's data",
		() =>
			Effect.gen(function* () {
				const source = `export default { policy: { rep: { grants: { orders: {
					create: { check: function* (rows, ctx) {
						return rows.length === 0 ? ctx.allow() : ctx.deny('Keys: ' + Object.keys(ctx).sort().join(',') + '; db: ' + Object.keys(ctx.db).sort().join(','), { row: 0, path: 'orders.lines', field: 'qty' });
					} }
				} } } } };`;
				const target = 'rep.orders.create';
				expect(ok(yield* runIn(source, invocation([], {}, 'policy', target)))).toEqual({
					kind: 'allow'
				});
				expect(ok(yield* runIn(source, invocation([{}], {}, 'policy', target)))).toEqual({
					kind: 'deny',
					message:
						'Keys: actor,allow,approve,db,deny,invocationId,now,policies,today,todayIn,tz; db: query',
					at: { row: 0, path: 'orders.lines', field: 'qty' }
				});
			})
	);

	it.live('only a marked file export writer receives bytes and image facilities', () =>
		Effect.gen(function* () {
			const source = `export default { model: { documents: { bodies: { syncs: { sheet: {
				read: function* (_, ctx) { return { files: typeof ctx.files }; },
				write: function* (_, ctx) {
					if (ctx.files === undefined) return { files: 'undefined' };
					const bytes = yield* ctx.files.get({ id: 'signature' });
					const image = yield* ctx.files.image({ id: 'signature' }, { jpeg: { maxEdge: 512 } });
					return { methods: Object.keys(ctx.files), bytes: Array.from(bytes), image };
				}
			} } } } } };`;
			const recorded = recorder((call) =>
				call._tag === 'files.get'
					? { ok: true, value: { $bin: 0 }, bins: [new Uint8Array([9, 8, 7])] }
					: { ok: true, value: { id: 'jpeg', name: 'signature.jpg', mime: 'image/jpeg' } }
			);
			const remote = invocation({}, {}, 'syncWrite', 'documents.sheet');
			expect(ok(yield* runIn(source, remote, recorded.bridge))).toEqual({ files: 'undefined' });
			const marked: Invocation = { ...remote, ctx: { ...remote.ctx, fileExport: true } };
			expect(ok(yield* runIn(source, marked, recorded.bridge))).toEqual({
				methods: ['get', 'image'],
				bytes: [9, 8, 7],
				image: { id: 'jpeg', name: 'signature.jpg', mime: 'image/jpeg' }
			});
			expect(recorded.crossings.flat().map((call) => call._tag)).toEqual([
				'files.get',
				'files.image'
			]);
			expect(ok(yield* runIn(source, { ...marked, kind: 'syncRead' }, recorded.bridge))).toEqual({
				files: 'undefined'
			});
		})
	);

	it.live(
		'write callbacks receive workspace reads and stop before the read past their crossing budget',
		() =>
			Effect.gen(function* () {
				const source = `export default { model: { orders: { bodies: {
				create: function* (rows, ctx) {
					for (let i = 0; i < ${LIMITS.crossings.write + 1}; i++) yield* ctx.db.query({ orders: { where: { id: { eq: 'x' } } } });
					return rows;
				},
				update: function* (changes, ctx) {
					return { rows: changes.map(({ before, set }) => ({ ...set, previous: before.title })), keys: Object.keys(ctx).sort(), db: Object.keys(ctx.db).sort() };
				}
			} } } };`;
				const { crossings, bridge } = recorder();
				expect(
					failure(
						yield* runIn(
							source,
							invocation([], { crossings: LIMITS.crossings.write }, 'create', 'orders'),
							bridge
						)
					)
				).toMatchObject({ code: 'crossingBudget' });
				expect(crossings).toHaveLength(LIMITS.crossings.write);
				expect(
					ok(
						yield* runIn(
							source,
							invocation(
								[{ before: { title: 'Before' }, set: { title: 'After' } }],
								{},
								'update',
								'orders'
							)
						)
					)
				).toEqual({
					rows: [{ title: 'After', previous: 'Before' }],
					keys: [
						'actor',
						'admin',
						'db',
						'invocationId',
						'now',
						'policies',
						'refuse',
						'today',
						'todayIn',
						'tz'
					],
					db: ['after', 'aggregate', 'query']
				});
			})
	);

	it.live(
		'preserves observed revisions across backend act calls and rejects malformed revision maps',
		() =>
			Effect.gen(function* () {
				const { crossings, bridge } = recorder(() => ({
					ok: true,
					value: { kind: 'committed', output: null, records: [] }
				}));
				ok(
					yield* runIn(
						automation(
							'function* (_, ctx) { return yield* ctx.act("jobs.update", [{ target: "job", set: { title: "new" } }], { observed: { job: 3 } }); }'
						),
						invocation(),
						bridge
					)
				);
				expect(crossings).toEqual([
					[
						{
							_tag: 'act',
							callable: { _tag: 'Verb', model: 'jobs', verb: 'update' },
							input: [{ target: 'job', set: { title: 'new' } }],
							options: { observed: { job: 3 } }
						}
					]
				]);
				for (const observed of [{ job: -1 }, { job: 1.5 }, { job: '3' }, { job: null }]) {
					const rejected = yield* runIn(
						automation(
							`function* (_, ctx) { return yield* ctx.act('jobs.update', [{}], { observed: ${JSON.stringify(observed)} }); }`
						)
					);
					expect(failure(rejected)).toMatchObject({ code: 'invalidInput' });
				}
				expect(crossings).toHaveLength(1);
			})
	);
	it.live('gives every invocation a fresh heap', () =>
		Effect.gen(function* () {
			const source = automation(
				'function* () { return ++globalThis.count; }',
				'globalThis.count = 0;'
			);
			expect(ok(yield* runIn(source))).toBe(1);
			expect(ok(yield* runIn(source))).toBe(1);
		})
	);

	it.live('crosses the calls made before the microtask queue drains together (rule 12)', () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder((c) => ({
				ok: true,
				value: c._tag === 'read' && c.read.kind === 'get' ? c.read.id : null
			}));
			const o = yield* runIn(
				automation(`function* (_, ctx) {
			const [a, b, c] = yield* Effect.all([ctx.query({ t: { where: { id: { eq: 'x' } } } }), ctx.query({ t: { where: { id: { eq: 'y' } } } }), ctx.query({ t: { where: { id: { eq: 'z' } } } })], { concurrency: 'unbounded' });
			const d = yield* ctx.query({ t: { where: { id: { eq: 'w' } } } });
			return [a, b, c, d];
		}`),
				invocation(),
				bridge
			);
			expect(ok(o)).toEqual(['x', 'y', 'z', 'w']);
			expect(crossings.map((c) => c.length)).toEqual([3, 1]);
		})
	);

	it.live('lowers writes and facilities to the contract calls', () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder((c) => ({
				ok: true,
				value: c._tag === 'act' ? { kind: 'committed', output: null, records: [] } : null
			}));
			ok(
				yield* runIn(
					automation(`function* (_, ctx) {
			yield* Effect.all([ctx.act('t.create', [{ a: 1 }], { key: 'k' }), ctx.schedule('b', {}, { key: 'q' }), ctx.notify({ to: [{ team: 'x' }], title: 'hi' }),
				ctx.send('mail', { to: 'a' }), ctx.request('crm', { method: 'POST', path: '/x', output: { kind: 'json' } }), ctx.web.read('https://a.test')], { concurrency: 'unbounded' });
		}`),
					invocation(),
					bridge
				)
			);
			// each facility call or instance request crosses alone (it lands as soon as it answers); the writes cross together, in order
			expect(crossings).toEqual([
				[
					{
						_tag: 'request',
						to: 'crm',
						operation: { method: 'POST', path: '/x', output: { kind: 'json' } }
					}
				],
				[{ _tag: 'web.read', args: ['https://a.test'] }],
				[
					{
						_tag: 'act',
						callable: { _tag: 'Verb', model: 't', verb: 'create' },
						input: [{ a: 1 }],
						options: { key: 'k' }
					},
					{ _tag: 'schedule', automation: 'b', input: {}, key: 'q' },
					{ _tag: 'notify', notices: { to: [{ team: 'x' }], title: 'hi' } },
					{ _tag: 'send', to: 'mail', message: { to: 'a' } }
				]
			]);
		})
	);

	it.live(
		'resumes a fast facility branch into ordered reads and writes while its sibling is held',
		() =>
			Effect.gen(function* () {
				const slow = yield* Deferred.make<void>(),
					grouped = yield* Deferred.make<void>();
				let slowFinished = false;
				const { crossings, bridge } = recorder((call) =>
					Effect.gen(function* () {
						if (call._tag === 'web.read') {
							if (call.args[0] === 'https://slow.test') {
								yield* Deferred.await(slow);
								slowFinished = true;
							}
							return { ok: true as const, value: call.args[0] ?? null };
						}
						if (call._tag === 'act') {
							if (
								call.callable._tag === 'Verb' &&
								call.callable.model === 'b' &&
								call.callable.verb === 'update'
							)
								yield* Deferred.succeed(grouped, undefined);
							return { ok: true as const, value: { kind: 'committed', output: null, records: [] } };
						}
						return { ok: true as const, value: 'read' };
					})
				);
				const running = yield* runIn(
					automation(`function* (_, ctx) {
			const slow = ctx.web.read('https://slow.test');
			const fast = Effect.gen(function* () {
				yield* ctx.web.read('https://fast.test');
				const [row] = yield* Effect.all([ctx.query({ t: { where: { id: { eq: 'x' } } } }), ctx.act('a.create', [{}]), ctx.act('b.update', [{ target: '0199a000-0000-7000-8000-000000000001', set: {} }])], { concurrency: 'unbounded' });
				return row;
			});
			return yield* Effect.all([slow, fast], { concurrency: 'unbounded' });
		}`),
					invocation(),
					bridge
				).pipe(Effect.forkScoped);
				yield* Effect.gen(function* () {
					yield* Deferred.await(grouped).pipe(Effect.timeout('5 seconds'));
					expect(slowFinished).toBe(false);
					expect(crossings.map((batch) => batch.length)).toEqual([1, 1, 3]);
					expect(crossings[2]).toMatchObject([
						{ _tag: 'read', read: { model: 't', id: 'x' } },
						{ _tag: 'act', callable: { _tag: 'Verb', model: 'a', verb: 'create' } },
						{ _tag: 'act', callable: { _tag: 'Verb', model: 'b', verb: 'update' } }
					]);
					yield* Deferred.succeed(slow, undefined);
					expect(ok(yield* Fiber.join(running))).toEqual(['https://slow.test', 'read']);
				}).pipe(Effect.ensuring(Deferred.succeed(slow, undefined)));
			})
	);
	it.live('moves bytes beside the JSON as $bin, both ways (§5.8.1)', () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder((c) =>
				c._tag === 'files.get'
					? { ok: true, value: { $bin: 0 }, bins: [new Uint8Array([9, 8, 7])] }
					: { ok: true, value: { id: 'f1' } }
			);
			const o = yield* runIn(
				automation(`function* (_, ctx) {
			const bytes = yield* ctx.files.get({ id: 'f0' });
			yield* ctx.files.put(new Uint8Array([1, 2]), { name: 'x', mime: 'a/b', for: 'a' });
			return [bytes instanceof Uint8Array, Array.from(bytes)];
		}`),
				invocation(),
				bridge
			);
			expect(ok(o)).toEqual([true, [9, 8, 7]]);
			expect(crossings[1]).toEqual([
				{
					_tag: 'files.put',
					args: [{ $bin: 0 }, { name: 'x', mime: 'a/b', for: 'a' }],
					bins: [new Uint8Array([1, 2])]
				}
			]);
		})
	);

	it.live('turns an answer the host cannot encode into a typed failure, never a hang', () =>
		Effect.gen(function* () {
			const poisoned: CrossAnswer = {
				ok: true,
				// @ts-expect-error Deliberately plant a non-JSON ABI answer to exercise encoding failure.
				value: 10n
			};
			const { bridge } = recorder(() => poisoned);
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { return yield* Effect.catchCause(Effect.as(ctx.query({ t: { where: { id: { eq: "x" } } } }), "resolved"), (cause) => Effect.succeed(Cause.squash(cause).code)); }'
				),
				invocation(),
				bridge
			);
			expect(ok(o)).toBe('badAnswer');
		})
	);

	it.live('recovers facility and geo errors through typed Effect failures', () =>
		Effect.gen(function* () {
			const { bridge } = recorder(() => ({
				ok: false,
				error: { kind: 'unavailable', facility: 'x', reason: 'none' }
			}));
			const lines: { event: string; severity: string }[] = [];
			const events: InvocationEvents = {
				emit: (severity, event) =>
					Effect.sync(() => {
						lines.push({ severity, event });
					})
			};
			const o = yield* runIn(
				automation(`function* (_, ctx) {
			const thrown = yield* Effect.catchTag(ctx.web.read('https://a.test'), 'Unavailable', () => Effect.succeed('unavailable'));
			const recovered = yield* Effect.catchTag(ctx.web.read('https://a.test'), 'Unavailable', () => Effect.succeed('unavailable'));
			const geo = yield* Effect.catchTag(ctx.geo.search('x'), 'Unavailable', () => Effect.succeed('unavailable'));
			return [thrown, recovered, geo];
		}`),
				invocation(),
				bridge,
				{},
				events
			);
			expect(ok(o)).toEqual(['unavailable', 'unavailable', 'unavailable']);
			expect(lines).toContainEqual(
				expect.objectContaining({ event: 'facility.failed', severity: 'warn' })
			);
		})
	);
	it.live('recovers ActRefused and retains a write callback refusal with its field', () =>
		Effect.gen(function* () {
			const refused = { kind: 'refused', code: 'refused', message: 'no' };
			const { bridge } = recorder(() => ({ ok: true, value: refused }));
			expect(
				ok(
					yield* runIn(
						automation(
							'function* (_, ctx) { return [yield* Effect.catchTag(ctx.act("t.create", [{}]), "ActRefused", (e) => Effect.succeed(e.message)), yield* Effect.catchTag(Effect.as(ctx.act("t.create", [{}]), "committed"), "ActRefused", () => Effect.succeed("refused"))]; }'
						),
						invocation(),
						bridge
					)
				)
			).toEqual(['no', 'refused']);
			const refusingTransform =
				'export default { model: { t: { bodies: { create: function* (_, ctx) { return yield* ctx.refuse("too late", { field: "day" }); } } } } };';
			expect(yield* runIn(refusingTransform, invocation([], {}, 'create', 't'))).toMatchObject({
				kind: 'refused',
				message: 'too late',
				field: 'day'
			});
		})
	);

	it.live(
		'preserves native act conflicts while an authored outcome-shaped throw remains an error',
		() =>
			Effect.gen(function* () {
				const conflict = {
					kind: 'conflict',
					records: [{ model: 't', id: 'row', fields: [] }]
				};
				const { bridge } = recorder(() => ({ ok: true, value: conflict }));
				// the native family rides the failed run: the readable conflict message plus the rows that moved
				expect(
					yield* runIn(
						automation('function* (_, ctx) { return yield* ctx.act("t.update", [{}]); }'),
						invocation(),
						bridge
					)
				).toMatchObject({
					kind: 'refused',
					code: 'conflict',
					message: 'another write changed these records since they were read',
					records: conflict.records
				});
				expect(
					ok(
						yield* runIn(
							automation(
								'function* (_, ctx) { return yield* Effect.catchTag(Effect.as(ctx.act("t.update", [{}]), "committed"), "ActConflict", () => Effect.succeed("conflict")); }'
							),
							invocation(),
							bridge
						)
					)
				).toBe('conflict');
				expect(
					yield* runIn(automation(`async () => { throw ${JSON.stringify(conflict)}; }`))
				).toMatchObject({ kind: 'failed' });
			})
	);

	it.live('keeps a guest throw as the cause, with its stack and line (rule 72a)', () =>
		Effect.gen(function* () {
			const o = yield* runIn(automation('async () => {\n  throw new TypeError("");\n}'));
			expect(o.kind).toBe('failed');
			if (o.kind !== 'failed') return;
			expect(o.error.code).toBe('guestError');
			expect(o.error.message).toBe('Workspace code failed.');
			expect(o.error.cause).toMatchObject({ name: 'TypeError', at: 'guest.mjs:3' });
		})
	);

	it.live('fails a body that returns while a ctx call is pending, naming the line', () =>
		Effect.gen(function* () {
			const o = yield* runIn(
				automation(
					'async () => {\n  globalThis[Symbol.for("norbital.bolt.call")]("get", ["t", "x"], "at guest.mjs:3:1");\n  return 1;\n}'
				)
			);
			expect(failure(o)).toEqual({
				code: 'internal',
				message: 'unawaited: the body returned while a ctx call was pending at guest.mjs:3'
			});
		})
	);

	it.live('fails a body that awaits nothing a crossing can settle', () =>
		Effect.gen(function* () {
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { yield* ctx.query({ t: { where: { id: { eq: "x" } } } }); yield* Effect.never; }'
				)
			);
			expect(failure(o)).toMatchObject({
				code: 'stalled',
				message: expect.stringMatching(/^stalled/)
			});
			expect(o.kind === 'failed' && o.error.phase).toBe('guest');
			expect(o.kind === 'failed' && isTransient(o.error)).toBe(false);
		})
	);

	it.live('counts each call as a crossing, not each batch (rule 12)', () =>
		Effect.gen(function* () {
			const o = yield* runIn(
				automation(
					'function* (_, ctx) {\n  yield* Effect.all([ctx.query({ t: { where: { id: { eq: "a" } } } }), ctx.query({ t: { where: { id: { eq: "b" } } } })], { concurrency: "unbounded" });\n  yield* Effect.all([ctx.query({ t: { where: { id: { eq: "c" } } } }), ctx.query({ t: { where: { id: { eq: "d" } } } })], { concurrency: "unbounded" });\n}'
				),
				invocation(null, { crossings: 3 })
			);
			expect(failure(o)).toEqual({
				code: 'crossingBudget',
				message: 'the invocation made more than 3 crossings; the next was at guest.mjs:4'
			});
		})
	);

	it.live('charges no crossing for a journal hit (rules 12, 55)', () =>
		Effect.gen(function* () {
			const { bridge } = recorder(() => ({ ok: true, value: 1, journal: true }));
			const o = yield* runIn(
				automation(
					'function* (_, ctx) {\n  for (let i = 0; i < 50; i++)\n    yield* ctx.query({ t: { where: { id: { eq: "x" } } } });\n  return 1;\n}'
				),
				invocation(null, { crossings: 40 }),
				bridge
			);
			expect(ok(o)).toBe(1);
		})
	);

	it.live('names a missing body', () =>
		Effect.gen(function* () {
			expect(
				failure(yield* runIn(automation('1'), invocation(null, {}, 'automation', 'nope')))
			).toMatchObject({ code: 'missingBody' });
		})
	);

	it.live('stops the crossing past the budget and names its line (rule 12)', () =>
		Effect.gen(function* () {
			const o = yield* runIn(
				automation(
					'function* (_, ctx) {\n  for (let i = 0; i < 50; i++)\n    yield* ctx.query({ t: { where: { id: { eq: "x" } } } });\n}'
				),
				invocation(null, { crossings: 40 })
			);
			expect(failure(o)).toEqual({
				code: 'crossingBudget',
				message: 'the invocation made more than 40 crossings; the next was at guest.mjs:4'
			});
		})
	);

	it.live('refuses read bytes past the invocation budget (rule 72)', () =>
		Effect.gen(function* () {
			const { bridge } = recorder(() => ({ ok: true, value: 'x'.repeat(600) }));
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { yield* ctx.query({ t: { where: { id: { eq: "a" } } } }); yield* ctx.query({ t: { where: { id: { eq: "b" } } } }); }'
				),
				invocation(null, { readBytes: 1_000 }),
				bridge
			);
			expect(failure(o)).toMatchObject({ code: 'readBudgetExceeded' });
		})
	);

	it.live('refuses a crossing answer over the crossing limit (rule 9)', () =>
		Effect.gen(function* () {
			const size = LIMITS.crossingBytes + 200_000;
			const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
			const { bridge } = recorder(() => ({
				ok: true,
				value: 'x'.repeat(size)
			}));
			expect(
				failure(
					yield* runIn(
						automation(
							'function* (_, ctx) { return yield* ctx.query({ t: { where: { id: { eq: "a" } } } }); }'
						),
						invocation(),
						bridge
					)
				)
			).toEqual({
				code: 'tooLarge',
				message: `Could not read 't': too much data returned at once (${mb(size)} MB total, over the ${LIMITS.crossingBytes / 1024 / 1024} MB limit). Largest response: ${mb(size)} MB. At guest.mjs:2; page it with \`limit\` and the returned cursor, or \`select\` fewer fields.`
			});
		})
	);

	it.live(
		'reports the total when concurrent read answers together exceed the crossing limit (rule 9)',
		() =>
			Effect.gen(function* () {
				const each = 5 * 1024 * 1024;
				const total = each * 2;
				const { crossings, bridge } = recorder(() => ({
					ok: true,
					value: 'x'.repeat(each)
				}));
				const outcome = yield* runIn(
					automation(
						'function* (_, ctx) { return yield* Effect.all([ctx.query({ t: { where: { id: { eq: "a" } } } }), ctx.query({ t: { where: { id: { eq: "b" } } } })], { concurrency: "unbounded" }); }'
					),
					invocation(),
					bridge
				);
				expect(crossings.map((calls) => calls.length)).toEqual([2]);
				expect(failure(outcome)).toEqual({
					code: 'tooLarge',
					message: `Could not read 't': too much data returned at once (${(total / 1024 / 1024).toFixed(1)} MB total, over the ${LIMITS.crossingBytes / 1024 / 1024} MB limit). Largest response: ${(each / 1024 / 1024).toFixed(1)} MB. At guest.mjs:2; page it with \`limit\` and the returned cursor, or \`select\` fewer fields.`
				});
			})
	);

	it.live('stops a guest spinning past its CPU budget across awaits (rule 71)', () =>
		Effect.gen(function* () {
			const spin =
				'const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };';
			let metered = 0n;
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { for (let i = 0; i < 3; i++) { spin(150); yield* ctx.query({ t: { where: { id: { eq: "x" } } } }); } return "done"; }',
					spin
				),
				invocation(),
				recorder().bridge,
				{},
				undefined,
				hostIsolates({ cpuMs: 300, meter: (_session, nanos) => void (metered += nanos) })
			);
			expect(failure(o)).toMatchObject({ code: 'cpuBudget' });
			expect(metered).toBeGreaterThanOrEqual(300_000_000n);
		})
	);

	it.live('does not count I/O waits, and has no invocation wall clock (rule 71)', () =>
		Effect.gen(function* () {
			let metered = 0n;
			const { bridge } = recorder(() =>
				Effect.as(Effect.sleep('400 millis'), { ok: true, value: 1 })
			);
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { for (let i = 0; i < 3; i++) yield* ctx.query({ t: { where: { id: { eq: "x" } } } }); return "done"; }'
				),
				invocation(),
				bridge,
				{},
				undefined,
				hostIsolates({ cpuMs: 300, meter: (_session, nanos) => void (metered += nanos) })
			);
			expect(ok(o)).toBe('done');
			expect(metered).toBeLessThan(300_000_000n);
		})
	);

	it.live(
		'a read request crosses once as one read: every root and layer in one call, lowered from the request itself (rule 12)',
		() =>
			Effect.gen(function* () {
				const lowered: Json[] = [];
				const stub: GuestOptions['lowerRead'] = (member, args) => {
					lowered.push([member, ...args]);
					return {
						kind: 'get',
						model: 't',
						id: 'x',
						select: { fields: null, relations: {} }
					};
				};
				const answer = { t: { rows: [{ id: 'x' }], next: null }, u: { rows: [], next: null } };
				const { crossings, bridge } = recorder(() => ({ ok: true, value: answer }));
				const request = {
					t: { where: { id: { eq: 'x' } }, fields: ['id'] },
					't.lines': { limit: 5 },
					u: { limit: 1 }
				};
				const o = yield* runIn(
					automation(`function* (_, ctx) { return yield* ctx.query(${JSON.stringify(request)}); }`),
					invocation(null, { crossings: 1 }),
					bridge,
					{ lowerRead: stub }
				);
				expect(ok(o)).toEqual(answer);
				expect(crossings.map((c) => c.length)).toEqual([1]);
				expect(lowered).toEqual([['query', request]]);
			})
	);
	it.live('lowers act.many to one acts call: one crossing, one statement', () =>
		Effect.gen(function* () {
			const { crossings, bridge } = recorder((c) => ({
				ok: true,
				value:
					c._tag === 'acts'
						? {
								kind: 'committed',
								output: c.acts.map((a) =>
									a.callable._tag === 'Verb'
										? `${a.callable.model}.${a.callable.verb}`
										: 'unexpected'
								),
								records: []
							}
						: null
			}));
			const o = yield* runIn(
				automation(
					`function* (_, ctx) { return (yield* ctx.act.many([{ callable: 'a.create', input: { x: 1 } }, { callable: 'b.update', input: [] }])).output; }`
				),
				invocation(),
				bridge
			);
			expect(ok(o)).toEqual(['a.create', 'b.update']);
			expect(crossings).toEqual([
				[
					{
						_tag: 'acts',
						acts: [
							{ callable: { _tag: 'Verb', model: 'a', verb: 'create' }, input: { x: 1 } },
							{ callable: { _tag: 'Verb', model: 'b', verb: 'update' }, input: [] }
						]
					}
				]
			]);
		})
	);

	it.live(
		'a read request whose answer passes the crossing limit fails tooLarge, and a host refusal reaches the body (rule 9)',
		() =>
			Effect.gen(function* () {
				const { bridge } = recorder(() => ({
					ok: false,
					error: {
						kind: 'bolt',
						code: 'invalid',
						message: "'u.nope' is not a read layer u declares"
					}
				}));
				expect(
					ok(
						yield* runIn(
							automation(
								`function* (_, ctx) { return yield* Effect.catchCause(ctx.query({ t: {}, 'u.nope': {} }), (cause) => { const e = Cause.squash(cause); return Effect.succeed(e.code + ' ' + e.message); }); }`
							),
							invocation(),
							bridge
						)
					)
				).toBe("invalid 'u.nope' is not a read layer u declares");
				const big = recorder(() => ({ ok: true, value: 'x'.repeat(LIMITS.crossingBytes + 1) }));
				expect(
					failure(
						yield* runIn(
							automation(`function* (_, ctx) { return yield* ctx.query({ t: {}, u: {} }); }`),
							invocation(),
							big.bridge
						)
					)
				).toMatchObject({ code: 'tooLarge' });
			})
	);

	it.live('bounds each crossing by the per-call wall, as a typed timeout (X-28)', () =>
		Effect.gen(function* () {
			const { bridge } = recorder(() => Effect.never);
			const o = yield* runIn(
				automation(
					'function* (_, ctx) { return yield* Effect.catchTag(Effect.as(ctx.web.read("https://a.test"), "ok"), "FacilityFailure", (e) => Effect.succeed(e.kind)); }'
				),
				invocation(),
				bridge,
				{ callWallMs: 50 }
			);
			expect(ok(o)).toBe('timeout');
		})
	);

	it.live(
		'lets a transcription outlast the per-call wall and the CPU budget: the guest only awaits it',
		() =>
			Effect.gen(function* () {
				const { crossings, bridge } = recorder((c) =>
					Effect.as(Effect.sleep('200 millis'), {
						ok: true,
						value:
							c._tag === 'ai.transcribe' ? 'transcribe' : c._tag === 'ai.speak' ? 'speak' : null
					})
				);
				const o = yield* runIn(
					automation(
						'function* (_, ctx) { return [yield* ctx.ai.transcribe({ id: "f" }), yield* ctx.ai.speak("hi", { for: "a" })]; }'
					),
					invocation(),
					bridge,
					{ callWallMs: 50 },
					undefined,
					hostIsolates({ cpuMs: 100 })
				);
				expect(ok(o)).toEqual(['transcribe', 'speak']);
				expect(crossings.flat()).toMatchObject([{ _tag: 'ai.transcribe' }, { _tag: 'ai.speak' }]);
			})
	);

	it.live('gives an inference no per-call wall: its own stall window ends it', () =>
		Effect.gen(function* () {
			const { bridge } = recorder(() =>
				Effect.as(Effect.sleep('200 millis'), { ok: true, value: 'found' })
			);
			const o = yield* runIn(
				automation('function* (_, ctx) { return yield* ctx.ai.sys_2.infer({ prompt: "q" }); }'),
				invocation(),
				bridge,
				{ callWallMs: 50 }
			);
			expect(ok(o)).toBe('found');
		})
	);

	it.live(
		'parks a long wait: its isolate goes, and a fresh one replays the body from its start (compute model §3)',
		() =>
			Effect.gen(function* () {
				const sessions = new Set<string>();
				const counted = Layer.unwrap(
					Effect.map(guestIsolates({}), (port) =>
						GuestIsolates.fromAbi({
							...port,
							open: (source, options, signal) =>
								port.open(source, options, signal).then((session) => {
									sessions.add(session);
									return session;
								}),
							close: (session) => {
								sessions.delete(session);
								return port.close(session);
							}
						})
					)
				);
				let answered: CrossAnswer | undefined,
					whileWaiting = -1,
					resumes = 0;
				// the inference answers once, after 200 ms; a replay finds it journalled
				const { crossings, bridge } = recorder((call) =>
					call._tag !== 'ai.sys_2.infer'
						? { ok: true, value: 1 }
						: answered !== undefined
							? { ...answered, journal: true }
							: Effect.gen(function* () {
									yield* Effect.sleep('150 millis');
									whileWaiting = sessions.size;
									yield* Effect.sleep('50 millis');
									answered = { ok: true, value: 'found' };
									return answered;
								})
				);
				const o = yield* runIn(
					automation(
						'function* (_, ctx) { const a = yield* ctx.query({ t: { where: { id: { eq: "a" } } } }); const r = yield* ctx.ai.sys_2.infer({ prompt: "q" }); return [a, r]; }'
					),
					invocation(null, { crossings: LIMITS.crossings.automation }),
					bridge,
					{},
					undefined,
					counted
				).pipe(
					Effect.provideService(GuestParking, {
						afterMs: 50,
						resume: Effect.sync(() => {
							resumes++;
						})
					})
				);
				expect(ok(o)).toEqual([1, 'found']);
				expect(whileWaiting).toBe(0);
				expect(resumes).toBe(1);
				expect(crossings.flat().map((call) => call._tag)).toEqual([
					'read',
					'ai.sys_2.infer',
					'read',
					'ai.sys_2.infer'
				]);
			})
	);

	it.live(
		'stops a guest past 256 MiB',
		() =>
			Effect.gen(function* () {
				const o = yield* runIn(
					automation(
						'async () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); }'
					)
				);
				expect(failure(o)).toMatchObject({ code: 'memory' });
			}),
		20_000
	);
});

describe('next guest globals (rule 6)', () => {
	// tsc holds this literal to exactly the keys of IsolateGlobals; the test holds the isolate to exactly this literal.
	const surface = {
		console: true,
		URL: true,
		URLSearchParams: true,
		TextEncoder: true,
		TextDecoder: true,
		crypto: true,
		structuredClone: true,
		atob: true,
		btoa: true,
		queueMicrotask: true,
		setTimeout: true,
		clearTimeout: true,
		AbortController: true,
		AbortSignal: true,
		fileRef: true
	} as const satisfies Record<keyof IsolateGlobals, true>;
	const guest = (body: string) => Effect.map(runIn(automation(`async () => { ${body} }`)), ok);

	it.live('installs exactly the IsolateGlobals surface, and nothing of the host', () =>
		Effect.gen(function* () {
			const bare = new ivm.Isolate({ memoryLimit: 32 });
			const bareContext = yield* Effect.promise(() => bare.createContext());
			const names = new Set(
				yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
					yield* Effect.promise(() =>
						bareContext.eval('Object.getOwnPropertyNames(globalThis)', { copy: true })
					)
				)
			);
			bare.dispose();
			const seen = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
				yield* guest('return Object.getOwnPropertyNames(globalThis);')
			);
			expect(seen.filter((n) => !names.has(n) || n === 'console').sort()).toEqual(
				Object.keys(surface).sort()
			);
			expect(
				yield* guest(
					'return [Object.keys(crypto).sort(), Object.keys(crypto.subtle), typeof setInterval, typeof fetch, typeof Buffer, typeof process];'
				)
			).toEqual([
				['getRandomValues', 'randomUUID', 'subtle'],
				['digest'],
				'undefined',
				'undefined',
				'undefined',
				'undefined'
			]);
			expect(PRELUDE).not.toContain('`');
		})
	);

	it.live('fileRef brands stored-file metadata for guest writes', () =>
		Effect.gen(function* () {
			expect(
				yield* guest(`return fileRef({ id: 'f1', name: 'a.pdf', mime: 'application/pdf' });`)
			).toEqual({
				id: 'f1',
				name: 'a.pdf',
				mime: 'application/pdf'
			});
		})
	);

	it.live('keeps a URL query written through searchParams in href', () =>
		Effect.gen(function* () {
			const host = new URL('/v1/events?a=1', 'https://api.test/base/');
			host.searchParams.set('pageToken', "t 2!'~");
			host.searchParams.append('a', '3');
			expect(
				yield* guest(`const u = new URL('/v1/events?a=1', 'https://api.test/base/'); u.searchParams.set('pageToken', "t 2!'~"); u.searchParams.append('a', '3');
			return [u.href, u.search, u.origin, URL.canParse('nope')];`)
			).toEqual([host.href, host.search, host.origin, false]);
		})
	);

	it.live('encodes and decodes text, base64 and clones as the platform does', () =>
		Effect.gen(function* () {
			const text = 'aé中\u{1F600}';
			expect(
				yield* guest(`const t = ${JSON.stringify(text)}; const bytes = new TextEncoder().encode(t);
			return [Array.from(bytes), new TextDecoder().decode(bytes), new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0x62])),
				(() => { try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])); return 'no'; } catch (e) { return e.name; } })(),
				btoa('hi?'), atob(' aGk/ '), (() => { const a = { d: new Date(5), m: new Map([[1, new Set([2])]]) }; a.self = a;
					const b = structuredClone(a); return [b.self === b, b.d.getTime(), b.m.get(1).has(2), b !== a]; })()];`)
			).toEqual([
				Array.from(Buffer.from(text)),
				text,
				'a�b',
				'TypeError',
				Buffer.from('hi?').toString('base64'),
				'hi?',
				[true, 5, true, true]
			]);
		})
	);

	it.live(
		'digests with the host byte for byte and draws random values from the invocation seed',
		() =>
			Effect.gen(function* () {
				const out = yield* Schema.decodeUnknownEffect(
					Schema.Tuple([Schema.Array(Schema.Number), Schema.String, Schema.Array(Schema.Number)])
				)(
					yield* guest(`const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
			return [Array.from(new Uint8Array(d)), crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];`)
				);
				expect(out[0]).toEqual(Array.from(createHash('sha256').update('abc').digest()));
				expect(out[1]).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
				expect(
					yield* guest(`await crypto.subtle.digest('SHA-256', new Uint8Array(0));
			return [Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')))), crypto.randomUUID(), Array.from(crypto.getRandomValues(new Uint8Array(4)))];`)
				).toEqual(out);
			})
	);

	it.live(
		'runs queueMicrotask and zero-delay timers as tasks within the invocation, refusing any other delay (rule 6)',
		() =>
			Effect.gen(function* () {
				expect(
					yield* guest(`const log = [];
			setTimeout((x) => log.push('t1' + x), 0, '!'); const gone = setTimeout(() => log.push('cleared')); clearTimeout(gone);
			queueMicrotask(() => log.push('m')); Promise.resolve().then(() => setTimeout(() => log.push('t2')));
			await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r));
			const refused = (() => { try { setTimeout(() => {}, 5); return 'no'; } catch (e) { return [e.name, e.code]; } })();
			return [log, refused];`)
				).toEqual([
					['m', 't1!', 't2'],
					['BoltError', 'timerDelay']
				]);
				const o = yield* runIn(
					automation(
						'async () => { clearTimeout(setTimeout(() => {}, 0)); await new Promise(() => {}); }'
					)
				);
				expect(failure(o)).toMatchObject({ code: 'stalled' });
			})
	);

	it.live(
		'decodes windows-1252 under its WHATWG labels, and still refuses other encodings (L-COL-097)',
		() =>
			Effect.gen(function* () {
				const bytes = [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x20, 0x93, 0x71, 0x94, 0x81];
				expect(
					yield* guest(`const b = new Uint8Array(${JSON.stringify(bytes)});
			return [new TextDecoder('latin1').decode(b), new TextDecoder('Windows-1252').encoding, new TextDecoder('ascii').decode(b),
				(() => { try { new TextDecoder('shift_jis'); return 'no'; } catch (e) { return e.name; } })()];`)
				).toEqual([
					new TextDecoder('latin1').decode(new Uint8Array(bytes)),
					'windows-1252',
					new TextDecoder('latin1').decode(new Uint8Array(bytes)),
					'RangeError'
				]);
			})
	);

	it.live('aborts through AbortController as the platform does (L-COL-097)', () =>
		Effect.gen(function* () {
			expect(
				yield* guest(`const c = new AbortController(), log = [];
			c.signal.addEventListener('abort', (e) => log.push(e.type), { once: true });
			c.signal.onabort = () => log.push('on');
			const before = c.signal.aborted;
			c.abort('why'); c.abort('again');
			const any = AbortSignal.any([new AbortController().signal, AbortSignal.abort()]);
			const thrown = (() => { try { c.signal.throwIfAborted(); return 'no'; } catch (e) { return e; } })();
			return [before, c.signal.aborted, c.signal.reason, log, thrown, any.aborted, any.reason.name, typeof AbortSignal.timeout,
				(() => { try { new AbortSignal(); return 'no'; } catch (e) { return e.name; } })()];`)
			).toEqual([
				false,
				true,
				'why',
				['abort', 'on'],
				'why',
				true,
				'AbortError',
				'undefined',
				'TypeError'
			]);
		})
	);

	it.live('reads a `?bytes` server asset by sha256, and names a missing one (L-COL-099)', () =>
		Effect.gen(function* () {
			const bytes = new Uint8Array([0, 97, 255, 10]),
				sha = createHash('sha256').update(bytes).digest('hex');
			const source = automation(
				`async () => Array.from(globalThis[Symbol.for('norbital.bolt.asset')](${JSON.stringify(sha)}))`
			);
			const run = (assets?: Record<string, Uint8Array>) =>
				runProgram({ source, ...(assets === undefined ? {} : { assets }) });
			expect(ok(yield* run({ [sha]: bytes }))).toEqual([0, 97, 255, 10]);
			expect(failure(yield* run())).toMatchObject({
				code: 'guestError',
				message: `the artifact has no server asset ${sha}`
			});
		})
	);

	it.live('ignores tenant snapshot properties and evaluates source in a fresh isolated heap', () =>
		Effect.gen(function* () {
			const source = automation(
				`function* (_, ctx) { return [++globalThis.count, crypto.randomUUID(), yield* ctx.query({ t: { where: { id: { eq: 'x' } } } })]; }`,
				'globalThis.count = 0;'
			);
			const built = yield* sourceProgram(source);
			const run = (guest: GuestProgram) => runProgram(guest);
			const evaluated = ok(yield* run(built));
			const untrusted = {
				...built,
				get snapshot(): Uint8Array {
					throw new Error('tenant snapshot bytes must never reach native code');
				}
			};
			expect(ok(yield* run(untrusted))).toEqual(evaluated);
			expect(ok(yield* run(untrusted))).toEqual(evaluated);
			const logs: string[] = [];
			expect(
				ok(
					yield* runProgram(
						{
							source: `console.log('loaded'); const formatter = new Intl.DateTimeFormat('en');
export default { automation: { a: { body: () => formatter.resolvedOptions().locale } } };`
						},
						invocation(),
						recorder().bridge,
						{ console: (_level, line) => logs.push(line) }
					)
				)
			).toBe('en');
			expect(logs).toEqual(['loaded']);
		})
	);

	it.live(
		'evaluates minified compiler output with legal comments and the original source map',
		() =>
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), 'norbital-source-'));
				try {
					mkdirSync(join(root, 'src/automation'), { recursive: true });
					writeFileSync(
						join(root, 'src/+workspace.ts'),
						`export default { tz: 'UTC', locale: 'en' };`
					);
					writeFileSync(
						join(root, 'src/automation/+a.automation.ts'),
						`/*! @license source evaluation edge case */
import { automation } from '@norbital-ai/bolt';
const description = 'Source evaluation';
function* sourceBody(input) {
 class SourceMarker {}
 if (input.fail) throw new Error('mapped source failure');
 return { value: input.value, bodyName: sourceBody.name, className: SourceMarker.name };
}
export default automation('a', { description, on: { cron: '0 0 * * *' }, run: sourceBody });`
					);
					const built = yield* check(root).pipe(Effect.provide(node));
					expect(built.errors).toEqual([]);
					const program = built.guest;
					if (program === undefined) throw new Error('the compiler produced no guest');
					expect(program.source).toMatch(/;export\{/);
					expect(program.source).toContain('@license source evaluation edge case');
					const run = (input: Json = { value: 42 }) => runProgram(program, invocation(input));
					const evaluated = ok(yield* run());
					expect(evaluated).toEqual({
						value: 42,
						bodyName: 'sourceBody',
						className: 'SourceMarker'
					});
					expect(ok(yield* run())).toEqual(evaluated);
					const evaluatedFailure = yield* run({ fail: true });
					const repeatedFailure = yield* run({ fail: true });
					expect(repeatedFailure.kind).toBe('failed');
					if (repeatedFailure.kind !== 'failed' || evaluatedFailure.kind !== 'failed')
						throw new Error('Expected mapped errors');
					expect(evaluatedFailure.error.cause).toMatchObject({
						name: 'Error',
						message: 'mapped source failure',
						at: expect.stringContaining('src/automation/+a.automation.ts:6')
					});
					expect(repeatedFailure.error.cause).toMatchObject({
						name: 'Error',
						message: 'mapped source failure',
						at: expect.stringContaining('src/automation/+a.automation.ts:6')
					});
					const repeated = yield* check(root).pipe(Effect.provide(node));
					expect(repeated.errors).toEqual([]);
					expect(repeated.guest?.source).toBe(program.source);
					writeFileSync(join(root, 'blob.bin'), 'bytes\u0000!');
					writeFileSync(
						join(root, 'src/+workspace.ts'),
						`import blob from '../blob.bin?bytes'; export default { tz: 'UTC', locale: blob.length === 7 ? 'en' : 'invalid' };`
					);
					const withAsset = yield* check(root).pipe(Effect.provide(node));
					expect(withAsset.errors).toEqual([]);
					if (withAsset.guest?.assets === undefined)
						throw new Error('the compiler omitted the asset');
					expect(Object.keys(withAsset.guest.assets)).toHaveLength(1);
					expect(ok(yield* runProgram(withAsset.guest, invocation({ value: 42 })))).toEqual(
						evaluated
					);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			})
	);

	it.live('idle source-initialized isolates stay under 100 MiB heap (G3 guest bound)', () =>
		Effect.gen(function* () {
			const source = `const d = { automation: { a: { body: async () => 1 } } };\nexport { d as default };\n`;
			const isolates = Array.from(
				{ length: 10 },
				() => new ivm.Isolate({ memoryLimit: LIMITS.guestMemoryMiB })
			);
			try {
				expect(LIMITS.guestMemoryMiB).toBe(256);
				for (const isolate of isolates) {
					const context = yield* Effect.promise(() => isolate.createContext());
					const hooks = yield* Effect.promise(() =>
						context.evalClosure(
							PRELUDE,
							[() => {}, () => new Uint8Array(), () => '', () => new Uint8Array()],
							{ result: { reference: true } }
						)
					);
					const module = yield* Effect.promise(() => isolate.compileModule(source));
					yield* Effect.promise(() =>
						module.instantiate(context, (specifier) => {
							throw new Error(`unexpected import ${specifier}`);
						})
					);
					yield* Effect.promise(() => module.evaluate());
					yield* Effect.promise(() =>
						context.global.set('__boltGuest', module.namespace.derefInto())
					);
					const heap = isolate.getHeapStatisticsSync();
					expect(heap.used_heap_size + heap.externally_allocated_size).toBeLessThan(
						100 * 1024 * 1024
					);
					hooks.release();
				}
			} finally {
				for (const isolate of isolates) isolate.dispose();
			}
		})
	);

	it.live('labels guest console lines for the host', () =>
		Effect.gen(function* () {
			const lines: string[] = [];
			yield* runIn(
				automation('async () => { console.warn("careful", { n: 1 }); }'),
				invocation(),
				undefined,
				{ console: (level, line, inv) => lines.push(`${inv.id} ${level} ${line}`) }
			);
			expect(lines).toEqual(['inv-1 warn careful {"n":1}']);
		})
	);
});
