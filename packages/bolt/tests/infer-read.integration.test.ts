// `ctx.ai.sys_2.infer({ tools: ['read'] })` in an automation: the model reads workspace records as the run's `runAs`
// policies over several turns (the agent's `query` tool: grants, masks, bounded pages), then edits and submits; a
// model outside the policies is refused, a masked field never reaches the model, `steps` still caps the tool turns,
// and a `runAs: 'trigger'` run cannot offer `read`.
import { FacilityFailure } from '../src/decl/errors.ts';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from 'effect';
import { afterAll } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { uuidv7 } from '../src/protocol/wire.ts';
import { Ai } from '../src/engine/ports.ts';
import { TestWorkspace, respondSystem1, type Kit } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		invoices: {
			description: 'A supplier invoice',
			label: 'number',
			fields: {
				number: { kind: 'text' },
				supplier: { kind: 'text' },
				amount: { kind: 'int' },
				note: { kind: 'text', optional: true }
			}
		},
		purchase_orders: {
			description: 'A purchase order',
			label: 'number',
			fields: {
				number: { kind: 'text' },
				supplier: { kind: 'text' },
				amount: { kind: 'int' },
				margin: { kind: 'int' }
			}
		},
		ledgers: {
			description: 'Not for matching',
			label: 'title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		invoices: {
			read: { invoices: { fields: 'all' } },
			create: { columns: { invoices: ['number', 'supplier', 'amount'] } },
			update: { columns: { invoices: ['note'] } }
		},
		purchase_orders: {
			read: { purchase_orders: { fields: 'all' } },
			create: { columns: { purchase_orders: ['number', 'supplier', 'amount', 'margin'] } }
		},
		ledgers: { read: { ledgers: { fields: 'all' } }, create: { columns: { ledgers: ['title'] } } }
	},
	policies: {
		matcher: {
			description: 'Matches invoices',
			grants: {
				invoices: { read: true, update: true },
				purchase_orders: { read: { purchase_orders: { fields: ['number', 'supplier', 'amount'] } } }
			}
		},
		clerk: {
			description: 'Enters documents',
			grants: {
				invoices: { read: true, create: true, update: true },
				purchase_orders: { read: true, create: true },
				ledgers: { read: true, create: true }
			},
			automations: ['relay']
		}
	},
	automations: {
		match: { description: 'Match a new invoice', on: { created: 'invoices' }, runAs: ['matcher'] },
		relay: { description: 'Relay as the clerk', input: { id: { kind: 'text' } }, runAs: 'trigger' }
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
const output = { kind: 'object', fields: { matched: { kind: 'bool' }, po: { kind: 'text' } } };
const infer = (ctx, inv) => Effect.result(ctx.ai.sys_2.infer({ prompt: 'Match invoice ' + inv.number, output, tools: ['read'], steps: 2 }));
export default { automation: {
	match: { body: function* (input, ctx) {
		for (const id of input.ids) {
			const inv = (yield* ctx.query({ invoices: { where: { id: { eq: id } } } })).invoices.rows[0];
			const r = yield* infer(ctx, inv);
			yield* ctx.act('invoices.update', [{ target: id, set: { note: Result.isFailure(r) ? 'failed' : JSON.stringify(r.success) } }]);
		}
	} },
	relay: { body: function* (input, ctx) {
		const inv = (yield* ctx.query({ invoices: { where: { id: { eq: input.id } } } })).invoices.rows[0];
		const r = yield* infer(ctx, inv);
		yield* ctx.act('invoices.update', [{ target: input.id, set: { note: Result.isFailure(r) ? r.failure._tag + ': ' + r.failure.reason : 'answered' } }]);
	} }
} };`);

type Step = Ai['Service']['infer'];
const use =
	(calls: readonly { id: string; name: string; input: Json }[]): Step =>
	() =>
		Stream.succeed({
			_tag: 'Response',
			response: { content: '', toolCalls: calls, finish: 'tool', usage: { input: 1, output: 1 } }
		});
/** The provider's script: `arm` replaces its steps and clears its requests for the next test. */
const cassette = () => {
	const requests: AiRequest[] = [];
	const script: { steps: readonly Step[]; index: number } = { steps: [], index: 0 };
	const port: Ai['Service'] = {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Effect.succeed({ models: [{ id: 'default', label: 'Default' }], default: 'default' }),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.unwrap(
				Effect.sync(() => {
					requests.push(request);
					const step = script.steps[script.index++];
					return step === undefined
						? Stream.fail(new FacilityFailure({ kind: 'invalid', message: 'cassette exhausted' }))
						: step(request);
				})
			)
	};
	const arm = (steps: readonly Step[]) => {
		Object.assign(script, { steps, index: 0 });
		requests.length = 0;
	};
	return { port, requests, arm };
};
// One workspace for the file, its provider script armed per test.
const ai = cassette();
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const shared = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({ manifest, guest: yield* guest, ports: Layer.succeed(Ai, ai.port) })
			);
			return { t: Context.get(context, TestWorkspace), route: yield* routeFixture(context), ai };
		}).pipe(Scope.provide(fileScope))
	)
);
const open = (steps: readonly Step[]) =>
	Effect.map(shared, (fixture) => {
		ai.arm(steps);
		return fixture;
	});
const clerk = (t: Kit) => t.as(t.member(['clerk'])).authority;
const create = (t: Kit, route: FixtureRoute, callable: string, input: Json) =>
	actReply(route, clerk(t), { callable, input, issuedAt: t.clock.now() }).pipe(
		Effect.map((reply) => {
			const outcome: Outcome = reply.outcome;
			if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
			return outcome.records[0]!.id;
		})
	);
const note = (t: Kit, route: FixtureRoute, id: string) =>
	qReply(route, clerk(t), {
		reads: [{ m: 'query', a: [{ invoices: { where: { id: { eq: id } }, fields: ['note'] } }] }]
	}).pipe(
		Effect.map(
			(reply) =>
				Schema.decodeUnknownSync(
					Schema.Struct({
						invoices: Schema.Struct({
							rows: Schema.Array(Schema.Struct({ note: Schema.NullOr(Schema.String) }))
						})
					})
				)(reply.answers[0]).invoices.rows[0]?.note
		)
	);
const toolResults = (request: AiRequest) =>
	request.messages
		.filter((message) => message.role === 'tool')
		.map(
			(message) =>
				Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(message.content).result
		);

describe("sys_2.infer tools: ['read']", () => {
	it.live(
		'reads over two turns as the runAs policies (refused root, masked field), then the spent budget leaves the draft tools',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route, ai } = yield* open([
						use([
							{
								id: 'r1',
								name: 'read',
								input: { purchase_orders: { where: { supplier: { eq: 'Acme' } } } }
							}
						]),
						use([{ id: 'r2', name: 'read', input: { ledgers: {} } }]),
						use([
							{
								id: 'p',
								name: 'edit',
								input: {
									ops: [
										{ path: '/matched', set: true },
										{ path: '/po', set: 'PO-1' }
									]
								}
							},
							{ id: 's', name: 'submit', input: {} }
						])
					]);
					yield* create(t, route, 'purchase_orders.create', [
						{ number: 'PO-1', supplier: 'Acme', amount: 120, margin: 40 },
						{ number: 'PO-2', supplier: 'Other', amount: 50, margin: 10 }
					]);
					yield* create(t, route, 'ledgers.create', [{ title: 'secret' }]);
					const id = yield* create(t, route, 'invoices.create', [
						{
							number: 'INV-9',
							supplier: 'Acme',
							amount: 120
						}
					]);
					yield* t.runDue();
					expect(yield* note(t, route, id)).toBe(JSON.stringify({ matched: true, po: 'PO-1' }));
					expect(ai.requests).toHaveLength(3);
					const offered = ai.requests[0]!.tools!;
					// the workspace `read` (a read request) first, then the draft tools
					expect(offered.map((tool) => tool.name)).toEqual([
						'read',
						'edit',
						'submit',
						'read_answer',
						'find',
						'diff'
					]);
					// the keys the runAs policies may read, and no other
					expect(
						Object.keys(
							Schema.decodeUnknownSync(
								Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) })
							)(offered[0]!.input).properties
						).sort()
					).toEqual(['invoices', 'purchase_orders']);
					// one bounded page of the matcher's view: the Acme order only, its margin masked away
					const [page] = toolResults(ai.requests[1]!);
					const rows = Schema.decodeUnknownSync(
						Schema.Struct({
							purchase_orders: Schema.Struct({
								rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
							})
						})
					)(page).purchase_orders.rows;
					expect(rows.map((row) => row['number'])).toEqual(['PO-1']);
					expect(rows[0]!['margin']).toEqual({ $masked: true });
					expect(toolResults(ai.requests[2]!)[1]).toEqual({
						// a root the runAs policies cannot read is not in the tool's schema at all
						error: expect.stringMatching(/excess property[\s\S]*"ledgers"/)
					});
					// steps: 2 spent on the two reads; the final turn offers only the draft tools
					expect(ai.requests[2]!.tools!.map((tool) => tool.name)).toEqual([
						'edit',
						'submit',
						'read_answer',
						'find',
						'diff'
					]);
				})
			)
	);

	it.live('a runAs trigger run cannot offer read', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, ai } = yield* open([]);
				// the match run (an empty cassette) only notes a failure
				const id = yield* create(t, route, 'invoices.create', [
					{
						number: 'INV-1',
						supplier: 'Acme',
						amount: 1
					}
				]);
				yield* t.runDue();
				expect(yield* note(t, route, id)).toBe('failed');
				const asked = ai.requests.length;
				yield* actReply(route, clerk(t), {
					callable: 'start',
					input: { automation: 'relay', input: { id }, id: uuidv7(Date.parse(t.clock.now())) },
					issuedAt: t.clock.now()
				});
				yield* t.runDue();
				expect(yield* note(t, route, id)).toMatch(/^Unavailable: 'read' needs runAs policies/);
				expect(ai.requests).toHaveLength(asked); // refused before any model call
			})
		)
	);
});
