// AI filtering (rule 16a, P33, P34; §11.2 G5) through the engine entry: a scripted `ai.system1` (no vendor) chooses
// among the options the engine builds; the chosen options map 1:1 onto a decoded `Where` and `OrderBy`. There is no
// System 2 path (owner ruling): a System 1 failure applies nothing, and with no AI facility the feature is absent.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema, Stream } from 'effect';
import { Ai, Metering } from '../src/engine/ports.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import { Port } from '../src/engine/port.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import type {
	DecisionAnswer,
	DecisionQuestion,
	DecisionResult,
	System1,
	System1Request
} from '../src/engine/decisions/index.ts';
import { filterDescribe, literals } from '../src/engine/filter-describe/index.ts';
import { TestWorkspace } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {
		members: {
			description: 'A member of staff',
			label: 'name',
			fields: { name: { kind: 'text' } }
		},
		jobs: {
			description: 'A job',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				scheduled_on: { kind: 'date' },
				hours: { kind: 'decimal', scale: 1, optional: true },
				notes: { kind: 'text', optional: true },
				status: {
					kind: 'state',
					initial: 'scheduled',
					states: { scheduled: { to: ['in_progress'] }, in_progress: { to: ['done'] }, done: {} }
				}
			}
		}
	},
	relationships: { 'jobs.assignee': { to: 'members', inverse: 'assigned_jobs' } },
	collections: {
		members: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } },
		jobs: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'scheduled_on', 'status', 'assignee'] } }
		}
	},
	integrations: {},
	pipelines: {},
	// `notes` is masked to the dispatcher: its one read arm lists the fields it reads
	policies: {
		dispatch: {
			description: 'Dispatch',
			grants: {
				members: { read: true },
				jobs: {
					read: {
						fields: [
							'id',
							'title',
							'scheduled_on',
							'hours',
							'status',
							'assignee',
							'created_at',
							'updated_at'
						]
					}
				}
			}
		}
	},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

/** A scripted System 1: `pick` maps question ids to a choice or a noul; any other question gets its first option or 0. */
function system1(
	pick: (r: System1Request, call: number) => { readonly [id: string]: string | boolean }
) {
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => {
		if (q.type === 'noul') return { type: 'noul', noul: v === true ? 0.9 : 0.1 };
		const choice =
			q.type === 'choice' ? (typeof v === 'string' ? v : present(Object.keys(q.criteria)[0])) : '';
		return q.type === 'choice'
			? { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	};
	const port: System1 & { requests: System1Request[]; throws: boolean } = {
		requests: [],
		throws: false,
		ask: (r) =>
			Effect.try({
				try: () => {
					port.requests.push(r);
					if (port.throws) throw new Error('provider down');
					const chosen = pick(r, port.requests.length);
					return {
						costUsd: 0.00003,
						provider: 'scripted',
						answers: Object.fromEntries(
							Object.entries(r.questions).map(([id, q]) => [id, answer(q, chosen[id])])
						)
					};
				},
				catch: Port.failure('sys_1')
			})
	};
	return port;
}
const options = (q: DecisionQuestion | undefined) =>
	q?.type === 'choice' ? Object.keys(q.criteria) : [];
const ai = (system: System1) =>
	Layer.succeed(Ai, {
		ask: system.ask,
		maxChoices: system.maxChoices,
		models: ['fast'],
		catalog: Port.unavailable('ai.catalog'),
		infer: () => Stream.die(new Error('System 2 is never asked')),
		embed: () => Effect.die(new Error('Embeddings are never asked'))
	});
/**
 * A scripted answer in the request's own shape: per field the whole condition the description states ("Title contains
 * “pump”"), or none when the plan omits the field. The engine numbers the fields it asked about in the state's order, so
 * the script names them by label. A list operator names its values, each its own yes / no.
 */
type Plan = {
	readonly [label: string]: { op: string; value?: string; values?: readonly string[] } | false;
};
const byField =
	(plan: Plan, extra: { [id: string]: string | boolean } = {}) =>
	(r: System1Request): { readonly [id: string]: string | boolean } => {
		const pick: { [id: string]: string | boolean } = { ...extra };
		for (const [id, q] of Object.entries(r.questions)) {
			if (q.type !== 'choice' || !/^f\d+$/.test(id)) continue;
			const label = present(
					Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ label: Schema.String })))(
						r.state['fields']
					)[Number(id.slice(1)) - 1]
				).label,
				a = plan[label];
			if (a === undefined || a === false) continue; // its first option: no condition
			const want =
				a.values !== undefined
					? [`${label} ${a.op} the ones named`]
					: [
							`${label} ${a.op}${a.value === undefined ? '' : ` ${a.value}`}`,
							`${label} ${a.op} \u201c${a.value}\u201d`
						];
			const hit = Object.keys(q.criteria).find((k) => want.includes(k));
			if (hit === undefined)
				throw new Error(`no option "${want[0]}" among: ${Object.keys(q.criteria).join(' | ')}`);
			pick[id] = hit;
			for (const [v, nq] of Object.entries(r.questions))
				if (
					v.startsWith(`${id}.`) &&
					a.values?.some((x) => nq.instructions.startsWith(`Is ${x} one of`))
				)
					pick[v] = true;
		}
		return pick;
	};
const BOB: Plan = {
	Assignee: { op: 'is', value: 'Bob Tan' },
	'Scheduled on': { op: 'is within', value: 'this week' },
	Status: { op: 'is none of', value: 'a final state' }
};

const create = (t: TestWorkspace['Service'], route: FixtureRoute, callable: string, input: Json) =>
	actReply(route, t.as(t.admin).authority, { callable, input, issuedAt: t.clock.now() }).pipe(
		Effect.map((reply) => {
			const outcome = reply.outcome;
			if (outcome.kind !== 'committed' || outcome.records[0] === undefined)
				throw new Error(JSON.stringify(outcome));
			return outcome.records[0].id;
		})
	);
const open = (port?: System1, m: EngineManifest = manifest) =>
	Effect.gen(function* () {
		const metered: string[] = [];
		const metering = Layer.succeed(Metering, {
			record: (meter, _quantity, key) =>
				Effect.sync(() => {
					metered.push(`${meter}:${key.split(':')[0]}`);
				})
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				ports: port === undefined ? metering : Layer.merge(metering, ai(port))
			})
		);
		const t = Context.get(context, TestWorkspace),
			filters = yield* filterDescribe.pipe(Effect.provide(context)),
			route = yield* routeFixture(context);
		const bob = yield* create(t, route, 'members.create', { name: 'Bob Tan' });
		yield* create(t, route, 'members.create', { name: 'Alice Ng' });
		const caller = t.as(t.member(['dispatch'])).authority;
		const describeAs = (text: string) =>
			filters.describe({
				collection: 'jobs',
				text,
				authority: caller,
				bindings: {
					now: t.clock.now(),
					today: t.clock.now().slice(0, 10),
					tz: 'Asia/Singapore',
					params: {}
				}
			});
		const events = () =>
			Effect.sync(() =>
				t.fakes.logs.filter((r) => r.event === 'decision.made').map((r) => r.attributes)
			);
		return { t, context, filters, route, bob, caller, metered, describeAs, events };
	});
const titles = (route: FixtureRoute, caller: Authority, where?: object, orderBy?: object) =>
	qReply(route, caller, {
		reads: [
			{
				m: 'read',
				a: [
					'jobs',
					{
						all: true,
						...(where !== undefined && Object.keys(where).length > 0
							? { where: Schema.decodeUnknownSync(Schema.Json)(where) }
							: {}),
						...(orderBy === undefined
							? {}
							: { orderBy: Schema.decodeUnknownSync(Schema.Json)(orderBy) }),
						select: { title: true }
					}
				]
			}
		]
	}).pipe(
		Effect.flatMap((reply) =>
			Schema.decodeUnknownEffect(
				Schema.Struct({ rows: Schema.Array(Schema.Struct({ title: Schema.String })) })
			)(reply.answers[0])
		),
		Effect.map((page) => page.rows.map((row) => row.title))
	);

describe('filter.describe (rule 16a)', () => {
	it.live(
		"Bob's jobs this week that aren't done: three conditions from ONE System 1 call, every answer an offered option",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const port = system1(byField(BOB));
					const { bob, metered, describeAs, events } = yield* open(port);
					const r = yield* describeAs("Bob's jobs this week that aren't done");
					expect(r).toMatchObject({
						ok: true,
						where: {
							and: expect.arrayContaining([
								{ scheduled_on: { gte: { startOf: 'week' }, lt: { startOf: 'week', shift: 1 } } },
								{ status: { nin: ['done'] } },
								{ assignee: { eq: bob } }
							])
						}
					});
					expect(
						r.ok &&
							Schema.decodeUnknownSync(Schema.Struct({ and: Schema.Array(Schema.Json) }))(
								'where' in r ? r.where : undefined
							).and
					).toHaveLength(3);
					expect(port.requests).toHaveLength(1);
					const q = present(port.requests[0]).questions;
					// each field is asked about on its own, as whole conditions, so a value can only ever name its own field
					const values = Object.values(q).flatMap((x) => options(x));
					expect(values).toContain('Assignee is Bob Tan');
					expect(values).toContain('Scheduled on is within this week');
					expect(values).not.toContain('Notes'); // masked to the caller: never offered
					expect(yield* events()).toMatchObject([{ use: 'filter', system: 1 }]);
					expect(metered).toEqual(['ai:decision']);
				})
			)
	);

	it.live('newest first sets one sort key; the sort questions ride the same call', () =>
		Effect.scoped(
			Effect.gen(function* () {
				// only the assignee is named: a field the plan omits is one the description did not restrict
				const port = system1(
					byField({ Assignee: present(BOB.Assignee) }, { sort: 'Created, latest first' })
				);
				const { bob, describeAs } = yield* open(port);
				expect(yield* describeAs("Bob's open jobs, newest first")).toEqual({
					ok: true,
					where: { assignee: { eq: bob } },
					orderBy: { created_at: 'desc' }
				});
				expect(port.requests).toHaveLength(1);
			})
		)
	);

	it.live(
		"one call answers every field: each question offers only its own field's whole conditions",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const port = system1(byField(BOB));
					const { describeAs } = yield* open(port);
					// an operator and a value asked apart could disagree (a day for "is within", one value for "is any of"); a field's
					// whole conditions, each decoded before it is offered, make a mismatch impossible by construction
					const r = yield* describeAs("Bob's jobs this week that aren't done");
					expect(r.ok).toBe(true);
					expect(port.requests).toHaveLength(1);
					const req = present(port.requests[0]);
					for (const [id, q] of Object.entries(req.questions)) {
						if (!/^f\d+$/.test(id)) continue;
						const label = present(
							Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ label: Schema.String })))(
								req.state['fields']
							)[Number(id.slice(1)) - 1]
						).label;
						expect(options(q).every((o) => o === 'no condition' || o.startsWith(`${label} `))).toBe(
							true
						);
					}
				})
			)
	);

	it.live(
		'a wide collection is asked about the fields the description names, still in one call',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const jobs = manifest.models.jobs;
					const wide = {
						...manifest,
						models: {
							...manifest.models,
							jobs: {
								...jobs,
								fields: {
									...jobs.fields,
									...Object.fromEntries(
										Array.from({ length: 30 }, (_, i) => [`filler_${i}`, { kind: 'text' as const }])
									)
								}
							}
						}
					} satisfies EngineManifest;
					const seen: System1Request[] = [];
					const context2 = yield* Layer.build(
						TestWorkspace.layer({
							manifest: wide,
							ports: ai({
								ask: (r) =>
									Effect.sync<DecisionResult>(() => {
										seen.push(r);
										return {
											costUsd: 0,
											provider: 'scripted',
											answers: Object.fromEntries(
												Object.entries(r.questions).map(([id, q]) => [
													id,
													q.type === 'noul'
														? { type: 'noul', noul: 0.1 }
														: {
																type: 'choice',
																choice: present(Object.keys(q.criteria)[0]),
																confidence: 1,
																probabilities: {}
															}
												])
											)
										};
									})
							})
						})
					);
					yield* (yield* filterDescribe.pipe(Effect.provide(context2))).describe({
						collection: 'jobs',
						text: "Bob's jobs this week",
						authority: Context.get(context2, TestWorkspace).as(
							Context.get(context2, TestWorkspace).admin
						).authority,
						bindings: {
							now: Context.get(context2, TestWorkspace).clock.now(),
							today: Context.get(context2, TestWorkspace).clock.now().slice(0, 10),
							tz: 'Asia/Singapore',
							params: {}
						}
					});
					expect(seen).toHaveLength(1);
					const asked = Object.keys(present(seen[0]).questions).filter(
						(id) => id.startsWith('f') && !id.includes('.')
					);
					expect(asked.length).toBe(16);
					// the field the description names is asked first, and the fillers that name nothing come after everything real
					const labels = Schema.decodeUnknownSync(
						Schema.Array(Schema.Struct({ label: Schema.String }))
					)(present(seen[0]).state.fields).map((f) => f.label);
					expect(labels.indexOf('Assignee')).toBeLessThan(
						labels.findIndex((l: string) => l.startsWith('Filler'))
					);
				})
			)
	);

	it.live(
		'a wide parent reaches a child count the description names in another inflection ("those with 1 suspicion log")',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					// the field-operations shape: a wide parent of numeric fields (a number in the text makes each of them a candidate),
					// its child relation named in the plural and in another word form, each child field also offered under any / all /
					// none. The count the description names must still be one of the sixteen fields asked about.
					const wide = {
						...manifest,
						models: {
							...manifest.models,
							members: {
								description: 'A member of staff',
								label: 'name',
								fields: {
									name: { kind: 'text' },
									suspicion_checked_at: { kind: 'instant', optional: true },
									grade: {
										kind: 'state',
										initial: 'junior',
										states: { junior: { to: ['senior'] }, senior: {} }
									},
									...Object.fromEntries(
										Array.from({ length: 20 }, (_, i) => [`tally_${i}`, { kind: 'int' as const }])
									)
								}
							},
							suspicious_activity_logs: {
								description: 'A finding',
								label: 'summary',
								fields: {
									summary: { kind: 'text' },
									severity: { kind: 'int' },
									note: { kind: 'text', optional: true },
									raised_on: { kind: 'date' }
								}
							}
						},
						relationships: {
							...manifest.relationships,
							'suspicious_activity_logs.member': {
								to: 'members',
								inverse: 'suspicious_activity_logs'
							}
						},
						collections: {
							...manifest.collections,
							suspicious_activity_logs: {
								read: { fields: 'all' },
								create: { input: { columns: ['summary', 'severity', 'raised_on', 'member'] } }
							}
						}
					} satisfies EngineManifest;
					const count = 'Number of suspicious activity logs';
					const context2 = yield* Layer.build(
						TestWorkspace.layer({
							manifest: wide,
							ports: ai(system1(byField({ [count]: { op: 'at least', value: '1' } })))
						})
					);
					const r = yield* (yield* filterDescribe.pipe(Effect.provide(context2))).describe({
						collection: 'members',
						text: 'those with 1 suspicion log',
						authority: Context.get(context2, TestWorkspace).as(
							Context.get(context2, TestWorkspace).admin
						).authority,
						bindings: {
							now: Context.get(context2, TestWorkspace).clock.now(),
							today: Context.get(context2, TestWorkspace).clock.now().slice(0, 10),
							tz: 'Asia/Singapore',
							params: {}
						}
					});
					expect(r).toEqual({
						ok: true,
						where: { suspicious_activity_logs: { count: { gte: 1 } } }
					});
					// a second condition the description names still has a place beside the child relation's many options
					const seen: System1Request[] = [];
					const context3 = yield* Layer.build(
						TestWorkspace.layer({
							manifest: wide,
							ports: ai({
								ask: (q) =>
									Effect.sync<DecisionResult>(() => {
										seen.push(q);
										return {
											costUsd: 0,
											provider: 's',
											answers: Object.fromEntries(
												Object.entries(q.questions).map(([id, x]) => [
													id,
													x.type === 'noul'
														? { type: 'noul', noul: 0.1 }
														: {
																type: 'choice',
																choice: present(Object.keys(x.criteria)[0]),
																confidence: 1,
																probabilities: {}
															}
												])
											)
										};
									})
							})
						})
					);
					yield* (yield* filterDescribe.pipe(Effect.provide(context3))).describe({
						collection: 'members',
						text: 'seniors with 1 suspicion log',
						authority: Context.get(context3, TestWorkspace).as(
							Context.get(context3, TestWorkspace).admin
						).authority,
						bindings: {
							now: Context.get(context3, TestWorkspace).clock.now(),
							today: Context.get(context3, TestWorkspace).clock.now().slice(0, 10),
							tz: 'Asia/Singapore',
							params: {}
						}
					});
					expect(
						Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ label: Schema.String })))(
							present(seen[0]).state.fields
						).map((f) => f.label)
					).toEqual(expect.arrayContaining([count, 'Grade']));
				})
			)
	);

	it.live('a failed System 1 call applies nothing and is recorded', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const port = system1(byField(BOB));
				const { metered, describeAs, events } = yield* open(port);
				port.throws = true;
				expect(yield* describeAs('jobs over 3 hours')).toMatchObject({
					ok: false,
					code: 'upstream'
				});
				expect(yield* events()).toMatchObject([{ use: 'filter', system: 1, error: 'upstream' }]);
				expect(metered).toEqual([]);
			})
		)
	);

	it.live(
		'Bolt caps no option set: 200 values are offered whole; a TooLarge refusal applies nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const jobs = manifest.models.jobs;
					const wide = {
						...manifest,
						models: {
							...manifest.models,
							jobs: {
								...jobs,
								fields: {
									...jobs.fields,
									code: { kind: 'enum', values: Array.from({ length: 200 }, (_, i) => `c${i}`) }
								}
							}
						}
					} satisfies EngineManifest;
					const seen: System1Request[] = [];
					const refusing: System1 = {
						ask: (request) =>
							Effect.gen(function* () {
								seen.push(request);
								return yield* Effect.fail(
									new FacilityFailure({ kind: 'tooLarge', message: 'context limit' })
								);
							})
					};
					const wideContext = yield* Layer.build(
						TestWorkspace.layer({ manifest: wide, ports: ai(refusing) })
					);
					const t = Context.get(wideContext, TestWorkspace),
						filters = yield* filterDescribe.pipe(Effect.provide(wideContext));
					const r = yield* filters.describe({
						collection: 'jobs',
						text: 'code c7',
						authority: t.as(t.admin).authority,
						bindings: {
							now: t.clock.now(),
							today: t.clock.now().slice(0, 10),
							tz: 'Asia/Singapore',
							params: {}
						}
					});
					expect(r).toMatchObject({ ok: false, code: 'tooLarge' });
					const code = Object.values(present(seen[0]).questions).find((q) =>
						options(q).some((o) => o.startsWith('Code is c'))
					);
					expect(options(code).filter((o) => /^Code is c\d+$/.test(o))).toHaveLength(200);
					// every question is in P37's shape over a structured state
					expect(
						Object.values(present(seen[0]).questions).every(
							(q) => typeof q.instructions === 'string' && q.criteria !== undefined
						)
					).toBe(true);
					expect(present(seen[0]).state).toMatchObject({
						description: 'code c7',
						collection: 'Jobs',
						timezone: 'Asia/Singapore'
					});
				})
			)
	);

	it.live('without an AI facility options still serve the builder and describing refuses', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, filters, caller, describeAs } = yield* open();
				expect(filters).toBeDefined();
				const opts = yield* filters.options({
					collection: 'jobs',
					authority: caller,
					bindings: {
						now: t.clock.now(),
						today: t.clock.now().slice(0, 10),
						tz: 'Asia/Singapore',
						params: {}
					}
				});
				expect(opts.ok).toBe(true);
				const r = yield* describeAs('jobs over 3 hours');
				expect(r).toMatchObject({ ok: false, code: 'unavailable' });
			})
		)
	);

	it.live('OR from a description selects the union of matching rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, bob, caller, describeAs } = yield* open(
					system1(
						byField(
							{
								Title: { op: 'contains', value: 'pump' },
								Assignee: { op: 'is', value: 'Bob Tan' }
							},
							{ combine: 'any of them hold' }
						)
					)
				);
				const alice = (yield* Schema.decodeUnknownEffect(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
				)(
					(yield* qReply(route, t.as(t.admin).authority, {
						reads: [
							{ m: 'read', a: ['members', { where: { name: { eq: 'Alice Ng' } }, all: true }] }
						]
					})).answers[0]
				)).rows[0]?.id;
				if (alice === undefined) throw new Error('Missing Alice');
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'pump room',
					assignee: alice
				});
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'install',
					assignee: bob
				});
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'other',
					assignee: alice
				});
				const r = yield* describeAs("pump jobs or Bob's jobs");
				expect(r).toMatchObject({
					ok: true,
					where: {
						or: expect.arrayContaining([{ title: { like: '%pump%' } }, { assignee: { eq: bob } }])
					}
				});
				expect(
					(yield* titles(
						route,
						caller,
						Schema.decodeUnknownSync(
							Schema.Struct({ where: Schema.Record(Schema.String, Schema.Json) })
						)(r).where
					)).sort()
				).toEqual(['install', 'pump room']);
			})
		)
	);

	it.live('a related-field condition from a description selects those rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, bob, caller, describeAs } = yield* open(
					system1(byField({ 'Assignee › Name': { op: 'contains', value: 'bob' } }))
				);
				const alice = (yield* Schema.decodeUnknownEffect(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
				)(
					(yield* qReply(route, t.as(t.admin).authority, {
						reads: [
							{ m: 'read', a: ['members', { where: { name: { eq: 'Alice Ng' } }, all: true }] }
						]
					})).answers[0]
				)).rows[0]?.id;
				if (alice === undefined) throw new Error('Missing Alice');
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'bob job',
					assignee: bob
				});
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'alice job',
					assignee: alice
				});
				const r = yield* describeAs('jobs whose assignee name contains bob');
				expect(r).toEqual({ ok: true, where: { assignee: { is: { name: { like: '%bob%' } } } } });
				expect(
					yield* titles(
						route,
						caller,
						Schema.decodeUnknownSync(
							Schema.Struct({ where: Schema.Record(Schema.String, Schema.Json) })
						)(r).where
					)
				).toEqual(['bob job']);
			})
		)
	);

	it.live('a related sort from a description orders the matching rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, route, bob, caller, describeAs } = yield* open(
					system1(byField({}, { sort: 'Assignee › Name, A to Z' }))
				);
				const alice = (yield* Schema.decodeUnknownEffect(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
				)(
					(yield* qReply(route, t.as(t.admin).authority, {
						reads: [
							{ m: 'read', a: ['members', { where: { name: { eq: 'Alice Ng' } }, all: true }] }
						]
					})).answers[0]
				)).rows[0]?.id;
				if (alice === undefined) throw new Error('Missing Alice');
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'zzz job',
					assignee: bob
				});
				yield* create(t, route, 'jobs.create', {
					scheduled_on: '2026-09-28',
					title: 'aaa job',
					assignee: alice
				});
				const r = yield* describeAs('sorted by assignee name');
				expect(r).toEqual({ ok: true, orderBy: { assignee: { name: 'asc' } } });
				expect(
					yield* titles(
						route,
						caller,
						undefined,
						Schema.decodeUnknownSync(
							Schema.Struct({ orderBy: Schema.Record(Schema.String, Schema.Json) })
						)(r).orderBy
					)
				).toEqual(['aaa job', 'zzz job']);
			})
		)
	);
});

it('literals: quoted strings, numbers and dates from the text', () => {
	expect(
		literals(
			'jobs over 3 hours named "pump room" before 2026-10-01 or 5/10/2026',
			'en',
			'2026-10-08'
		)
	).toEqual({
		strings: ['pump room'],
		numbers: [3],
		dates: ['2026-10-01', '2026-10-05']
	});
	// a named month, its year today's unless stated; a day the month lacks is no date
	expect(
		literals(
			'after 3rd October, before Oct 9th 2027, the 1st of jan or 31 June',
			'en',
			'2026-10-08'
		).dates.sort()
	).toEqual(['2026-01-01', '2026-10-03', '2027-10-09']);
	expect(literals('jobs with 3 decimal places in march', 'en', '2026-10-08')).toEqual({
		strings: [],
		numbers: [3],
		dates: []
	});
});

describe('dates and relations a description names (live Jev misreadings, 2026-10-08)', () => {
	const at = {
		now: '2026-10-08T03:00:00.000Z',
		today: '2026-10-08',
		tz: 'Asia/Singapore',
		params: {}
	};
	// members carry a search document: their candidates come from the indexed search, not a label scan
	const searchable = {
		...manifest,
		models: {
			...manifest.models,
			members: { ...manifest.models['members'], search: { text: ['name'] } }
		}
	} satisfies EngineManifest;
	const run = (text: string, plan: Plan, sort: { [id: string]: string | boolean } = {}) =>
		Effect.gen(function* () {
			const provider = system1(byField(plan, sort));
			const context = yield* Layer.build(
				TestWorkspace.layer({ manifest: searchable, ports: ai(provider) })
			);
			const workspace = Context.get(context, TestWorkspace),
				route = yield* routeFixture(context),
				filters = yield* filterDescribe.pipe(Effect.provide(context));
			const bob = yield* create(workspace, route, 'members.create', { name: 'Bob Tan' });
			const r = yield* filters.describe({
				collection: 'jobs',
				text,
				authority: workspace.as(workspace.admin).authority,
				bindings: at
			});
			return {
				r,
				bob,
				offered: Object.values(present(provider.requests[0]).questions).flatMap((question) =>
					options(question)
				)
			};
		});

	it.live(
		'"after 3rd October" offers that day: a date is after it, an instant from the next midnight in the workspace zone',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const date = yield* run('jobs scheduled after 3rd October', {
						'Scheduled on': { op: 'after', value: '2026-10-03' }
					});
					expect(date.r).toEqual({ ok: true, where: { scheduled_on: { gt: '2026-10-03' } } });
					const instant = yield* run('jobs created after 3rd October', {
						Created: { op: 'after', value: '2026-10-03' }
					});
					expect(instant.offered).toContain('Created after 2026-10-03');
					expect(instant.r).toEqual({
						ok: true,
						where: { created_at: { gte: '2026-10-03T16:00:00.000Z' } }
					});
					expect(
						(yield* run('jobs created on 3 Oct', {
							Created: { op: 'is within', value: '2026-10-03' }
						})).r
					).toEqual({
						ok: true,
						where: {
							created_at: { gte: '2026-10-02T16:00:00.000Z', lt: '2026-10-03T16:00:00.000Z' }
						}
					});
				})
			)
	);

	it.live('after a span is from its end, on or before it up to its end', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(
					(yield* run('jobs scheduled after last week', {
						'Scheduled on': { op: 'after', value: 'last week' }
					})).r
				).toEqual({ ok: true, where: { scheduled_on: { gte: { startOf: 'week' } } } });
				expect(
					(yield* run('jobs scheduled on or before this month', {
						'Scheduled on': { op: 'on or before', value: 'this month' }
					})).r
				).toEqual({ ok: true, where: { scheduled_on: { lt: { startOf: 'month', shift: 1 } } } });
			})
		)
	);

	it.live(
		'a possessive finds its owner through the search index ("Bob\'s jobs" offered no Bob Tan)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { r, bob, offered } = yield* run("Bob's jobs", {
						Assignee: { op: 'is', value: 'Bob Tan' }
					});
					expect(offered).toContain('Assignee is Bob Tan');
					expect(r).toEqual({ ok: true, where: { assignee: { eq: bob } } });
				})
			)
	);

	it.live(
		'a relation pinned to a found record takes no echoed word under it ("bbo tan" also read Name is "tan")',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { r, bob } = yield* run('jobs for bbo tan', {
						Assignee: { op: 'is', value: 'Bob Tan' },
						'Assignee \u203a Name': { op: 'is', value: 'tan' }
					});
					expect(r).toEqual({ ok: true, where: { assignee: { eq: bob } } });
				})
			)
	);
});

describe("named days, lists, ranges and a related record's own related records (2026-10-09)", () => {
	const at = {
		now: '2026-10-08T03:00:00.000Z',
		today: '2026-10-08',
		tz: 'Asia/Singapore',
		params: {}
	};
	const shop = {
		workspace: { tz: 'Asia/Singapore', locale: 'en' },
		models: {
			customers: {
				description: 'A customer',
				label: 'name',
				search: { text: ['name'] },
				fields: { name: { kind: 'text' } }
			},
			invoices: {
				description: 'An invoice',
				label: 'number',
				fields: { number: { kind: 'text' }, status: { kind: 'enum', values: ['paid', 'unpaid'] } }
			},
			holidays: {
				description: 'A holiday',
				label: 'name',
				fields: { name: { kind: 'text' }, date: { kind: 'date' } }
			},
			jobs: {
				description: 'A job',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					scheduled_on: { kind: 'date' },
					hours: { kind: 'decimal', scale: 1 },
					status: { kind: 'enum', values: ['scheduled', 'in_progress', 'done'] }
				}
			}
		},
		relationships: {
			'jobs.customer': { to: 'customers', inverse: 'jobs', optional: true },
			'invoices.customer': { to: 'customers', inverse: 'invoices' }
		},
		collections: {
			customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } },
			invoices: {
				read: { fields: 'all' },
				create: { input: { columns: ['number', 'status', 'customer'] } }
			},
			holidays: { read: { fields: 'all' }, create: { input: { columns: ['name', 'date'] } } },
			jobs: {
				read: { fields: 'all' },
				create: { input: { columns: ['title', 'scheduled_on', 'hours', 'status', 'customer'] } }
			}
		},
		integrations: {},
		pipelines: {},
		policies: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	} satisfies EngineManifest;
	const setup = (plan: Plan, extra: { [id: string]: string | boolean } = {}) =>
		Effect.gen(function* () {
			const provider = system1(byField(plan, extra));
			const context = yield* Layer.build(
				TestWorkspace.layer({ manifest: shop, ports: ai(provider) })
			);
			const workspace = Context.get(context, TestWorkspace),
				route = yield* routeFixture(context),
				authority = workspace.as(workspace.admin).authority,
				filters = yield* filterDescribe.pipe(Effect.provide(context));
			const id = (collection: string, row: Record<string, Json>) =>
				create(workspace, route, `${collection}.create`, row);
			const acme = yield* id('customers', { name: 'Acme' }),
				globex = yield* id('customers', { name: 'Globex' });
			yield* id('invoices', { number: 'INV-1', status: 'unpaid', customer: acme });
			yield* id('invoices', { number: 'INV-2', status: 'paid', customer: globex });
			for (const [name, date] of [
				['National Day', '2025-08-09'],
				['National Day', '2026-08-09'],
				['Company Day', '2026-10-01']
			] as const)
				yield* id('holidays', { name, date });
			for (const [title, scheduled_on, hours, status, customer] of [
				['pump room', '2026-10-06', 3, 'scheduled', acme],
				['roof leak', '2026-09-20', 8, 'done', globex],
				['door hinge', '2026-10-02', 1, 'in_progress', null]
			] as const)
				yield* id('jobs', {
					title,
					scheduled_on,
					hours,
					status,
					...(customer === null ? {} : { customer })
				});
			return (collection: string, text: string) =>
				Effect.gen(function* () {
					const r = yield* filters.describe({ collection, text, authority, bindings: at });
					const label = collection === 'jobs' ? 'title' : 'name';
					let rows: (Json | undefined)[] = [];
					if (r.ok) {
						const page = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
						)(
							(yield* qReply(route, authority, {
								reads: [
									{
										m: 'read',
										a: [
											collection,
											{
												all: true,
												...('where' in r && r.where !== undefined
													? { where: Schema.decodeUnknownSync(Schema.Json)(r.where) }
													: {}),
												select: { [label]: true }
											}
										]
									}
								]
							})).answers[0]
						);
						rows = page.rows.map((row) => row[label]).sort();
					}
					const request = provider.requests.at(-1);
					if (request === undefined) throw new Error('Missing filter request');
					return {
						r,
						rows,
						offered: Object.values(request.questions).flatMap((question) => options(question))
					};
				});
		});

	it.live(
		'a named day is a record the caller reads with a date, its nearest occurrence, applied once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const d = yield* setup({
						'Scheduled on': { op: 'after', value: 'National Day (2026-08-09)' },
						Created: { op: 'after', value: 'National Day (2026-08-09)' }
					});
					const { r, offered } = yield* d('jobs', 'jobs scheduled after national day');
					expect(offered).toContain('Scheduled on after National Day (2026-08-09)');
					expect(offered).not.toContain('Scheduled on after National Day (2025-08-09)'); // the occurrence nearest today
					// the day reads once: one date condition, never both "scheduled after" and "created after"
					expect(r).toMatchObject({ ok: true });
					expect(
						JSON.stringify(
							Schema.decodeUnknownSync(
								Schema.Struct({ where: Schema.Record(Schema.String, Schema.Json) })
							)(r).where
						).match(/2026-08-09/g)
					).toHaveLength(1);
				})
			)
	);

	it.live(
		'a related record\'s own related records: "jobs whose customer has an unpaid invoice"',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const d = yield* setup({
						'Customer › Invoices (any) › Status': { op: 'is', value: 'unpaid' }
					});
					const { r, rows } = yield* d('jobs', 'jobs whose customer has an unpaid invoice');
					expect(r).toEqual({
						ok: true,
						where: { customer: { is: { invoices: { some: { status: { eq: 'unpaid' } } } } } }
					});
					expect(rows).toEqual(['pump room']);
				})
			)
	);

	it.live('presence and absence of related records need no number in the text', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(
					(yield* (yield* setup({ Customer: { op: 'is not empty' } }))(
						'jobs',
						'jobs with a customer'
					)).rows
				).toEqual(['pump room', 'roof leak']);
				const none = yield* (yield* setup({ 'Number of invoices': { op: 'is', value: '0' } }))(
					'customers',
					'customers with no invoices'
				);
				expect(none.r).toEqual({ ok: true, where: { invoices: { count: { eq: 0 } } } });
				expect(none.rows).toEqual([]);
				const one = yield* (yield* setup({
					'Invoices (any) › Status': { op: 'is', value: 'unpaid' },
					'Number of invoices': { op: 'at least', value: '1' }
				}))('customers', 'customers with at least 1 unpaid invoice');
				expect(one.r).toEqual({
					ok: true,
					where: { invoices: { some: { status: { eq: 'unpaid' } } } }
				}); // "at least one" is implied
			})
		)
	);

	it.live(
		'"is any of" takes the values the description names, each its own yes / no; "between" takes two of its numbers',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const any = yield* (yield* setup({
						Status: { op: 'is any of', values: ['scheduled', 'done'] }
					}))('jobs', 'scheduled or done jobs');
					expect(any.r).toEqual({ ok: true, where: { status: { in: ['scheduled', 'done'] } } });
					expect(any.rows).toEqual(['pump room', 'roof leak']);
					const between = yield* (yield* setup({ Hours: { op: 'between 2 and 8' } }))(
						'jobs',
						'jobs between 2 and 8 hours'
					);
					expect(between.r).toEqual({ ok: true, where: { hours: { gte: 2, lte: 8 } } });
					expect(between.rows).toEqual(['pump room', 'roof leak']);
				})
			)
	);
});
