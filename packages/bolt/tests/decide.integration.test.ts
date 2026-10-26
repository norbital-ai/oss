// `ctx.ai.sys_1.decide` (P36, P37; §11.2 G12 (11)) through the engine entry and a built guest: a scripted `ai.sys_1`
// (no vendor) answers the Desk's routing questions; the answers come back typed, a FileRef in the state is refused
// `invalid` before any call (text only, P37 (3)), every call is one `decision.made` (`use: 'author'`) and one meter report, and a
// crashed run replays the journalled answers with no second call. Failures are the facility's typed errors.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import { Ai, Metering } from '../src/engine/ports.ts';
import { program } from './support/guest-fixture.ts';
import {
	actReply,
	json,
	qReply,
	routeFixture,
	type FixtureRoute
} from './support/route-fixture.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { ask, type System1Request } from '../src/engine/decisions/index.ts';
import { TestWorkspace, type Kit } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		tickets: {
			description: 'A ticket',
			label: 'subject',
			fields: {
				subject: { kind: 'text' },
				photo: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true },
				ref_id: { kind: 'text', optional: true },
				queue: { kind: 'enum', values: ['billing', 'technical', 'accounts'], optional: true },
				urgent: { kind: 'bool', optional: true },
				level: { kind: 'text', optional: true },
				note: { kind: 'text', optional: true }
			}
		},
		secret_docs: {
			description: 'Not for the desk',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				doc: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true }
			}
		}
	},
	relationships: {},
	collections: {
		tickets: {
			read: { fields: 'all' },
			create: { input: { columns: ['subject', 'photo', 'ref_id'] } },
			update: { input: { columns: ['queue', 'urgent', 'level', 'note'] } }
		},
		secret_docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'doc'] } } }
	},
	policies: {
		desk: { description: 'Desk', grants: { tickets: { read: true, create: true, update: true } } }
	},
	automations: {
		route: { description: 'Route a new ticket', on: { created: 'tickets' }, runAs: ['desk'] }
	},
	integrations: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;
const guest = program(`import { Effect, Result } from 'effect';
const questions = {
	queue: { type: 'choice', instructions: 'Which queue?', criteria: { billing: 'money', technical: 'broken', accounts: 'login' } },
	blocked: { type: 'noul', instructions: 'Is the customer blocked?', criteria: { true: 'cannot work', false: 'can work' } },
	urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] } };
export default { automation: { route: { body: function* (input, ctx) {
	for (const id of input.ids) {
		const t = yield* ctx.query('tickets', { id, select: { subject: true, photo: true, ref_id: true } });
		const photo = t.ref_id ? { id: t.ref_id, name: 'x.png', mime: 'image/png' } : t.photo;
		const r = yield* Effect.result(ctx.ai.sys_1.decide({ state: { subject: t.subject, ...(photo ? { photo } : {}) }, questions }));
		if (Result.isFailure(r)) { yield* ctx.act('tickets.update', { target: id, set: { note: r.failure._tag === 'Unavailable' ? 'unavailable' : r.failure.kind } }); continue; }
		const result = r.success;
		yield* ctx.act('tickets.update', { target: id, set: { queue: result.answers.queue.choice, urgent: result.answers.blocked.noul > 0.5,
			level: result.answers.urgency.level, note: 'cost ' + result.costUsd } });
	}
} } } };`);

type Mode = 'ok' | 'tooLarge' | 'unsupported' | 'offlist' | 'down';
type Fake = { mode: Mode; calls: System1Request[] };
const aiPort = (fake: Fake): Ai['Service'] => ({
	ask: (request) =>
		Effect.gen(function* () {
			fake.calls.push(request);
			if (fake.mode === 'tooLarge' || fake.mode === 'unsupported')
				return yield* Effect.fail(
					new FacilityFailure({ kind: fake.mode, message: 'refused by the provider' })
				);
			if (fake.mode === 'down')
				return yield* Effect.fail(
					new FacilityFailure({ kind: 'upstream', message: 'provider down' })
				);
			return {
				costUsd: 0.0004,
				provider: 'scripted',
				answers: {
					queue: {
						type: 'choice',
						choice: fake.mode === 'offlist' ? 'sales' : 'billing',
						confidence: 0.1,
						probabilities: { billing: 0.1, technical: 0.05, accounts: 0.05 }
					},
					blocked: { type: 'noul', noul: 0.8 },
					urgency: {
						type: 'score',
						score: 1.99,
						level: 2,
						confidence: 0.9,
						probabilities: { 0: 0.01, 1: 0, 2: 0.99 },
						legend: { 0: 'low', 1: 'medium', 2: 'high' }
					}
				}
			};
		}),
	maxChoices: undefined,
	models: ['default'],
	catalog: Effect.die(new Error('System 2 is never asked')),
	infer: () => Stream.die(new Error('System 2 is never asked')),
	embed: () => Effect.die(new Error('Embeddings are never asked'))
});
const open = (withAi = true) =>
	Effect.gen(function* () {
		const fake: Fake = { mode: 'ok', calls: [] },
			metered: string[] = [];
		const metering = Layer.succeed(Metering, {
			record: (meter, quantity, key) =>
				Effect.sync(() => {
					metered.push(`${meter}:${quantity}:${key.split(':')[0]}`);
				})
		});
		const ports = withAi ? Layer.merge(metering, Layer.succeed(Ai, aiPort(fake))) : metering;
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, guest: yield* guest, ports })
		);
		return {
			t: Context.get(context, TestWorkspace),
			route: yield* routeFixture(context),
			fake,
			metered
		};
	});
const ok = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	return outcome;
};
const desk = (t: Kit) => t.as(t.member(['desk'])).authority;
const ticket = (t: Kit, route: FixtureRoute, set: Record<string, Json>) =>
	actReply(route, desk(t), {
		callable: 'tickets.create',
		input: { subject: 'Charged twice', ...set },
		issuedAt: t.clock.now()
	}).pipe(
		Effect.map((reply) => {
			const row = ok(reply.outcome).records[0];
			if (row === undefined) throw new Error('Missing ticket');
			return row.id;
		})
	);
const get = (t: Kit, route: FixtureRoute, id: string) =>
	qReply(route, desk(t), { reads: [{ m: 'query', a: ['tickets', { id: id }] }] }).pipe(
		Effect.map((reply) => reply.answers[0])
	);
const events = (t: Kit) =>
	Effect.sync(() =>
		t.fakes.logs.filter((r) => r.event === 'decision.made').map((r) => r.attributes)
	);
const upload = (
	route: FixtureRoute,
	authority: ReturnType<typeof desk>,
	field: string,
	bytes: Uint8Array<ArrayBuffer>,
	name: string
) =>
	route
		.handle(
			authority,
			new Request(`http://cell/__bolt/files/${field}`, {
				method: 'PUT',
				headers: {
					'content-type': 'image/png',
					'Idempotency-Key': crypto.randomUUID(),
					'content-disposition': `attachment; filename*=UTF-8''${name}`
				},
				body: bytes
			})
		)
		.pipe(
			Effect.flatMap(json),
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
				)
			)
		);

describe('ctx.ai.sys_1.decide (P36, P37)', () => {
	it.live('answers typed from the literals; one event and one meter report', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, fake, metered } = yield* open();
				const id = yield* ticket(t, route, {});
				yield* t.runDue();
				// A low-confidence choice is used as given; a score's native level indexes its legend.
				expect(yield* get(t, route, id)).toMatchObject({
					queue: 'billing',
					urgent: true,
					level: 'high',
					note: 'cost 0.0004'
				});
				const sent = present(fake.calls[0]);
				expect(Object.values(sent.questions).map((q) => q.type)).toEqual([
					'choice',
					'noul',
					'score'
				]);
				expect(sent.state).toEqual({ subject: 'Charged twice' });
				expect(yield* events(t)).toMatchObject([
					{ use: 'author', system: 1, automation: 'route', costUsd: 0.0004 }
				]);
				expect(metered).toEqual(['ai:0.0004:decision']);
			})
		)
	);

	it.live('a crashed run replays the journalled answers: no second call, no second report', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, fake, metered } = yield* open();
				const id = yield* ticket(t, route, {});
				const [runs] = yield* t.db.read([
					{ text: `SELECT id FROM sys_run WHERE automation = 'route'`, params: [] }
				]);
				yield* t.crash(String(present(present(runs).rows[0])['id']));
				yield* t.runDue();
				expect(fake.calls).toHaveLength(1);
				expect(metered).toHaveLength(1);
				expect(yield* get(t, route, id)).toMatchObject({ queue: 'billing' });
			})
		)
	);

	it.live('refusals and failures are the typed error `.try` returns; no system2 call', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, fake, metered } = yield* open();
				for (const [mode, kind] of [
					['tooLarge', 'tooLarge'],
					['unsupported', 'unsupported'],
					['offlist', 'invalid'],
					['down', 'upstream']
				] as const) {
					fake.mode = mode;
					const id = yield* ticket(t, route, {});
					yield* t.runDue();
					expect(yield* get(t, route, id)).toMatchObject({ note: kind });
				}
				expect(metered).toEqual([]); // a failed call has no cost to report
			})
		)
	);

	it.live(
		'a FileRef in the state is refused invalid before the call, readable or not (P37 (3))',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route, fake } = yield* open();
					const photo = yield* upload(
						route,
						desk(t),
						'tickets.photo',
						new Uint8Array([7, 7, 7]),
						'p.png'
					);
					const mine = yield* ticket(t, route, { photo });
					yield* t.runDue();
					expect(yield* get(t, route, mine)).toMatchObject({ note: 'invalid' });
					const doc = yield* upload(
						route,
						t.as(t.admin).authority,
						'secret_docs.doc',
						new Uint8Array([1]),
						's.png'
					);
					ok(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'secret_docs.create',
							input: { title: 'Payroll', doc },
							issuedAt: t.clock.now()
						})).outcome
					);
					const id = yield* ticket(t, route, { ref_id: doc.id });
					yield* t.runDue();
					expect(yield* get(t, route, id)).toMatchObject({ note: 'invalid' });
					expect(fake.calls).toHaveLength(0);
				})
			)
	);

	it.live('with no AI facility decide is Unavailable', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route } = yield* open(false);
				const id = yield* ticket(t, route, {});
				yield* t.runDue();
				expect(yield* get(t, route, id)).toMatchObject({ note: 'unavailable' });
			})
		)
	);
});

it.live(
	'Bolt caps no question or option: a 40-question decide with a 100-option choice reaches sys_1 whole',
	() =>
		Effect.gen(function* () {
			const seen: System1Request[] = [];
			const port: Ai['Service'] = {
				...aiPort({ mode: 'ok', calls: [] }),
				ask: (request) =>
					Effect.gen(function* () {
						seen.push(request);
						return yield* Effect.fail(
							new FacilityFailure({ kind: 'tooLarge', message: 'context limit' })
						);
					})
			};
			const criteria = Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [`o${i}`, `option ${i}`])
			);
			const questions = Object.fromEntries(
				Array.from({ length: 40 }, (_, i) => [
					`q${i}`,
					{ type: 'choice' as const, instructions: 'Which?', criteria }
				])
			);
			expect(yield* ask(port, { state: { text: 'x' }, questions }).pipe(Effect.flip)).toMatchObject(
				{ kind: 'tooLarge' }
			);
			const request = seen[0];
			if (request === undefined) throw new Error('Missing decision request');
			expect(Object.keys(request.questions)).toHaveLength(40);
			const last = request.questions['q39'];
			if (last?.type !== 'choice') throw new Error('Missing choice question');
			expect(Object.keys(last.criteria)).toHaveLength(100);
		})
);
