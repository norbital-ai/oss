// A payroll hotline on PGlite (§2.5, §2.7, §4.3, §4.4): one envoy deployed on two WhatsApp connections, one per legal
// entity (`entities.hotline` names the instance), under `dm: 'envoy'`. A turn's `{ var: 'requestor.instance' }` is the instance
// the message arrived on, so the same member reads only the entity whose hotline they wrote to, and only their own rows;
// an administrator's DM holds the envoy's policies alone (no bypass); `history`'s 'mine' stays on the instance. Admission
// is a run the ingest statement queued, so a crash between the two still turns once runs re-arm.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Predicate, Schema, Scope, Stream } from 'effect';
import { afterAll } from 'vitest';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Agents, Conversations } from '../src/engine/services.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, AiRequest } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { respondSystem1, TestWorkspace } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {
		entities: { description: 'A legal entity', label: 'name', fields: { name: { kind: 'text' } } },
		payslips: {
			description: 'A payslip',
			label: 'period',
			fields: {
				period: { kind: 'text' },
				net: { kind: 'int' },
				status: { kind: 'text', default: 'draft' }
			}
		}
	},
	relationships: {
		'entities.hotline': {
			to: 'sys_integration',
			optional: true,
			where: { integration: { eq: 'whatsapp' } }
		},
		'payslips.entity': { to: 'entities' },
		'payslips.employee': { to: 'sys_user' }
	},
	exposures: {
		entities: {
			read: { entities: { fields: 'all' } },
			create: { columns: { entities: ['name', 'hotline'] } }
		},
		payslips: {
			read: { payslips: { fields: 'all' } },
			create: { columns: { payslips: ['period', 'net', 'entity', 'employee'] } },
			update: { columns: { payslips: ['status'] } }
		}
	},
	integrations: {},
	policies: {
		hotline: {
			description:
				"What the payroll hotline answers: the sender's own payslips of the entity whose hotline this is",
			grants: {
				payslips: {
					read: {
						payslips: {
							where: {
								employee: { eq: { var: 'requestor.id' } },
								entity: { is: { hotline: { eq: { var: 'requestor.instance' } } } }
							},
							fields: ['period', 'net', 'status']
						}
					}
				}
			}
		},
		payroll: { description: 'Payroll staff', grants: { payslips: { read: true, update: true } } }
	},
	teams: { payroll: { name: 'Payroll', policies: ['payroll'] } },
	automations: {},
	connections: {
		hotline_a: { integration: 'whatsapp', envoy: 'payroll_hotline' },
		hotline_b: { integration: 'whatsapp', envoy: 'payroll_hotline' }
	},
	envoys: {
		payroll_hotline: {
			audience: 'private',
			name: 'Payroll',
			policies: ['hotline'],
			triage: false,
			groupMessages: 'disabled',
			delegation: 'disabled',
			dm: 'envoy',
			task: 'Answer payslip questions.'
		}
	},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

/** The model: "slips" reads the payslips, "pay <id>" marks one paid, "find <word>" searches the sender's own history; then "Done.". */
function scriptedAi() {
	const requests: AiRequest[] = [];
	let n = 0;
	const text = (c: Json) =>
		typeof c === 'string' ? c : String(Predicate.isObject(c) ? (c['text'] ?? '') : '');
	const usage = { input: 10, output: 5 };
	const call = (name: string, input: Json) => ({
		content: '',
		toolCalls: [{ id: `c${++n}`, name, input }],
		finish: 'tool' as const,
		usage
	});
	const layer = Layer.succeed(Ai, {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Effect.succeed({
			models: [{ id: 'default', label: 'Default' }],
			default: 'default'
		}),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.fromEffect(
				Effect.sync<AiResponse>(() => {
					requests.push(request);
					const last = present(
						request.messages.findLast(
							(m) => !(typeof m.content === 'string' && m.content.startsWith('[conversation state'))
						)
					);
					if (last.role === 'tool')
						return { content: 'Done.', toolCalls: [], finish: 'stop', usage };
					const said = text(last.content);
					if (/^(?:\[[^\]\n]*\] )?slips$/m.test(said)) return call('read', { payslips: {} });
					const pay = /^(?:\[[^\]\n]*\] )?pay (\S+)$/m.exec(said);
					if (pay !== null)
						return call('act', {
							callable: 'payslips.update',
							input: [{ target: present(pay[1]), set: { status: 'paid' } }]
						});
					const find = /^(?:\[[^\]\n]*\] )?find (\S+)$/m.exec(said);
					if (find !== null) return call('history', { query: present(find[1]), scope: 'mine' });
					return { content: `echo: ${said}`, toolCalls: [], finish: 'stop', usage };
				})
			).pipe(Stream.map((response) => ({ _tag: 'Response' as const, response })))
	});
	return { requests, layer };
}

const ADA = 'u-ada',
	CAL = 'u-cal';
// One workspace for the file, built on first use in the file's scope.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const build = Effect.gen(function* () {
	const ai = scriptedAi(),
		slip = { cal_a: '', cal_b: '', ada_a: '' };
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, ports: ai.layer }));
	const t = Context.get(context, TestWorkspace),
		agents = Context.get(context, Agents),
		conversations = Context.get(context, Conversations),
		route = yield* routeFixture(context);
	yield* t.db.write({
		text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'), ('${CAL}', 'cal@ws.example', 'Cal', false, NULL, '6598765432')`,
		params: []
	});
	const make = (callable: string, input: Json) =>
		Effect.gen(function* () {
			const o = (yield* actReply(route, t.as(t.admin).authority, {
				callable,
				input,
				issuedAt: t.clock.now()
			})).outcome;
			if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
			return present(o.records[0]).id;
		});
	const a = yield* make('entities.create', [{ name: 'Acme SG', hotline: 'hotline_a' }]),
		b = yield* make('entities.create', [{ name: 'Acme MY', hotline: 'hotline_b' }]);
	slip.cal_a = yield* make('payslips.create', [
		{
			period: '2026-09',
			net: 100,
			entity: a,
			employee: CAL
		}
	]);
	slip.cal_b = yield* make('payslips.create', [
		{
			period: '2026-09',
			net: 200,
			entity: b,
			employee: CAL
		}
	]);
	slip.ada_a = yield* make('payslips.create', [
		{
			period: '2026-09',
			net: 300,
			entity: a,
			employee: ADA
		}
	]);
	let seq = 0;
	/** A DM is held for the sender's pause even with triage off: the pause passes, and the held burst is admitted. */
	const dm = (instance: string, from: string, text: string) =>
		t
			.receive(instance, {
				id: `h${++seq}`,
				thread: from,
				sentAt: t.clock.now(),
				from: { handle: from, name: null },
				text,
				attachments: []
			})
			.pipe(
				Effect.andThen(
					Effect.gen(function* () {
						t.clock.advance('2s');
						yield* t.runDue();
					})
				)
			);
	/** The newest tool row's result: what the turn's authority let the tool do. */
	const lastResult = () =>
		t.db.value(Schema.Json, {
			text: `SELECT content->'result' AS result FROM sys_message WHERE role = 'tool' ORDER BY seq DESC LIMIT 1`,
			params: []
		});
	return { t, context, ai, slip, agents, conversations, route, dm, lastResult };
});
const setup = Effect.runSync(Effect.cached(build.pipe(Scope.provide(fileScope))));
const nets = (result: Json) =>
	Schema.decodeUnknownSync(
		Schema.Struct({
			payslips: Schema.Struct({ rows: Schema.Array(Schema.Struct({ net: Schema.Number })) })
		})
	)(result)
		.payslips.rows.map((row) => row.net)
		.sort();

describe("an entity hotline ({ var: 'requestor.instance' }, dm: 'envoy')", () => {
	it.live(
		"a member reads only their own rows of the instance's entity; an admin's DM holds the envoy's policies alone; history stays on the instance",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, slip, route, agents, dm, lastResult } = yield* setup;
					yield* dm('hotline_a', '6598765432@s.whatsapp.net', 'slips');
					expect(nets(yield* lastResult())).toEqual([100]);
					yield* dm('hotline_b', '6598765432@s.whatsapp.net', 'slips');
					expect(nets(yield* lastResult())).toEqual([200]);
					// each instance answers on its own link
					expect(t.fakes.links.sent.map((s) => s.instance)).toEqual(['hotline_a', 'hotline_b']);

					// the envoy's policies grant no write, and without the bypass her turn has no write tool at all
					yield* dm('hotline_a', '6591234567@s.whatsapp.net', `pay ${slip.ada_a}`);
					expect(yield* lastResult()).toEqual({ error: "No tool 'act'." });
					expect(
						(yield* Schema.decodeUnknownEffect(
							Schema.Struct({
								payslips: Schema.Struct({
									rows: Schema.Tuple([Schema.Struct({ status: Schema.String })])
								})
							})
						)(
							(yield* qReply(route, t.as(t.admin).authority, {
								reads: [
									{
										m: 'query',
										a: [{ payslips: { where: { id: { eq: slip.ada_a } }, fields: ['status'] } }]
									}
								]
							})).answers[0]
						)).payslips.rows[0].status
					).toBe('draft');

					// history 'mine' finds the sender's 'slips' on this instance only: not hotline_a's, not the app's
					const app = yield* agents.start({ owner: CAL });
					yield* t.db.write({
						text: `INSERT INTO sys_message (id, conversation, role, text, "as") VALUES ('app-1', $1, 'user', 'slips', $2::jsonb)`,
						params: [app, JSON.stringify({ member: CAL })]
					});
					const found = () =>
						lastResult().pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Struct({ hits: Schema.Array(Schema.Struct({ text: Schema.String })) })
								)
							),
							Effect.map((result) =>
								result.hits.map((hit) => hit.text).filter((value) => value !== 'find slips')
							)
						);
					yield* dm('hotline_b', '6598765432@s.whatsapp.net', 'find slips');
					expect(yield* found()).toEqual(['slips']);
				})
			)
	);
});

describe('durable admission (§4.3)', () => {
	it.live(
		'one ingest statement queues the admission, which the run then turns; a paused instance stores without admitting',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, context, ai, route, conversations, lastResult } = yield* setup;
					t.count.reset();
					const asked = ai.requests.length;
					yield* conversations
						.receive('hotline_a', {
							kind: 'messages',
							messages: [
								{
									id: 'crash-1',
									thread: '6598765432@s.whatsapp.net',
									sentAt: t.clock.now(),
									from: { handle: '6598765432@s.whatsapp.net', name: null },
									text: 'slips',
									attachments: []
								}
							]
						})
						.pipe(Effect.provide(context));
					expect(t.count.writes).toBe(1);
					const admissions = (state: string) =>
						t.db.value(Schema.Number, {
							text: `SELECT count(*)::int FROM sys_run WHERE automation = 'envoys.admit' AND state LIKE $1`,
							params: [state]
						});
					expect(yield* admissions('queued')).toBe(1);
					expect(ai.requests).toHaveLength(asked);
					// the admission is a queued run (a restart re-arms queued runs: runs.integration, lost leases)
					yield* t.runDue();
					t.clock.advance('2s'); // the admitted DM waits out the sender's pause
					yield* t.runDue();
					yield* t.settled();
					expect(yield* admissions('queued')).toBe(0);
					expect(ai.requests).toHaveLength(asked + 2);
					expect(nets(yield* lastResult())).toEqual([100]);

					const all = yield* admissions('%');
					const o = (yield* actReply(route, t.as(t.admin).authority, {
						callable: 'sys_integration.update',
						input: [{ target: 'hotline_a', set: { active: false } }],
						issuedAt: t.clock.now()
					})).outcome;
					expect(o.kind).toBe('committed');
					const message = {
						id: 'p-1',
						thread: '6598765432@s.whatsapp.net',
						sentAt: t.clock.now(),
						from: { handle: '6598765432@s.whatsapp.net', name: null },
						text: 'held',
						attachments: []
					};
					// a redelivery is the same row and queues nothing
					yield* t.receive('hotline_a', message);
					yield* t.receive('hotline_a', message);
					const [rows] = yield* t.db.read([
						{
							text: `SELECT role, addressed FROM sys_message WHERE direction = 'inbound' AND text = 'held'`,
							params: []
						}
					]);
					expect(present(rows).rows).toEqual([{ role: null, addressed: null }]);
					expect(yield* admissions('%')).toBe(all);
					expect(ai.requests).toHaveLength(asked + 2);
				})
			)
	);
});
