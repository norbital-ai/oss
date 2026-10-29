// AI filtering's schema and strict decode (rule 16a, P34, P35) without a database: the options System 1 chooses among
// are the caller's exposure (own fields, one hop through exposed relations: `is`, has any / all / none, count, child
// aggregates) and nothing else, and `decodeDescribed` refuses any field, relation or sort key outside it.
import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import type { Arm, Authority, ModelAuthority } from '../src/engine/contracts.ts';
import { Effect, Layer, Schema } from 'effect';
import { Ai, Logs } from '../src/engine/ports.ts';
import { off } from '../src/facilities/index.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Manifest, Reads, type ReadsShape } from '../src/engine/services.ts';
import { DbError } from '../src/engine/errors.ts';
import { DecisionsLive } from '../src/engine/decisions/index.ts';
import { catalogFor, type Pred } from '@norbital-ai/store';
import { viewOutput } from '../src/engine/access/authority.ts';
import { storeSync } from '../src/protocol/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type {
	DecisionAnswer,
	DecisionQuestion,
	System1Port,
	System1Request
} from '../src/engine/decisions/index.ts';
import { decodeDescribed, filterDescribe, literals } from '../src/engine/filter-describe/index.ts';
import { catalog } from '../src/protocol/catalog.ts';

const manifest = {
	workspace: { tz: 'Asia/Singapore', locale: 'en' },
	models: {
		members: {
			description: 'm',
			label: 'name',
			fields: { name: { kind: 'text' }, rate: { kind: 'money' } }
		},
		audits: { description: 'a', label: 'note', fields: { note: { kind: 'text' } } },
		jobs: {
			description: 'j',
			label: 'title',
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
			label: 'item',
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
		members: { read: { members: { fields: 'all' } } },
		job_lines: { read: { job_lines: { fields: 'all' } } },
		// `internal_code` is not exposed; `audits` is no model at all and `jobs.audit` no layer: a `where` hops only the
		// layers jobs' output declares, read under jobs' own arms. `dispatch` omits `notes` and the assignee's `rate`;
		// `bare` declares no layer and no `assignee`.
		jobs: {
			outputs: {
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
			},
			read: {
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
			}
		}
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};
const cat = catalog(manifest);

const TRUE: Pred = { t: 'const', value: true };
const arm: Arm = { policy: 'dispatch', where: TRUE };
const grant = (model: string, output = 'default'): ModelAuthority => ({
	read: { [output]: { [model]: [arm] } },
	history: [],
	create: [],
	update: [],
	delete: [],
	moves: {}
});
/** A dispatcher: reads jobs' `dispatch` output (no notes; no rate on its assignee layer), members and job lines. */
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
	capabilities: { apps: [], tools: [], mcp: [], skills: [] },
	actor: {
		kind: 'member',
		id: 'u1',
		email: null,
		phone: null,
		external: false,
		teams: [],
		teamPath: [],
		admin: false,
		party: null
	}
});
/** The read's own day and instant: what a described filter's time variables are. */
const AT = { today: '2026-09-26', now: '2026-09-26T00:00:00.000Z' };
const decode =
	(where: Json, orderBy?: Json, a = caller()) =>
	() =>
		decodeDescribed(
			storeSync(catalogFor(cat, 'jobs', viewOutput(manifest, a, 'jobs'))),
			a,
			'jobs',
			{ where, ...(orderBy === undefined ? {} : { orderBy }) },
			AT
		);

describe("decodeDescribed: the caller's exposed query shape, exactly", () => {
	it('refuses a field outside the exposure, a field its view output omits and an unexposed relation', () => {
		expect(decode({ internal_code: { eq: 'X1' } })).toThrow(/not a field this caller reads/);
		expect(decode({ notes: { like: '%pump%' } })).toThrow(/not a field this caller reads/);
		expect(decode({ audit: { is: { note: { eq: 'x' } } } })).toThrow(
			/is not read by this caller|is not a relation this caller reads/
		);
		expect(decode({ assignee: { is: { rate: { gt: 10 } } } })).toThrow(/jobs\.assignee\.rate/); // the output's layer omits it
		expect(decode({ bogus: { eq: 1 } })).toThrow(/unknown field/); // the grammar's own refusal
	});

	it('accepts relation filters: one-relation `is`, has any / all / none, count and a child aggregate', () => {
		expect(decode({ assignee: { is: { name: { like: '%bob%' } } } })).not.toThrow();
		expect(decode({ lines: { some: { qty: { gt: 2 } } } })).not.toThrow();
		expect(decode({ lines: { every: { amount: { gte: 10 } } } })).not.toThrow();
		expect(decode({ lines: { none: { item: { eq: 'pump' } } } })).not.toThrow();
		expect(
			decode({
				and: [{ lines: { count: { gt: 1 } } }, { lines: { sum: { of: 'amount', gte: 100 } } }]
			})
		).not.toThrow();
	});

	it("reads a layer under its root's policies; refuses a relation the read declares no layer for", () => {
		const noMembers = caller({ jobs: grant('jobs') });
		expect(
			decode({ assignee: { is: { name: { eq: 'Bob' } } } }, undefined, noMembers)
		).not.toThrow();
		expect(decode({ audit: { is: { note: { eq: 'x' } } } })).toThrow(
			/'jobs\.audit' is not a relation this caller reads/
		);
		expect(
			decode({ assignee: { eq: '00000000-0000-4000-8000-000000000001' } }, undefined, noMembers)
		).not.toThrow(); // the key itself is jobs'
	});

	it('takes the variables: the requestor bound by the read, today and now materialized; a bad expression is refused', () => {
		expect(
			decode({
				scheduled_on: {
					gte: { var: 'today - days(7)' },
					lt: { var: 'today + days(1)' }
				}
			})
		).not.toThrow();
		expect(decode({ window: { contains: { var: 'today' } } })).not.toThrow();
		expect(decode({ scheduled_on: { eq: { var: 'now' } } })).toThrow(/ISO date/); // an instant is no date
		expect(decode({ scheduled_on: { eq: { var: 'today - hours(1)' } } })).toThrow(/whole days/);
		expect(decode({ scheduled_on: { eq: { var: 'tomorrow' } } })).toThrow(/Unknown variable/);
		expect(decode({ scheduled_on: { eq: { var: 'requestor.email' } } })).toThrow(/not a date/);
		expect(decode({ scheduled_on: { eq: { clock: 'today' } } })).toThrow(); // the former spelling
		expect(decode({ title: { eq: { var: 'requestor.id' } } })).not.toThrow();
	});

	it('sorts where OrderBy allows: own sortable fields, a one-relation (by id), a related field its output reads, at most 4 keys', () => {
		expect(decode({}, [{ scheduled_on: 'desc' }, { hours: 'asc' }])).not.toThrow();
		expect(decode({}, { assignee: 'asc' })).not.toThrow(); // the relation's key
		expect(decode({}, { assignee: { name: 'asc' } })).not.toThrow(); // through an exposed relation, a readable target field
		expect(decode({}, [{ assignee: { name: 'desc' } }, { title: 'asc' }])).not.toThrow();
		expect(decode({}, { assignee: { rate: 'asc' } })).toThrow(/jobs\.assignee\.rate/); // the output's layer omits it: no ordering by it either
		expect(decode({}, { audit: { note: 'asc' } })).toThrow(
			/is not read by this caller|is not a relation this caller reads/
		); // unexposed relation
		expect(decode({}, { assignee: { bogus: 'asc' } })).toThrow(/not sortable/); // the grammar's own refusal
		expect(decode({}, { 'assignee.name': 'asc' })).toThrow(/one \{ field/); // one grammar: nested keys, not a dotted string
		expect(
			decode(
				{},
				{ assignee: 'asc' },
				caller({ jobs: grant('jobs', 'bare'), members: grant('members') })
			)
		).toThrow(/not a field this caller reads/);
		expect(
			decode(
				{},
				{ assignee: { name: 'asc' } },
				caller({ jobs: grant('jobs', 'bare'), members: grant('members') })
			)
		).toThrow(/is not read by this caller|is not a relation this caller reads/);
		expect(decode({}, { notes: 'asc' })).toThrow(/not a field this caller reads/);
		expect(decode({}, { internal_code: 'asc' })).toThrow(/not a field this caller reads/);
		expect(decode({}, ['title', 'hours', 'status', 'scheduled_on', 'created_at'])).toThrow(
			/at most 4 keys/
		);
	});
});

/** A scripted System 1: `pick` names the chosen option per question; others take their first option (or false). */
function system1(pick: (r: System1Request) => { readonly [id: string]: string | boolean }) {
	const answer = (q: DecisionQuestion, v: string | boolean | undefined): DecisionAnswer => {
		if (q.type === 'noul') return { type: 'noul', noul: v === true ? 0.9 : 0.1 };
		const choice =
			q.type === 'choice' ? (typeof v === 'string' ? v : present(Object.keys(q.criteria)[0])) : '';
		return q.type === 'choice'
			? { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }
			: { type: 'score', score: 0, level: 0, confidence: 0.9, probabilities: {}, legend: {} };
	};
	const port: System1Port & { requests: System1Request[] } = {
		requests: [],
		async ask(r) {
			port.requests.push(r);
			const chosen = pick(r);
			return {
				costUsd: 0,
				provider: 'scripted',
				answers: Object.fromEntries(
					Object.entries(r.questions).map(([id, q]) => [id, answer(q, chosen[id])])
				)
			};
		}
	};
	return port;
}
const db = TenantDb.typed({
	read: () => Effect.fail(DbError.make('XX000', 'Unexpected filter fixture database read')),
	write: () => Effect.succeed({ rows: [], affected: 1 }),
	session: () =>
		Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
	transaction: () => Effect.fail(DbError.make('XX000', 'Unexpected filter fixture transaction'))
});
const nativeDescriber = (
	port: System1Port,
	m: EngineManifest = manifest,
	read: ReadsShape['run'] = (batch) => Effect.succeed(batch.map(() => ({ rows: [] })))
) => {
	const ports = Layer.mergeAll(
		NodeCrypto.layer,
		Layer.succeed(Manifest, m),
		Layer.succeed(Reads, { run: read }),
		Layer.succeed(TenantDb, db),
		Logs.fromAbi({ write: () => {}, query: async () => [] }),
		Ai.fromAbi({
			system1: port,
			system2: {
				models: ['x'],
				infer: async () => {
					throw new Error('System 2 is never asked (P35)');
				}
			},
			embed: off
		})
	);
	const native = filterDescribe.pipe(Effect.provide(DecisionsLive.pipe(Layer.provideMerge(ports))));
	return {
		describe: (input: Parameters<Effect.Success<typeof filterDescribe>['describe']>[0]) =>
			Effect.flatMap(native, (service) => service.describe(input)),
		options: (input: Parameters<Effect.Success<typeof filterDescribe>['options']>[0]) =>
			Effect.flatMap(native, (service) => service.options(input))
	};
};
const describer = (port: System1Port) => nativeDescriber(port);
const bindings = {
	now: '2026-09-26T00:00:00.000Z',
	today: '2026-09-26',
	tz: 'Asia/Singapore'
};
const choices = (q: DecisionQuestion | undefined) =>
	q?.type === 'choice' ? Object.keys(q.criteria) : [];
/** The field a `f1`-shaped question is about: the state's Nth field. */
const labelOf = (r: System1Request, id: string) =>
	present(
		Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ label: Schema.String })))(
			r.state['fields']
		)[Number(id.slice(1)) - 1]
	).label;
/** Every field label the one request asked about, in the order it asked. */
const askedFields = (r: System1Request) =>
	Object.keys(r.questions)
		.filter((id) => /^f\d+$/.test(id))
		.map((id) => labelOf(r, id));
/**
 * A scripted answer in the request's own shape: per field the whole condition the description states ("Title contains
 * “pump”"), or none when the plan omits the field. A list operator names its values, each its own yes / no.
 */
type Plan = {
	readonly [label: string]: { op: string; value?: string; values?: readonly string[] } | false;
};
const byField =
	(plan: Plan, extra: { [id: string]: string | boolean } = {}) =>
	(r: System1Request) => {
		const pick: { [id: string]: string | boolean } = { ...extra };
		for (const [id, q] of Object.entries(r.questions)) {
			if (q.type !== 'choice' || !/^f\d+$/.test(id)) continue;
			const label = labelOf(r, id),
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

describe('filter.describe offers System 1 the exposure and maps its choices onto the grammar', () => {
	it.effect(
		'a phrase a found record holds is read once, loosely, through its relation; "not" before it negates it; its words echo nowhere else',
		() =>
			Effect.gen(function* () {
				// members declare a search: the lookup reads their search document and every searched text field
				const searchable = {
					...manifest,
					models: {
						...manifest.models,
						members: { ...manifest.models.members, search: { text: ['name'] } }
					},
					needs: []
				} satisfies EngineManifest;
				const found = (port: System1Port) =>
					nativeDescriber(port, searchable, (batch) =>
						Effect.succeed(
							batch.map((q) => ({
								rows: 'model' in q && q.model === 'members' ? [{ id: 'm1', name: 'Bob Tan' }] : []
							}))
						)
					);
				const reading = 'one whose Name contains \u201cbob tan\u201d';
				for (const [text, op, where] of [
					['jobs for bob tan', 'is', { assignee: { is: { name: { like: '%bob%tan%' } } } }],
					[
						'jobs not for bob tan',
						'is not',
						{ not: { assignee: { is: { name: { like: '%bob%tan%' } } } } }
					]
				] as const) {
					// System 1 also says Title contains the echoed "bob": a word the found phrase already reads is no second condition
					const port = system1(
						byField({ Assignee: { op, value: reading }, Title: { op: 'contains', value: 'bob' } })
					);
					expect(
						yield* found(port).describe({ model: 'jobs', text, authority: caller(), bindings })
					).toEqual({ ok: true, where });
				}
			})
	);

	it.effect(
		'a description that states nothing is a refusal, never an empty filter reported as applied (staging: "dsajdasomda")',
		() =>
			Effect.gen(function* () {
				const r = yield* describer(system1(byField({}))).describe({
					model: 'jobs',
					text: 'dsajdasomda',
					authority: caller(),
					bindings
				});
				expect(r).toMatchObject({
					ok: false,
					message: expect.stringMatching(/No field here matches/)
				});
			})
	);

	it.effect(
		'one condition is never negated by the composition: its own operator says "is not" (staging: "jobs at 1F Pine Grove" → not)',
		() =>
			Effect.gen(function* () {
				const plan = byField(
					{ Title: { op: 'contains', value: 'pump' } },
					{ combine: 'none of them hold' }
				);
				expect(
					yield* describer(system1(plan)).describe({
						model: 'jobs',
						text: 'title contains pump',
						authority: caller(),
						bindings
					})
				).toEqual({ ok: true, where: { title: { like: '%pump%' } } });
				const two = byField(
					{ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } },
					{ combine: 'none of them hold' }
				);
				expect(
					yield* describer(system1(two)).describe({
						model: 'jobs',
						text: 'neither pump titles nor done',
						authority: caller(),
						bindings
					})
				).toMatchObject({ ok: true, where: { not: { or: expect.any(Array) } } });
			})
	);

	it.effect(
		'a presence-only field offers presence alone (staging: "site location contains …" → location is not empty)',
		() =>
			Effect.gen(function* () {
				const port = system1(byField({ Title: { op: 'contains', value: 'pump' } }));
				const r = yield* describer(port).describe({
					model: 'jobs',
					text: 'spot title contains pump',
					authority: caller(),
					bindings
				});
				expect(r).toEqual({ ok: true, where: { title: { like: '%pump%' } } });
				const q = present(port.requests[0]).questions;
				const spot = present(
					Object.keys(q).find(
						(id) => /^f\d+$/.test(id) && labelOf(present(port.requests[0]), id) === 'Spot'
					)
				);
				expect(choices(q[spot])).toEqual(['no condition', 'Spot is empty', 'Spot is not empty']);
			})
	);

	it.effect('describes a local roster from its supplied fields without a model read', () =>
		Effect.gen(function* () {
			const port = system1(
				byField({ Number: { op: 'more than', value: '20' } }, { sort: 'Name, A to Z' })
			);
			const fields = [
				{ name: 'number', label: 'Number', kind: 'number' as const },
				{ name: 'name', label: 'Name', kind: 'text' as const }
			];
			const r = yield* describer(port).describe({
				model: '$local',
				text: 'people numbered above 20, by name',
				localFields: fields,
				authority: caller({}),
				bindings
			});
			expect(r).toEqual({ ok: true, where: { number: { gt: 20 } }, orderBy: { name: 'asc' } });
			expect(askedFields(present(port.requests[0]))).toEqual(['Number', 'Name']);
		})
	);
	it.effect(
		"the field options are the caller's exposure: own fields, one hop through an exposed relation, nothing else",
		() =>
			Effect.gen(function* () {
				// no `jobs.lines` layer, so nothing many-relation is offered and every readable field fits the bound
				const { 'jobs.lines': _, ...narrow } = manifest.exposures.jobs.outputs.dispatch;
				const port = system1(byField({}));
				yield* nativeDescriber(port, {
					...manifest,
					exposures: {
						...manifest.exposures,
						jobs: { ...manifest.exposures.jobs, outputs: { dispatch: narrow } }
					}
				}).describe({
					model: 'jobs',
					text: 'jobs with more than 2 pumps',
					authority: caller({ jobs: dispatch }),
					bindings
				});
				const fields = askedFields(present(port.requests[0]));
				// a field with no condition to offer is not asked (no Assignee record was found, so `Assignee` itself has none)
				expect(fields).toEqual(
					expect.arrayContaining([
						'Title',
						'Status',
						'Assignee › Name',
						'Hours',
						'Scheduled on',
						'Window'
					])
				);
				for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate'])
					expect(fields).not.toContain(hidden);
				expect(fields.some((f) => f.startsWith('Audit'))).toBe(false);
				expect(fields.some((f) => f.startsWith('Lines'))).toBe(false);
				// sorting: own fields and, one hop through a one-relation, the output's target fields; never a many-relation
				const sorts = choices(present(port.requests[0]).questions['sort']);
				expect(sorts).toEqual(
					expect.arrayContaining([
						'Title, A to Z',
						'Scheduled on, latest first',
						'Assignee › Name, Z to A'
					])
				);
				for (const no of ['Notes', 'Assignee › Rate', 'Lines (any) › Qty', 'Number of lines'])
					expect(sorts.some((x) => x.startsWith(`${no}, `))).toBe(false);
			})
	);

	it.effect('a wide model is bounded, and what the caller cannot read is never offered', () =>
		Effect.gen(function* () {
			const port = system1(byField({}));
			yield* describer(port).describe({
				model: 'jobs',
				text: 'jobs with more than 2 pumps',
				authority: caller(),
				bindings
			});
			const asked = present(port.requests[0]);
			// job_lines granted opens a many-relation: three quantifiers over its fields, its count and eight aggregates
			expect(askedFields(asked).length).toBe(16);
			for (const hidden of ['Notes', 'Internal code', 'Assignee › Rate', 'Audit']) {
				expect(
					Object.values(asked.questions)
						.flatMap((q) => choices(q))
						.some((o) => o.startsWith(`${hidden} `))
				).toBe(false);
			}
		})
	);

	it.effect('a related condition and an own sort decode to a relation Where and an OrderBy', () =>
		Effect.gen(function* () {
			const port = system1(
				byField(
					{ 'Lines (any) › Qty': { op: 'more than', value: '2' } },
					{ sort: 'Scheduled on, latest first' }
				)
			);
			const r = yield* describer(port).describe({
				model: 'jobs',
				text: 'jobs with more than 2 of any line, latest first',
				authority: caller(),
				bindings
			});
			expect(r).toEqual({
				ok: true,
				where: { lines: { some: { qty: { gt: 2 } } } },
				orderBy: { scheduled_on: 'desc' }
			});
		})
	);

	it.effect('"today" stays the today clock operand, so a kept filter rolls with the day', () =>
		Effect.gen(function* () {
			const port = system1(byField({ 'Scheduled on': { op: 'is within', value: 'today' } }));
			const r = yield* describer(port).describe({
				model: 'jobs',
				text: 'jobs scheduled today',
				authority: caller(),
				bindings
			});
			expect(r).toEqual({
				ok: true,
				where: { scheduled_on: { gte: { var: 'today' }, lt: { var: 'today + days(1)' } } }
			});
		})
	);

	it.effect('a related sort decodes to a nested OrderBy key', () =>
		Effect.gen(function* () {
			const port = system1(
				byField({ Title: { op: 'contains', value: 'pump' } }, { sort: 'Assignee › Name, A to Z' })
			);
			const r = yield* describer(port).describe({
				model: 'jobs',
				text: 'pump jobs by assignee name',
				authority: caller(),
				bindings
			});
			expect(r).toEqual({
				ok: true,
				where: { title: { like: '%pump%' } },
				orderBy: { assignee: { name: 'asc' } }
			});
		})
	);

	it.effect("the sort's own words are never offered as a text value", () =>
		Effect.gen(function* () {
			const port = system1(byField({}));
			yield* describer(port).describe({
				model: 'jobs',
				text: 'pump jobs, sorted by title descending',
				authority: caller(),
				bindings
			});
			const values = Object.values(present(port.requests[0]).questions).flatMap((q) => choices(q));
			expect(values.some((v) => v.endsWith('\u201cpump\u201d'))).toBe(true);
			for (const w of ['sorted', 'descending'])
				expect(values.some((v) => v.endsWith(`\u201c${w}\u201d`))).toBe(false);
		})
	);

	it.effect(
		'a date period is offered: in force today, or overlapping a span (staging: "started in 2024" fell to created_at)',
		() =>
			Effect.gen(function* () {
				const today = system1(byField({ Window: { op: 'in force on', value: 'today' } }));
				expect(
					yield* describer(today).describe({
						model: 'jobs',
						text: 'jobs in force today',
						authority: caller(),
						bindings
					})
				).toEqual({ ok: true, where: { window: { contains: { var: 'today' } } } });
				const year = system1(byField({ Window: { op: 'overlaps', value: 'this year' } }));
				expect(
					yield* describer(year).describe({
						model: 'jobs',
						text: 'jobs running at any time this year',
						authority: caller(),
						bindings
					})
				).toEqual({
					ok: true,
					where: {
						window: { overlaps: { from: '2026-01-01', to: '2026-12-31' } }
					}
				});
				// a period's first day in a span: "started this year" (a joined date), never the record's `created_at`
				const started = system1(byField({ Window: { op: 'starts within', value: 'this year' } }));
				expect(
					yield* describer(started).describe({
						model: 'jobs',
						text: 'jobs that started this year',
						authority: caller(),
						bindings
					})
				).toEqual({
					ok: true,
					where: { window: { startsWithin: { from: '2026-01-01', to: '2026-12-31' } } }
				});
			})
	);

	it.effect('a child aggregate condition decodes to the aggregate grammar', () =>
		Effect.gen(function* () {
			const port = system1(byField({ 'Lines › total amount': { op: 'at least', value: '500' } }));
			const r = yield* describer(port).describe({
				model: 'jobs',
				text: 'jobs whose lines total at least 500',
				authority: caller(),
				bindings
			});
			expect(r).toEqual({ ok: true, where: { lines: { sum: { of: 'amount', gte: 500 } } } });
		})
	);

	it.effect(
		"the builder's grammar is the catalogue: many-valued fields, in/nin, null tests, two hops",
		() =>
			Effect.gen(function* () {
				const r = yield* describer(system1(byField({}))).options({
					model: 'jobs',
					authority: caller(),
					bindings
				});
				if (!r.ok) throw new Error(r.message);
				const ops = (label: string) => r.fields.filter((f) => f.label === label).map((f) => f.op);
				const path = (label: string) => r.fields.find((f) => f.label === label)?.path;
				// a many-valued field offers the builder's list operators (ir's grammar), never a comparison on the list itself
				expect(ops('Tags')).toEqual(['has', 'hasAny', 'hasAll', 'isEmpty', 'notEmpty']);
				expect(path('Tags')).toEqual([{ k: 'field', name: 'tags' }]);
				// `in`/`nin` and the null tests are offered; a field the view output omits never is
				expect(ops('Hours')).toEqual(
					expect.arrayContaining(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'])
				);
				expect(ops('Window')).toEqual([
					'contains',
					'overlaps',
					'within',
					'startsWithin',
					'endsWithin',
					'isNull',
					'notNull'
				]);
				expect(ops('Notes')).toEqual([]); // `dispatch` omits it
				expect(r.fields.some((f) => f.label === 'Internal code')).toBe(false);
				// two relation hops: `jobs.assignee.manager.name`, with its own sort key
				expect(path('Assignee › Manager › Name')).toEqual([
					{ k: 'is', rel: 'assignee' },
					{ k: 'is', rel: 'manager' },
					{ k: 'field', name: 'name' }
				]);
				expect(r.fields.find((f) => f.label === 'Assignee › Name')?.sort).toBe('assignee.name');
				// a many-relation's quantifiers, count and child aggregates, and a date period's own operators
				expect(ops('Lines (any) › Qty')).toEqual(expect.arrayContaining(['eq', 'gt']));
				expect(ops('Number of lines')).toEqual(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
				expect(path('Lines › total amount')).toEqual([
					{ k: 'agg', rel: 'lines', fn: 'sum', of: 'amount' }
				]);
				expect(ops('Window')).toEqual([
					'contains',
					'overlaps',
					'within',
					'startsWithin',
					'endsWithin',
					'isNull',
					'notNull'
				]);
			})
	);

	it.effect('a two-hop relation choice folds to the nested `is` grammar in one call', () =>
		Effect.gen(function* () {
			const port = system1(
				byField({ 'Assignee › Manager › Name': { op: 'contains', value: 'pump' } })
			);
			const r = yield* describer(port).describe({
				model: 'jobs',
				text: 'manager name contains pump',
				authority: caller(),
				bindings
			});
			expect(r).toEqual({
				ok: true,
				where: { assignee: { is: { manager: { is: { name: { like: '%pump%' } } } } } }
			});
			expect(port.requests).toHaveLength(1);
		})
	);

	it.effect('any-of composition is OR when the text names a disjunction', () =>
		Effect.gen(function* () {
			const plan = byField(
				{ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } },
				{ combine: 'any of them hold' }
			);
			const r = yield* describer(system1(plan)).describe({
				model: 'jobs',
				text: 'pump jobs or done jobs',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({
				ok: true,
				where: {
					or: expect.arrayContaining([{ title: { like: '%pump%' } }, { status: { eq: 'done' } }])
				}
			});
			if (!r.ok) throw new Error(r.message);
			expect(
				Schema.decodeUnknownSync(Schema.Struct({ or: Schema.Array(Schema.Json) }))(r.where).or
			).toHaveLength(2);
		})
	);

	it.effect('any-of without a disjunction word stays AND (System 1 misreading the text)', () =>
		Effect.gen(function* () {
			const plan = byField(
				{ Title: { op: 'contains', value: 'pump' }, Status: { op: 'is', value: 'done' } },
				{ combine: 'any of them hold' }
			);
			const r = yield* describer(system1(plan)).describe({
				model: 'jobs',
				text: 'pump titles that are done',
				authority: caller(),
				bindings
			});
			expect(r).toMatchObject({
				ok: true,
				where: {
					and: expect.arrayContaining([{ title: { like: '%pump%' } }, { status: { eq: 'done' } }])
				}
			});
		})
	);
});

describe('described choices preserve scalar kinds', () => {
	it.effect('decodes boolean, enum and numeric choices in one filter', () =>
		Effect.gen(function* () {
			const kinds = {
				...manifest,
				models: {
					...manifest.models,
					jobs: {
						...manifest.models.jobs,
						fields: {
							...manifest.models.jobs.fields,
							urgent: { kind: 'bool' },
							priority: { kind: 'enum', values: ['low', 'normal', 'high'] },
							visits: { kind: 'int' }
						}
					}
				},
				exposures: {
					...manifest.exposures,
					jobs: {
						read: {
							jobs: {
								fields: [
									...manifest.exposures.jobs.read.jobs.fields,
									'urgent',
									'priority',
									'visits'
								]
							}
						}
					}
				}
			} satisfies EngineManifest;
			const port = system1(
				byField({
					Urgent: { op: 'is', value: 'yes' },
					Priority: { op: 'is', value: 'high' },
					Visits: { op: 'is', value: '3' }
				})
			);
			const result = yield* nativeDescriber(port, kinds).describe({
				model: 'jobs',
				authority: caller(),
				bindings,
				text: 'urgent high priority jobs with 3 visits'
			});
			expect(result).toMatchObject({
				ok: true,
				where: {
					and: expect.arrayContaining([
						{ urgent: { eq: true } },
						{ priority: { eq: 'high' } },
						{ visits: { eq: 3 } }
					])
				}
			});
		})
	);
});

describe('described selection must fit the exposed grammar', () => {
	const fields = [
		{ name: 'kind', label: 'Kind', kind: 'text' as const },
		{ name: 'version', label: 'Version', kind: 'number' as const }
	];
	it.effect(
		'refuses per-group latest selection instead of silently using global max or descending sort',
		() =>
			Effect.gen(function* () {
				const records = [
					{ kind: 'nda', version: 2 },
					{ kind: 'nda', version: 3 },
					{ kind: 'msa', version: 5 },
					{ kind: 'sow', version: 2 }
				];
				expect(records.filter((r) => r.version === 5)).toEqual([{ kind: 'msa', version: 5 }]);
				expect(
					[...new Set(records.map((r) => r.kind))].map((kind) =>
						records.filter((r) => r.kind === kind).reduce((a, b) => (a.version > b.version ? a : b))
					)
				).toEqual([
					{ kind: 'nda', version: 3 },
					{ kind: 'msa', version: 5 },
					{ kind: 'sow', version: 2 }
				]);
				const port = system1(
					byField(
						{ Version: { op: 'is', value: '5' } },
						{
							'selection.unsupported': true,
							sort: 'Version, highest first'
						}
					)
				);
				const r = yield* describer(port).describe({
					model: '$local',
					text: 'show latest version only for each kind, not merely the global version 5',
					localFields: fields,
					authority: caller({}),
					bindings
				});
				expect(r).toMatchObject({
					ok: false,
					code: 'invalid',
					message: expect.stringMatching(/comparing|ranking/)
				});
				expect(present(port.requests[0]).questions['selection.unsupported']).toMatchObject({
					type: 'noul',
					instructions: expect.stringMatching(/top-level records/)
				});
			})
	);
	it.effect('a sort-only description on a model has an OrderBy and no Where', () =>
		Effect.gen(function* () {
			const port = system1(byField({}, { sort: 'Scheduled on, latest first' }));
			expect(
				yield* describer(port).describe({
					model: 'jobs',
					text: 'latest first',
					authority: caller(),
					bindings
				})
			).toEqual({ ok: true, orderBy: { scheduled_on: 'desc' } });
		})
	);

	it.effect('allows ordinary newest-first sorting because ordering does not exclude versions', () =>
		Effect.gen(function* () {
			const port = system1(
				byField(
					{},
					{
						'selection.unsupported': false,
						sort: 'Version, highest first'
					}
				)
			);
			expect(
				yield* describer(port).describe({
					model: '$local',
					text: 'sort versions newest first',
					localFields: fields,
					authority: caller({}),
					bindings
				})
			).toMatchObject({ ok: true, orderBy: { version: 'desc' } });
		})
	);
	it.effect(
		'admits an explicitly exposed current flag instead of refusing latest wording by keyword',
		() =>
			Effect.gen(function* () {
				const port = system1(
					byField({ 'Is current': { op: 'is', value: 'yes' } }, { 'selection.unsupported': false })
				);
				const r = yield* describer(port).describe({
					model: '$local',
					text: 'latest versions only: current is true',
					localFields: [{ name: 'is_current', label: 'Is current', kind: 'bool' }],
					authority: caller({}),
					bindings
				});
				expect(r).toMatchObject({ ok: true, where: { is_current: { eq: true } } });
			})
	);
});

describe('a description fails closed', () => {
	it.effect('a failed System 1 call applies nothing', () =>
		Effect.gen(function* () {
			const down: System1Port = {
				ask: () => Promise.reject(new Error('provider down'))
			};
			expect(
				yield* describer(down).describe({
					model: 'jobs',
					text: 'jobs over 3 hours',
					authority: caller(),
					bindings
				})
			).toMatchObject({ ok: false, code: 'upstream' });
		})
	);
});

it('literals: quoted strings, numbers and dates from the text', () => {
	expect(
		literals(
			'jobs over 3 hours named "pump room" before 2026-10-01 or 5/10/2026',
			'en',
			'2026-10-08'
		)
	).toEqual({ strings: ['pump room'], numbers: [3], dates: ['2026-10-01', '2026-10-05'] });
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
