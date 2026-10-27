// An automation's `ctx.ai.sys_2.infer` host tool steps (web search, browsing) each leave one `infer.tool` event on the
// run: what was searched or opened, so a research run proves the steps it took.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Port } from '../src/engine/port.ts';
import { uuidv7 } from '../src/protocol/wire.ts';
import { Ai } from '../src/engine/ports.ts';
import { TestWorkspace, respondSystem1, type Kit } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
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
			},
			capabilities: { tools: ['web_search'] }
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
	agent: { skills: {} }
} satisfies EngineManifest;
const guest = program(`import { Effect, Result } from 'effect';
const output = { kind: 'object', fields: { matched: { kind: 'bool' }, po: { kind: 'text' } } };
const infer = (ctx, inv) => Effect.result(ctx.ai.sys_2.infer({ prompt: 'Match invoice ' + inv.number, output, tools: ['web_search'], steps: 2, label: inv.number }));
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
const cassette = (steps: readonly Step[]) => {
	const requests: AiRequest[] = [];
	let index = 0;
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
					const step = steps[index++];
					return step === undefined
						? Stream.fail(Port.failure('ai')(new Error('cassette exhausted')))
						: step(request);
				})
			)
	};
	return { port, requests };
};
const open = (steps: readonly Step[]) =>
	Effect.gen(function* () {
		const ai = cassette(steps);
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				ports: Layer.succeed(Ai, ai.port),
				host: {
					agent: {
						hostTools: [
							{
								name: 'web_search',
								description: 'Search the web',
								input: { type: 'object' },
								call: async () => ({ results: [{ url: 'https://law.example/act' }] })
							}
						]
					}
				}
			})
		);
		return { t: Context.get(context, TestWorkspace), route: yield* routeFixture(context), ai };
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

describe('sys_2.infer host tools', () => {
	it.live(
		'each host tool step and each edit or submit is one infer.tool event on the run, with its input',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route } = yield* open([
						use([{ id: 'w1', name: 'web_search', input: { query: 'employment act overtime' } }]),
						use([
							{
								id: 'p',
								name: 'edit',
								input: {
									ops: [
										{ path: '/matched', set: false },
										{ path: '/po', set: '' }
									]
								}
							},
							{ id: 's', name: 'submit', input: {} }
						])
					]);
					yield* create(t, route, 'invoices.create', [{
						number: 'INV-1',
						supplier: 'Acme',
						amount: 1
					}]);
					yield* t.runDue();
					const rows = t.fakes.logs
						.filter((r) => r.event === 'infer.tool')
						.map(({ severity, attributes }) => ({ severity, attributes }));
					const step = (tool: string, input: Json) => ({
						severity: 'info',
						attributes: { automation: 'match', tool, input: JSON.stringify(input) }
					});
					expect(rows).toEqual([
						step('web_search', { query: 'employment act overtime' }),
						step('edit', {
							ops: [
								{ path: '/matched', set: false },
								{ path: '/po', set: '' }
							]
						}),
						step('submit', {})
					]);
					// the inference's whole transcript is a conversation of its own, labelled, finished, owned by nobody
					const { rows: transcripts } = yield* t.db.write({
						text: 'SELECT id, title, owner, status FROM sys_conversation WHERE run IS NOT NULL',
						params: []
					});
					expect(transcripts).toMatchObject([
						{ title: 'match · INV-1', owner: null, status: 'idle' }
					]);
					const { rows: messages } = yield* t.db.write({
						text: 'SELECT role, author FROM sys_message WHERE conversation = $1 ORDER BY seq',
						params: [String(transcripts[0]?.['id'])]
					});
					expect(messages).toEqual([
						{ role: 'user', author: 'match' },
						{ role: 'assistant', author: null },
						{ role: 'tool', author: null },
						{ role: 'assistant', author: null },
						{ role: 'tool', author: null }
					]);
				})
			)
	);
});
