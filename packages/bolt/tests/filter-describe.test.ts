// AI filtering's schema, tool loop, strict decode and UI round-trip compatibility:
// `filter.describe` uses `infer_facility` (`sys_2`) over the caller's exposed view with an on-demand
// caller-scoped `lookup` tool and a `refuse` tool for clear caller-facing errors. The real native read
// boundary also exercises strict exposure, variable and sort refusals independently of the planner.
import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import type { Arm, Authority, ModelAuthority } from '../src/engine/contracts.ts';
import { Effect, Layer } from 'effect';
import { clock_probe } from './support/clock-probe.ts';
import { Ai, Logs } from '../src/engine/ports.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Manifest, Reads, type ReadsShape } from '../src/engine/services.ts';
import {
	type AiPort,
	type AiRequest,
	type AiResponse,
	DbError,
	FacilityFailure,
	off
} from '@norbital-ai/host-api';
import type { Pred } from '@norbital-ai/store';
import { viewOutput } from '../src/engine/access/authority.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { filter_describe } from '../src/engine/filter-describe/index.ts';
import { lower_read, read_engine } from '../src/engine/query/engine.ts';
import { materialize } from '../src/engine/runs/time.ts';

const manifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {
		members: {
			description: 'm',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, rate: { kind: 'money' } }
		},
		audits: { description: 'a', record_label: 'record.note', fields: { note: { kind: 'text' } } },
		jobs: {
			description: 'j',
			record_label: 'record.title',
			fields: {
				title: { kind: 'text' },
				hours: { kind: 'decimal', scale: 1 },
				notes: { kind: 'text', optional: true },
				internal_code: { kind: 'text' },
				scheduled_on: { kind: 'date' },
				spot: { kind: 'point', optional: true },
				window: { kind: 'period', of: 'date', optional: true },
				tags: { kind: 'text', many: true },
				status: { kind: 'state', initial: 'open', states: { open: { to: ['done'] }, done: {} } }
			}
		},
		job_lines: {
			description: 'l',
			record_label: 'record.item',
			fields: { item: { kind: 'text' }, qty: { kind: 'int' }, amount: { kind: 'money' } }
		}
	},
	relationships: {
		'jobs.assignee': { to: 'members', inverse: 'assigned_jobs' },
		'jobs.audit': { to: 'audits', optional: true },
		'members.manager': { to: 'members', optional: true },
		'job_lines.job': { to: 'jobs', inverse: 'lines' }
	},
	exposures: {
		members: { outputs: { default: { members: { fields: 'all' } } } },
		job_lines: { outputs: { default: { job_lines: { fields: 'all' } } } },
		jobs: {
			outputs: {
				default: {
					'jobs.assignee': { fields: 'all' },
					'jobs.assignee.manager': { fields: 'all' },
					'jobs.lines': { fields: 'all' },
					jobs: {
						fields: [
							'title',
							'hours',
							'notes',
							'scheduled_on',
							'spot',
							'window',
							'status',
							'tags',
							'assignee'
						]
					}
				},
				dispatch: {
					jobs: {
						fields: [
							'title',
							'hours',
							'scheduled_on',
							'spot',
							'window',
							'status',
							'tags',
							'assignee'
						]
					},
					'jobs.assignee': { fields: ['name', 'manager'] },
					'jobs.assignee.manager': { fields: 'all' },
					'jobs.lines': { fields: 'all' }
				},
				bare: { jobs: { fields: ['title', 'hours'] } }
			}
		}
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const exposures: EngineManifest['exposures'] = manifest.exposures;
const TRUE: Pred = { t: 'const', value: true };
const arm: Arm = { policy: 'dispatch', where: TRUE };
const grant = (model: string, output = 'default'): ModelAuthority => ({
	read: {
		[output]: Object.fromEntries(
			Object.keys(present(present(exposures[model]).outputs[output])).map((path) => [path, [arm]])
		)
	},
	create: [],
	update: [],
	delete: [],
	moves: {}
});
const dispatch = grant('jobs', 'dispatch');
const caller = (
	models: { [c: string]: ModelAuthority } = {
		jobs: dispatch,
		members: grant('members'),
		job_lines: grant('job_lines')
	}
): Authority => ({
	key: 'k',
	admin: false,
	policies: ['dispatch'],
	models,
	automations: [],
	limits: [],
	teamTree: [],
	scopes: {},
	capabilities: { apps: [], syncs: [], tools: [], mcp: [] },
	actor: {
		kind: 'member',
		id: 'u1',
		email: null,
		phone: null,
		external: false,
		teams: [],
		team_path: [],
		admin: false,
		party: null
	}
});

const AT = { today: '2026-09-26', now: '2026-09-26T00:00:00.000Z' };
let queryCrossings = 0;
const queryDb = TenantDb.typed({
	read: (statements) =>
		Effect.sync(() => {
			queryCrossings++;
			return statements.map(() => ({ rows: [], affected: 0 }));
		}),
	write: () => Effect.fail(DbError.make('XX000', 'A read validation must not write.')),
	transaction: () => Effect.fail(DbError.make('XX000', 'A read validation must not transact.'))
});
const reader = read_engine({ manifest, db: queryDb });
const query = (where: Json, order_by?: Json, authority = caller(), raw = false) =>
	Effect.gen(function* () {
		const ir = yield* lower_read(manifest, 'query', [
			{
				jobs: {
					where: raw
						? where
						: yield* Effect.try({ try: () => materialize(where, AT), catch: (error) => error }),
					fields: ['id'],
					limit: 1,
					output: viewOutput(manifest, authority, 'jobs') ?? 'default',
					...(order_by === undefined ? {} : { order_by })
				}
			}
		]);
		return yield* reader.run([ir], { as: 'caller', authority }, { ...AT, tz: 'Asia/Singapore' });
	});
const acceptsQuery = (where: Json, order_by?: Json, authority = caller()) =>
	Effect.gen(function* () {
		const before = queryCrossings;
		expect(yield* query(where, order_by, authority)).toEqual([{ jobs: { rows: [], next: null } }]);
		expect(queryCrossings).toBe(before + 1);
	});
const refusesQuery = (
	where: Json,
	message: RegExp = /./s,
	order_by?: Json,
	authority = caller(),
	raw = false
) =>
	Effect.gen(function* () {
		const before = queryCrossings;
		const error = yield* Effect.flip(query(where, order_by, authority, raw));
		expect(error).toEqual(expect.objectContaining({ message: expect.stringMatching(message) }));
		expect(queryCrossings).toBe(before);
	});

describe('the real read boundary strictly validates the query shape the planner must obey', () => {
	it.effect(
		'refuses hidden fields, fields omitted by the caller output, unexposed relations and unknown fields',
		() =>
			Effect.gen(function* () {
				yield* refusesQuery(
					{ internal_code: { eq: 'X1' } },
					/'jobs' has no readable field 'internal_code'/
				);
				yield* refusesQuery({ notes: { like: '%pump%' } }, /'jobs' has no readable field 'notes'/);
				yield* refusesQuery(
					{ audit: { is: { note: { eq: 'x' } } } },
					/'jobs' declares no read layer 'audit'/
				);
				yield* refusesQuery(
					{ assignee: { is: { rate: { gt: 10 } } } },
					/'jobs\.assignee' has no readable field 'rate'/
				);
				yield* refusesQuery({ bogus: { eq: 1 } }, /unknown field/);
			})
	);

	it.effect('accepts one-relation, any/all/none, count and child aggregate predicates', () =>
		Effect.gen(function* () {
			yield* acceptsQuery({ assignee: { is: { name: { like: '%bob%' } } } });
			yield* acceptsQuery({ lines: { some: { qty: { gt: 2 } } } });
			yield* acceptsQuery({ lines: { every: { amount: { gte: 10 } } } });
			yield* acceptsQuery({ lines: { none: { item: { eq: 'pump' } } } });
			yield* acceptsQuery({
				and: [{ lines: { count: { gt: 1 } } }, { lines: { sum: { of: 'amount', gte: 100 } } }]
			});
		})
	);

	it.effect('accepts canonical membership and empty lists; refuses retired predicate sugar', () =>
		Effect.gen(function* () {
			yield* acceptsQuery({ not: { hours: { in: [1, 2] } } });
			yield* acceptsQuery({ and: [{ tags: { has: 'pump' } }, { tags: { has: 'repair' } }] });
			yield* acceptsQuery({ tags: { eq: [] } });
			const retired: readonly Json[] = [
				{ hours: { nin: [1, 2] } },
				{ tags: { hasAny: ['pump', 'repair'] } },
				{ tags: { hasAll: ['pump', 'repair'] } },
				{ tags: { isEmpty: true } }
			];
			for (const condition of retired) yield* refusesQuery(condition);
		})
	);

	it.effect(
		'admits declared relation layers under the root grant without a separate target-root grant',
		() =>
			Effect.gen(function* () {
				const noMembers = caller({ jobs: grant('jobs') });
				yield* acceptsQuery({ assignee: { is: { name: { eq: 'Bob' } } } }, undefined, noMembers);
				yield* refusesQuery(
					{ audit: { is: { note: { eq: 'x' } } } },
					/'jobs' declares no read layer 'audit'/
				);
				yield* acceptsQuery(
					{ assignee: { eq: '00000000-0000-4000-8000-000000000001' } },
					undefined,
					noMembers
				);
			})
	);

	it.effect(
		'binds requestor/time variables and refuses invalid dates, expressions and the retired clock spelling',
		() =>
			Effect.gen(function* () {
				yield* acceptsQuery({
					scheduled_on: { gte: { var: 'today - days(7)' }, lt: { var: 'today + days(1)' } }
				});
				yield* acceptsQuery({ window: { contains: { var: 'today' } } });
				yield* refusesQuery({ scheduled_on: { eq: { var: 'now' } } }, /ISO date/);
				yield* refusesQuery({ scheduled_on: { eq: { var: 'today - hours(1)' } } }, /whole days/);
				yield* refusesQuery({ scheduled_on: { eq: { var: 'tomorrow' } } }, /Unknown variable/);
				yield* refusesQuery({ scheduled_on: { eq: { var: 'actor.email' } } }, /not a date/);
				yield* refusesQuery({ scheduled_on: { eq: { clock: 'today' } } });
				yield* acceptsQuery({ title: { eq: { var: 'actor.id' } } });
				yield* refusesQuery(
					{ scheduled_on: { gte: { var: 'today - days(7)' } } },
					/materialize time before reading/,
					undefined,
					caller(),
					true
				);
			})
	);

	it.effect(
		'admits readable sort keys and refuses hidden, unexposed, unknown, dotted and over-limit sorts',
		() =>
			Effect.gen(function* () {
				yield* acceptsQuery({}, [{ scheduled_on: 'desc' }, { hours: 'asc' }]);
				yield* acceptsQuery({}, { assignee: 'asc' });
				yield* acceptsQuery({}, { assignee: { name: 'asc' } });
				yield* acceptsQuery({}, [{ assignee: { name: 'desc' } }, { title: 'asc' }]);
				yield* refusesQuery(
					{},
					/'members\.rate' is not a field this caller reads/,
					{ assignee: { rate: 'asc' } }
				);
				yield* refusesQuery(
					{},
					/order_by 'audit\.note': 'jobs' declares no read layer 'audit'/,
					{ audit: { note: 'asc' } }
				);
				yield* refusesQuery({}, /not sortable/, { assignee: { bogus: 'asc' } });
				yield* refusesQuery({}, /one \{ field/, { 'assignee.name': 'asc' });
				const bare = caller({ jobs: grant('jobs', 'bare'), members: grant('members') });
				yield* refusesQuery({}, /'jobs' has no readable field 'assignee'/, { assignee: 'asc' }, bare);
				yield* refusesQuery(
					{},
					/'jobs' declares no read layer 'assignee'/,
					{ assignee: { name: 'asc' } },
					bare
				);
				yield* refusesQuery({}, /'jobs' has no readable field 'notes'/, { notes: 'asc' });
				yield* refusesQuery(
					{},
					/'jobs' has no readable field 'internal_code'/,
					{ internal_code: 'asc' }
				);
				yield* refusesQuery({}, /at most 4 keys/, [
					'title',
					'hours',
					'status',
					'scheduled_on',
					'created_at'
				]);
			})
	);
});

const unlisted = async () => ({ models: [], default: '' });
type ToolTurn = readonly { readonly id?: string; readonly name: string; readonly input: Json }[];
const turn = (...calls: { name: string; input: Json; id?: string }[]): ToolTurn => calls;
const editSubmit = (answer: { where?: Json; order_by?: Json }) => {
	const ops: Json[] = [];
	if (answer.where !== undefined) ops.push({ path: '/where', set: answer.where });
	if (answer.order_by !== undefined) ops.push({ path: '/order_by', set: answer.order_by });
	return turn({ name: 'edit', input: { ops }, id: 'e1' }, { name: 'submit', input: {}, id: 's1' });
};

/** Scripted System 2 (`ai.infer`) port returning tool turns in sequence. */
function system2(
	turns: readonly (ToolTurn | ((request: AiRequest, signal: AbortSignal) => Promise<AiResponse>))[]
): AiPort['sys_2'] & { requests: AiRequest[] } {
	let i = 0;
	const requests: AiRequest[] = [];
	return {
		models: ['default', 'fast', 'strong'],
		catalog: unlisted,
		requests,
		async infer(request, signal) {
			requests.push(request);
			const next = turns[i++];
			if (next === undefined) throw new Error(`Unexpected extra infer call #${i}`);
			if (typeof next === 'function') return next(request, signal);
			return {
				content: '',
				tool_calls: next.map((c, idx) => ({
					id: c.id ?? `c${i}_${idx}`,
					name: c.name,
					input: c.input
				})),
				finish: 'tool',
				usage: { input: 100, output: 30 }
			};
		}
	};
}

const db = TenantDb.typed({
	read: () => Effect.fail(DbError.make('XX000', 'Unexpected filter fixture database read')),
	write: () => Effect.succeed({ rows: [], affected: 1 }),
	transaction: () => Effect.fail(DbError.make('XX000', 'Unexpected filter fixture transaction'))
});

const nativeDescriber = (
	sys2: AiPort['sys_2'] | typeof off,
	m: EngineManifest = manifest,
	read: ReadsShape['run'] = (batch) =>
		Effect.succeed(batch.map(() => ({ rows: [], next: null, total: 0 })))
) => {
	const ports = Layer.mergeAll(
		NodeCrypto.layer,
		Layer.succeed(Manifest, m),
		Layer.succeed(Reads, { run: read }),
		Layer.succeed(TenantDb, db),
		Logs.fromAbi({ write: () => {}, query: async () => [] }),
		Ai.fromAbi({ system1: off, system2: sys2, embed: off })
	);
	const native = filter_describe.pipe(Effect.provide(ports));
	return {
		describe: (input: Parameters<Effect.Success<typeof filter_describe>['describe']>[0]) =>
			Effect.flatMap(native, (service) => service.describe(input)),
		options: (input: Parameters<Effect.Success<typeof filter_describe>['options']>[0]) =>
			Effect.flatMap(native, (service) => service.options(input))
	};
};

const bindings = {
	now: '2026-09-26T00:00:00.000Z',
	today: '2026-09-26',
	tz: 'Asia/Singapore'
};

describe('filter.describe uses ai.infer over the caller exposure with strict validation and refuse tool', () => {
	it.effect('public options and exposed schema exclude hidden fields, omitted output fields and unexposed relations', () =>
		Effect.gen(function* () {
			const port = system2([editSubmit({ where: { status: { eq: 'open' } } })]);
			const filters = nativeDescriber(port);
			const opt = yield* filters.options({ model: 'jobs', authority: caller(), bindings });
			expect(opt.ok).toBe(true);
			if (opt.ok) {
				const labels = opt.fields.map((f) => f.label);
				expect(labels).not.toContain('Internal code');
				expect(labels).not.toContain('Notes');
				expect(labels.some((l) => l.includes('Audit'))).toBe(false);
				expect(labels).not.toContain('Assignee › Rate');
			}
			const r = yield* filters.describe({ model: 'jobs', text: 'open jobs', authority: caller(), bindings });
			expect(r).toMatchObject({ ok: true, where: { status: { eq: 'open' } } });
			const sys = present(port.requests[0]?.system);
			const schemaSection = sys.slice(sys.indexOf('## Exposed schema'));
			expect(schemaSection).not.toContain('"internal_code"');
			expect(schemaSection).not.toContain('"notes"');
			expect(schemaSection).not.toContain('"audit"');
			// assignee layer omits rate (manager layer has fields: 'all')
			expect(schemaSection).not.toContain('"assignee.rate"');
			// caller without access to the model fails before calling AI
			expect(
				yield* nativeDescriber(system2([])).describe({
					model: 'jobs',
					text: 'open',
					authority: caller({}),
					bindings
				})
			).toMatchObject({ ok: false, code: 'not_found' });
		})
	);

	it.effect('supports complex nested boolean compositions, multiple predicates per field, and multiple quantifiers on one relation', () =>
		Effect.gen(function* () {
			const complexWhere: Json = {
				and: [
					{
						or: [
							{ and: [{ status: { eq: 'open' } }, { hours: { gt: 8 } }] },
							{ and: [{ status: { eq: 'done' } }, { hours: { lt: 2 } }] }
						]
					},
					{ lines: { some: { and: [{ item: { like: '%pump%' } }, { qty: { gte: 2 } }] } } },
					{ lines: { none: { amount: { gt: 1000 } } } }
				]
			};
			const port = system2([
				editSubmit({
					where: complexWhere,
					order_by: [{ status: 'asc' }, { scheduled_on: 'desc' }]
				})
			]);
			const r = yield* nativeDescriber(port).describe({
				model: 'jobs',
				text: '(open with >8h OR done with <2h), has a pump line with qty >= 2, and no line over 1000, sort by status then newest',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({
				ok: true,
				where: complexWhere,
				order_by: [{ status: 'asc' }, { scheduled_on: 'desc' }]
			});
			expect(port.requests[0]?.reasoning_effort).toBe('low');
			// real read boundary also accepts the exact generated query
			if (r.ok) yield* acceptsQuery(present(r.where), r.order_by);
		})
	);

	it.effect('supports relative time variables, period operators, two-hop relations, and multi-key sorting', () =>
		Effect.gen(function* () {
			const where: Json = {
				and: [
					{ scheduled_on: { gte: { var: 'today' }, lt: { var: 'today + days(1)' } } },
					{ window: { contains: { var: 'today' } } },
					{ assignee: { is: { manager: { is: { name: { like: '%alice%' } } } } } }
				]
			};
			const order_by: Json = [{ assignee: { name: 'asc' } }, { hours: 'desc' }];
			const port = system2([editSubmit({ where, order_by })]);
			const r = yield* nativeDescriber(port).describe({
				model: 'jobs',
				text: 'today, window active today, manager alice, sort by assignee then highest hours',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({ ok: true, where, order_by });
			if (r.ok) yield* acceptsQuery(present(r.where), r.order_by);
		})
	);

	it.effect('refuses unexposed fields and UI-incompatible syntax on submit, feeds exact error back so model repairs', () =>
		Effect.gen(function* () {
			const port = system2([
				// Turn 1: tries unexposed field `notes`
				editSubmit({ where: { notes: { like: '%pump%' } } }),
				// Turn 2: tries UI-incompatible `like` without leading/trailing `%`
				editSubmit({ where: { title: { like: 'pump' } } }),
				// Turn 3: tries `not` nested inside `is` (UI `fromWhere` forbids it)
				editSubmit({ where: { assignee: { is: { not: { name: { eq: 'Bob' } } } } } }),
				// Turn 4: repairs cleanly
				editSubmit({ where: { not: { assignee: { is: { name: { eq: 'Bob' } } } } } })
			]);
			const r = yield* nativeDescriber(port).describe({
				model: 'jobs',
				text: 'jobs not assigned to Bob',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({
				ok: true,
				where: { not: { assignee: { is: { name: { eq: 'Bob' } } } } }
			});
			expect(port.requests).toHaveLength(4);
			expect(port.requests[1]?.messages.at(-1)).toMatchObject({
				content: { result: { error: expect.stringContaining("'jobs.notes' is not a field this caller reads") } }
			});
			expect(port.requests[2]?.messages.at(-1)).toMatchObject({
				content: { result: { error: expect.stringContaining("start and end with '%'") } }
			});
			expect(port.requests[3]?.messages.at(-1)).toMatchObject({
				content: { result: { error: expect.stringContaining("cannot be nested directly inside a one-relation 'is'") } }
			});
		})
	);

	it.effect('refuse tool passes the model error message directly back to the caller', () =>
		Effect.gen(function* () {
			const port = system2([
				turn({
					name: 'refuse',
					input: {
						message:
							"Jobs has no sortable 'pay' field. You can sort by Title, Hours, Scheduled on, or Assignee › Name."
					}
				})
			]);
			const r = yield* nativeDescriber(port).describe({
				model: 'jobs',
				text: 'sort by pay',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({
				ok: false,
				code: 'invalid',
				message:
					"Jobs has no sortable 'pay' field. You can sort by Title, Hours, Scheduled on, or Assignee › Name."
			});
		})
	);

	it.effect('lookup tool resolves named records on demand under caller authority and blocks unreadable models', () =>
		Effect.gen(function* () {
			let reads = 0;
			const bobId = '00000000-0000-4000-8000-000000000007';
			const streamed: unknown[] = [];
			const port = system2([
				// Turn 1: tries an unreadable model (`audits`) and a readable model (`members`)
				turn(
					{ name: 'lookup', input: { model: 'audits', query: 'x' }, id: 'l1' },
					{ name: 'lookup', input: { model: 'members', query: 'bob tan' }, id: 'l2' }
				),
				// Turn 2: builds filter from looked-up ID
				editSubmit({ where: { assignee: { is: { id: { eq: bobId } } } } })
			]);
			const r = yield* nativeDescriber(port, manifest, (batch) => {
				reads += batch.length;
				return Effect.succeed(batch.map(() => ({ rows: [{ id: bobId, name: 'Bob Tan' }], next: null, total: 1 })));
			}).describe({
				model: 'jobs',
				text: 'jobs for bob tan',
				authority: caller(),
				bindings,
				onStep: (step) => streamed.push(step)
			});
			expect(r).toMatchObject({
				ok: true,
				where: { assignee: { is: { id: { eq: bobId } } } }
			});
			expect(streamed.length).toBeGreaterThanOrEqual(4);
			expect(r.ok && r.steps?.some((s) => s.label.includes('Found 1 Members match'))).toBe(true);
			expect(reads).toBe(1);
			// audits lookup was refused without hitting DB
			expect(port.requests[1]?.messages.slice(-2)).toMatchObject([
				{ content: { id: 'l1', result: { error: expect.stringContaining('not readable') } } },
				{ content: { id: 'l2', result: { model: 'members', rows: [{ id: bobId, name: 'Bob Tan' }] } } }
			]);
		})
	);

	it.effect('describes a $local roster from its supplied fields without DB reads or lookup tool', () =>
		Effect.gen(function* () {
			let reads = 0;
			const port = system2([
				editSubmit({
					where: {
						and: [
							{ title: { like: '%pump%room%' } },
							{ hours: { gt: 3 } },
							{ active: { eq: true } }
						]
					},
					order_by: { hours: 'desc' }
				})
			]);
			const r = yield* nativeDescriber(port, manifest, (batch) => {
				reads += batch.length;
				return Effect.succeed(batch.map(() => ({ rows: [], next: null, total: 0 })));
			}).describe({
				model: '$local',
				text: 'active title contains "pump room" and hours over 3, highest hours first',
				localFields: [
					{ name: 'title', label: 'Title', kind: 'text' },
					{ name: 'hours', label: 'Hours', kind: 'number' },
					{ name: 'active', label: 'Active', kind: 'bool' }
				],
				authority: caller({}),
				bindings
			});
			expect(r).toMatchObject({
				ok: true,
				where: {
					and: [
						{ title: { like: '%pump%room%' } },
						{ hours: { gt: 3 } },
						{ active: { eq: true } }
					]
				},
				order_by: { hours: 'desc' }
			});
			expect(reads).toBe(0);
			expect(port.requests[0]?.tools?.map((t) => t.name)).not.toContain('lookup');
		})
	);

	it.effect('fails closed on unavailable AI, provider errors, and whole-deadline timeout', () =>
		Effect.gen(function* () {
			expect(
				yield* nativeDescriber(off).describe({
					model: 'jobs',
					text: 'open jobs',
					authority: caller(),
					bindings
				})
			).toMatchObject({ ok: false, code: 'unavailable' });

			const down = system2([
				async () => {
					throw new FacilityFailure({ kind: 'unsupported', message: 'not supported' });
				}
			]);
			expect(
				yield* nativeDescriber(down).describe({
					model: 'jobs',
					text: 'open jobs',
					authority: caller(),
					bindings
				})
			).toMatchObject({ ok: false, code: 'unsupported' });

			// stalled infer is interrupted at FILTER_DEADLINE_MS
			const slow = system2([
				(_req, signal) =>
					new Promise<AiResponse>((_, reject) => {
						signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
					})
			]);
			expect(
				yield* clock_probe(
					nativeDescriber(slow).describe({
						model: 'jobs',
						text: 'open jobs',
						authority: caller(),
						bindings
					}),
					31_000
				)
			).toMatchObject({ ok: false, code: 'timeout' });
		})
	);

	it.effect('supports inline JSON object and discriminated union filters in describe and options, rejecting bare not inside a union arm', () =>
		Effect.gen(function* () {
			const unionManifest: EngineManifest = {
				...manifest,
				models: {
					...manifest.models,
					terms: {
						description: 'Contract terms',
						record_label: 'record.label',
						fields: {
							label: { kind: 'text' },
							rate: {
								kind: 'json',
								optional: true,
								shape: {
									kind: 'union',
									by: 'unit',
									arms: {
										MONTHLY: { amount: { kind: 'number' } },
										HOURLY: { amount: { kind: 'number' } }
									}
								}
							}
						}
					}
				},
				exposures: {
					...manifest.exposures,
					terms: { outputs: { default: { terms: { fields: 'all' } } } }
				}
			};
			const termsAuthority = caller({
				terms: {
					read: { default: { terms: [arm] } },
					create: [],
					update: [],
					delete: [],
					moves: {}
				}
			});
			const port = system2([
				// Turn 1: tries bare `not` inside union arm (rejected for UI compatibility)
				editSubmit({ where: { rate: { MONTHLY: { not: { amount: { eq: 3000 } } } } } }),
				// Turn 2: repairs to valid arm range + ne
				editSubmit({ where: { rate: { MONTHLY: { amount: { gt: 5000 } } } } })
			]);
			const filters = nativeDescriber(port, unionManifest);
			const opt = yield* filters.options({ model: 'terms', authority: termsAuthority, bindings });
			expect(opt.ok).toBe(true);
			if (opt.ok) {
				const labels = opt.fields.map((f) => f.label);
				expect(labels).toContain('Rate › Unit');
				expect(labels).toContain('Rate (MONTHLY) › Amount');
			}
			const r = yield* filters.describe({
				model: 'terms',
				text: 'monthly pay over 5000',
				authority: termsAuthority,
				bindings
			});
			expect(r).toMatchObject({ ok: true, where: { rate: { MONTHLY: { amount: { gt: 5000 } } } } });
			expect(port.requests).toHaveLength(2);
			expect(port.requests[1]?.messages.at(-1)).toMatchObject({
				content: { result: { error: expect.stringContaining("bare 'not' inside a union arm") } }
			});
		})
	);
});
