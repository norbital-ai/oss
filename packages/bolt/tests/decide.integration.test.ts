// `ctx.ai.sys_1.decide` (P36, P37; §11.2 G12 (11)) through the engine entry and a built guest: a scripted `ai.sys_1`
// (no vendor) answers the Desk's routing questions; the answers come back typed, a FileRef in the state is refused
// `invalid` before any call (text only, P37 (3)), and every call is one `decision.made` (`use: 'author'`). Failures are the
// facility's typed errors.
import { afterAll, describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from 'effect';
import { Port } from '../src/engine/port.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import { Ai } from '../src/engine/ports.ts';
import { program } from '../src/test/guest.ts';
import {
	actReply,
	json,
	qReply,
	routeFixture,
	type FixtureRoute
} from './support/route-fixture.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
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
	exposures: {
		tickets: {
			read: { tickets: { fields: 'all' } },
			create: { columns: { tickets: ['subject', 'photo', 'ref_id'] } },
			update: { columns: { tickets: ['queue', 'urgent', 'level', 'note'] } }
		},
		secret_docs: {
			read: { secret_docs: { fields: 'all' } },
			create: { columns: { secret_docs: ['title', 'doc'] } }
		}
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
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guest = program(`import { Effect, Result } from 'effect';
const questions = {
	queue: { type: 'choice', instructions: 'Which queue?', criteria: { billing: 'money', technical: 'broken', accounts: 'login' } },
	blocked: { type: 'noul', instructions: 'Is the customer blocked?', criteria: { true: 'cannot work', false: 'can work' } },
	urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] } };
export default { automation: { route: { body: function* (input, ctx) {
	for (const id of input.ids) {
		const t = (yield* ctx.query({ tickets: { where: { id: { eq: id } }, fields: ['subject', 'photo', 'ref_id'] } })).tickets.rows[0];
		const photo = t.ref_id ? { id: t.ref_id, name: 'x.png', mime: 'image/png' } : t.photo;
		const r = yield* Effect.result(ctx.ai.sys_1.decide({ state: { subject: t.subject, ...(photo ? { photo } : {}) }, questions }));
		if (Result.isFailure(r)) { yield* ctx.act('tickets.update', [{ target: id, set: { note: r.failure._tag === 'Unavailable' ? 'unavailable' : r.failure.kind } }]); continue; }
		const result = r.success;
		yield* ctx.act('tickets.update', [{ target: id, set: { queue: result.answers.queue.choice, urgent: result.answers.blocked.noul > 0.5,
			level: result.answers.urgency.level, note: 'cost ' + result.costUsd } }]);
	}
} } } };`);

type Mode = 'ok' | 'tooLarge' | 'unsupported' | 'offlist' | 'down' | 'absent';
type Fake = { mode: Mode; calls: System1Request[] };
const aiPort = (fake: Fake): Ai['Service'] => ({
	ask: (request) =>
		Effect.gen(function* () {
			// the host binds no AI facility: its answer is the kit's own for an absent member
			if (fake.mode === 'absent') return yield* Port.unavailable('ai');
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
// One workspace for the file: each case starts from a fresh fake and reads only its own tickets.
const fake: Fake = { mode: 'ok', calls: [] };
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const shared = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					guest: yield* guest,
					ports: Layer.succeed(Ai, aiPort(fake))
				})
			);
			return { t: Context.get(context, TestWorkspace), route: yield* routeFixture(context), fake };
		}).pipe(Scope.provide(fileScope))
	)
);
const open = (mode: Mode = 'ok') =>
	Effect.map(shared, (fixture) => {
		fake.mode = mode;
		fake.calls = [];
		return fixture;
	});
const ok = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	return outcome;
};
const desk = (t: Kit) => t.as(t.member(['desk'])).authority;
const ticket = (t: Kit, route: FixtureRoute, set: Record<string, Json>) =>
	actReply(route, desk(t), {
		callable: 'tickets.create',
		input: [{ subject: 'Charged twice', ...set }],
		issuedAt: t.clock.now()
	}).pipe(
		Effect.map((reply) => {
			const row = ok(reply.outcome).records[0];
			if (row === undefined) throw new Error('Missing ticket');
			return row.id;
		})
	);
const Tickets = Schema.Struct({ tickets: Schema.Struct({ rows: Schema.Array(Schema.Json) }) });
const get = (t: Kit, route: FixtureRoute, id: string) =>
	qReply(route, desk(t), {
		reads: [{ m: 'query', a: [{ tickets: { where: { id: { eq: id } } } }] }]
	}).pipe(
		Effect.flatMap((reply) => Schema.decodeUnknownEffect(Tickets)(reply.answers[0])),
		Effect.map((answer) => answer.tickets.rows[0] ?? null)
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
	it.live('answers typed from the literals, one event per call; a refusal is its typed error', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, fake } = yield* open();
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
				// refusals and failures are the typed error `.try` returns; no system2 call
				for (const [mode, kind] of [
					['tooLarge', 'tooLarge'],
					['offlist', 'invalid']
				] as const) {
					fake.mode = mode;
					const failed = yield* ticket(t, route, {});
					yield* t.runDue();
					expect(yield* get(t, route, failed)).toMatchObject({ note: kind });
				}
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
							input: [{ title: 'Payroll', doc }],
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
				const { t, route } = yield* open('absent');
				const id = yield* ticket(t, route, {});
				yield* t.runDue();
				expect(yield* get(t, route, id)).toMatchObject({ note: 'unavailable' });
			})
		)
	);
});

