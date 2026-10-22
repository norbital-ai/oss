// An automation's `ctx.ai.sys_2.infer` host tool steps (web search, browsing) each leave one `infer.tool` event on the
// run: what was searched or opened, so a research run proves the steps it took.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, Outcome } from '../src/engine/contracts.ts';
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
	collections: {
		invoices: {
			read: { fields: 'all' },
			create: { input: { columns: ['number', 'supplier', 'amount'] } },
			update: { input: { columns: ['note'] } }
		},
		purchase_orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['number', 'supplier', 'amount', 'margin'] } }
		},
		ledgers: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } }
	},
	policies: {
		matcher: {
			description: 'Matches invoices',
			grants: {
				invoices: { read: true, update: true },
				purchase_orders: { read: { fields: ['number', 'supplier', 'amount'] } }
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
	pipelines: {},
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
const infer = (ctx, inv) => Effect.result(ctx.ai.sys_2.infer({ prompt: 'Match invoice ' + inv.number, output, tools: ['web_search'], steps: 2 }));
export default { automation: {
	match: { body: function* (input, ctx) {
		for (const id of input.ids) {
			const inv = yield* ctx.get('invoices', id);
			const r = yield* infer(ctx, inv);
			yield* ctx.act('invoices.update', { target: id, set: { note: Result.isFailure(r) ? 'failed' : JSON.stringify(r.success) } });
		}
	} },
	relay: { body: function* (input, ctx) {
		const inv = yield* ctx.get('invoices', input.id);
		const r = yield* infer(ctx, inv);
		yield* ctx.act('invoices.update', { target: input.id, set: { note: Result.isFailure(r) ? r.failure._tag + ': ' + r.failure.reason : 'answered' } });
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
	qReply(route, clerk(t), { reads: [{ m: 'get', a: ['invoices', id] }] }).pipe(
		Effect.map(
			(reply) =>
				Schema.decodeUnknownSync(Schema.Struct({ note: Schema.NullOr(Schema.String) }))(
					reply.answers[0]
				).note
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
	it.live('each host tool step is one infer.tool event on the run, with what it searched', () =>
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
				yield* create(t, route, 'invoices.create', {
					number: 'INV-1',
					supplier: 'Acme',
					amount: 1
				});
				yield* t.runDue();
				const { rows } = yield* t.db.write({
					text: "SELECT severity, attributes FROM sys_event WHERE event = 'infer.tool'",
					params: []
				});
				expect(rows).toEqual([
					{
						severity: 'info',
						attributes: {
							automation: 'match',
							tool: 'web_search',
							input: JSON.stringify({ query: 'employment act overtime' })
						}
					}
				]);
			})
		)
	);
});
