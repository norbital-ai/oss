// The production read-policy matrix (L-BOLT-229, ported from `access-structured-policy-matrix.integration.test.ts`) as
// a table on the new engine: each row's grant `Where` compiles through the query area (`toPred` → `whereSql`, the SQL
// every caller read conjoins, rule 13) and runs against allow/deny rows on PGlite. The rows over agent tables
// (conversation, plan, message, turn, usage, notification) are not here: those system models are the agents
// area's. `jsonPath` has no counterpart (rule 16: no `Where` reads json); the correction flag is a stored enum.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { catalogOf, toPred } from '../src/engine/access/pred.ts';
import type { Authority, Bindings, ModelAuthority, EngineActor } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { whereSql, type Pred } from '@norbital-ai/store';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { readOptions } from '../src/engine/query/reader.ts';
import { fromStore } from '../src/protocol/errors.ts';

const d = { description: 'x', label: 'name' };
const name = { name: { kind: 'text', optional: true } };
const models = {
	sites: { ...d, fields: name },
	jobs: { ...d, fields: name },
	job_assignments: {
		...d,
		fields: {
			...name,
			assignee: { kind: 'text' },
			suspicion_checked_at: { kind: 'instant', optional: true }
		}
	},
	variation_requests: { ...d, fields: name },
	photo_evidence: { ...d, fields: name },
	communication_logs: { ...d, fields: name },
	suspicious_activity_logs: { ...d, fields: name },
	employees: { ...d, fields: { ...name, email: { kind: 'text', format: 'email' } } },
	employments: { ...d, fields: name },
	payslips: { ...d, fields: name },
	loans: { ...d, fields: name },
	component_entries: {
		...d,
		fields: {
			...name,
			kind: { kind: 'enum', values: ['BONUS', 'MANUAL_ADJUSTMENT'], optional: true }
		}
	}
};
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models,
		relationships: {
			'jobs.site': { to: 'sites', inverse: 'jobs' },
			'job_assignments.job': { to: 'jobs', inverse: 'assignments' },
			'variation_requests.assignment': { to: 'job_assignments', inverse: 'variations' },
			'photo_evidence.assignment': { to: 'job_assignments', inverse: 'photos', optional: true },
			'photo_evidence.variation': { to: 'variation_requests', inverse: 'photos', optional: true },
			'communication_logs.assignment': { to: 'job_assignments', inverse: 'communications' },
			'suspicious_activity_logs.assignment': { to: 'job_assignments', inverse: 'suspicions' },
			'employments.employee': { to: 'employees', inverse: 'employments' },
			'payslips.employment': { to: 'employments', inverse: 'payslips' },
			'loans.employment': { to: 'employments', inverse: 'loans' },
			'component_entries.employment': { to: 'employments', inverse: 'entries' }
		},
		exposures: Object.fromEntries(
			Object.keys(models).map((c) => [c, { read: { [c]: { fields: 'all' } } }])
		),
		integrations: {},
		policies: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

// ── the grant predicates, in the new `Where` ──
const OWN = { assignee: { eq: { var: 'requestor.id' } } };
const UNCHECKED = { suspicion_checked_at: { isNull: true } };
const OWN_VARIATION = { assignment: { is: OWN } };
const OWN_EMPLOYMENT = { employee: { is: { email: { eq: { var: 'requestor.email' } } } } };
const NOT_A_CORRECTION = { kind: { ne: 'MANUAL_ADJUSTMENT' } };
type Row = {
	id: string;
	root: string;
	where: unknown;
	sql: readonly string[];
	allow: readonly string[];
	deny: readonly string[];
};
const matrix: readonly Row[] = [
	{
		id: 'field-operations.assigned-site',
		root: 'sites',
		where: { jobs: { some: { assignments: { some: OWN } } } },
		sql: ['EXISTS'],
		allow: ['site-owned'],
		deny: ['site-other']
	},
	{
		id: 'field-operations.assigned-job',
		root: 'jobs',
		where: { assignments: { some: OWN } },
		sql: ['EXISTS'],
		allow: ['job-owned'],
		deny: ['job-other']
	},
	{
		id: 'field-operations.own-variation',
		root: 'variation_requests',
		where: OWN_VARIATION,
		sql: ['EXISTS'],
		allow: ['variation-owned'],
		deny: ['variation-other']
	},
	{
		id: 'field-operations.own-evidence',
		root: 'photo_evidence',
		where: { or: [{ assignment: { is: OWN } }, { variation: { is: OWN_VARIATION } }] },
		sql: ['EXISTS', ' OR '],
		allow: ['evidence-direct-owned', 'evidence-variation-owned'],
		deny: ['evidence-other']
	},
	{
		id: 'field-operations.own-communication',
		root: 'communication_logs',
		where: { assignment: { is: OWN } },
		sql: ['EXISTS'],
		allow: ['communication-owned'],
		deny: ['communication-other']
	},
	{
		id: 'field-operations.unchecked-job',
		root: 'jobs',
		where: { assignments: { some: UNCHECKED } },
		sql: ['EXISTS', 'IS NULL'],
		allow: ['job-owned'],
		deny: ['job-other']
	},
	{
		id: 'field-operations.unchecked-site',
		root: 'sites',
		where: { jobs: { some: { assignments: { some: UNCHECKED } } } },
		sql: ['EXISTS', 'IS NULL'],
		allow: ['site-owned'],
		deny: ['site-other']
	},
	{
		id: 'field-operations.unchecked-variation',
		root: 'variation_requests',
		where: { assignment: { is: UNCHECKED } },
		sql: ['EXISTS', 'IS NULL'],
		allow: ['variation-owned'],
		deny: ['variation-other']
	},
	{
		id: 'field-operations.unchecked-evidence',
		root: 'photo_evidence',
		where: {
			or: [
				{ assignment: { is: UNCHECKED } },
				{ variation: { is: { assignment: { is: UNCHECKED } } } }
			]
		},
		sql: ['EXISTS', ' OR ', 'IS NULL'],
		allow: ['evidence-direct-owned', 'evidence-variation-owned'],
		deny: ['evidence-other']
	},
	{
		id: 'field-operations.unchecked-assignment-child',
		root: 'suspicious_activity_logs',
		where: { assignment: { is: UNCHECKED } },
		sql: ['EXISTS', 'IS NULL'],
		allow: ['suspicion-log-owned'],
		deny: ['suspicion-log-other']
	},
	{
		id: 'payroll.not-a-correction',
		root: 'component_entries',
		where: NOT_A_CORRECTION,
		sql: ['IS DISTINCT FROM'],
		allow: ['entry-owned', 'entry-other', 'entry-missing-kind'],
		deny: ['entry-correction']
	},
	{
		id: 'payroll.owned-employment-child',
		root: 'payslips',
		where: { employment: { is: OWN_EMPLOYMENT } },
		sql: ['EXISTS', 'lower('],
		allow: ['payslip-owned'],
		deny: ['payslip-other']
	},
	{
		id: 'payroll.own-employment',
		root: 'employments',
		where: OWN_EMPLOYMENT,
		sql: ['EXISTS', 'lower('],
		allow: ['employment-owned'],
		deny: ['employment-other']
	},
	{
		id: 'payroll.own-entry-not-correction',
		root: 'component_entries',
		where: { and: [{ employment: { is: OWN_EMPLOYMENT } }, NOT_A_CORRECTION] },
		sql: ['EXISTS', 'lower(', 'IS DISTINCT FROM'],
		allow: ['entry-owned', 'entry-missing-kind'],
		deny: ['entry-correction', 'entry-other']
	},
	{
		id: 'payroll.own-loan',
		root: 'loans',
		where: { employment: { is: OWN_EMPLOYMENT } },
		sql: ['EXISTS', 'lower('],
		allow: ['loan-owned'],
		deny: ['loan-other']
	},
	{
		id: 'employee.case-folded-email',
		root: 'employees',
		where: { email: { eq: { var: 'requestor.email' } } },
		sql: ['lower('],
		allow: ['employee-owned'],
		deny: ['employee-other']
	}
];

// fixture names ↔ uuids (ids are uuids in the new engine)
const ids = new Map<string, string>(),
	names = new Map<string, string>();
const u = (n: string) => {
	let id = ids.get(n);
	if (id === undefined) {
		id = `0199a000-0000-7000-8000-${String(ids.size + 1).padStart(12, '0')}`;
		ids.set(n, id);
		names.set(id, n);
	}
	return id;
};
const b: Bindings = { now: '2026-09-25T10:00:00.000Z', today: '2026-09-25', tz: 'UTC' };
const all = (model: string): ModelAuthority => ({
	read: { [model]: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }] },
	history: [],
	create: [],
	update: [],
	delete: [],
	moves: {},
	masks: {}
});
const who = (
	over: Partial<Extract<EngineActor, { kind: 'member' }>> = {},
	admin = false
): Authority => ({
	key: 'k',
	admin,
	policies: ['p'],
	actor: {
		kind: 'member',
		id: 'u1',
		email: 'owner@example.test',
		phone: null,
		external: false,
		teams: ['Ops'],
		teamPath: ['Ops'],
		admin,
		party: null,
		...over
	},
	models: Object.fromEntries(Object.keys(models).map((c) => [c, all(c)])),
	automations: [],
	capabilities: { apps: [], tools: [], mcp: [], skills: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
const owner = who();

const IdRow = Schema.Struct({ id: Schema.String });
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* applyPlan(db, yield* plan(null, manifest), { accept: true });
	// the grant `Where` is the root's read arm: an authority predicate, compiled raw across any relation
	const visible = Effect.fnUntraced(function* (root: string, pred: Pred, as: Authority = owner) {
		const authority: Authority = {
			...as,
			models: {
				...as.models,
				[root]: { ...all(root), read: { [root]: [{ policy: 'p', where: pred, fields: 'all' }] } }
			}
		};
		const s = yield* whereSql(
			catalogOf(manifest),
			root,
			{ t: 'const', value: true },
			readOptions({ as: 'caller', authority }, b)
		).pipe(Effect.mapError(fromStore));
		return { sql: s.text, ids: (yield* db.rows(IdRow, s)).map((r) => names.get(r.id) ?? r.id) };
	});
	const ins = Effect.fnUntraced(function* (
		t: string,
		rows: readonly Record<string, string | null>[]
	) {
		for (const r of rows) {
			const cols = Object.keys(r);
			yield* db.write({
				text: `insert into ${t} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
				params: cols.map((c) => {
					const value = r[c];
					if (value === undefined) throw new Error(`Missing fixture ${t}.${c}`);
					return c === 'id' ||
						['site', 'job', 'assignment', 'variation', 'employee', 'employment'].includes(c)
						? value === null
							? null
							: u(value)
						: value;
				})
			});
		}
	});
	yield* ins('sites', [{ id: 'site-owned' }, { id: 'site-other' }]);
	yield* ins('jobs', [
		{ id: 'job-owned', site: 'site-owned' },
		{ id: 'job-other', site: 'site-other' }
	]);
	yield* ins('job_assignments', [
		{ id: 'assignment-owned', job: 'job-owned', assignee: 'u1', suspicion_checked_at: null },
		{
			id: 'assignment-other',
			job: 'job-other',
			assignee: 'u2',
			suspicion_checked_at: '2026-01-01T00:00:00.000Z'
		}
	]);
	yield* ins('variation_requests', [
		{ id: 'variation-owned', assignment: 'assignment-owned' },
		{ id: 'variation-other', assignment: 'assignment-other' }
	]);
	yield* ins('photo_evidence', [
		{ id: 'evidence-direct-owned', assignment: 'assignment-owned', variation: null },
		{ id: 'evidence-variation-owned', assignment: null, variation: 'variation-owned' },
		{ id: 'evidence-other', assignment: 'assignment-other', variation: null }
	]);
	yield* ins('communication_logs', [
		{ id: 'communication-owned', assignment: 'assignment-owned' },
		{ id: 'communication-other', assignment: 'assignment-other' }
	]);
	yield* ins('suspicious_activity_logs', [
		{ id: 'suspicion-log-owned', assignment: 'assignment-owned' },
		{ id: 'suspicion-log-other', assignment: 'assignment-other' }
	]);
	yield* ins('employees', [
		{ id: 'employee-owned', email: 'Owner@Example.Test' },
		{ id: 'employee-other', email: 'other@example.test' }
	]);
	yield* ins('employments', [
		{ id: 'employment-owned', employee: 'employee-owned' },
		{ id: 'employment-other', employee: 'employee-other' }
	]);
	yield* ins('component_entries', [
		{ id: 'entry-owned', employment: 'employment-owned', kind: 'BONUS' },
		{ id: 'entry-missing-kind', employment: 'employment-owned', kind: null },
		{ id: 'entry-correction', employment: 'employment-owned', kind: 'MANUAL_ADJUSTMENT' },
		{ id: 'entry-other', employment: 'employment-other', kind: 'BONUS' }
	]);
	yield* ins('loans', [
		{ id: 'loan-owned', employment: 'employment-owned' },
		{ id: 'loan-other', employment: 'employment-other' }
	]);
	yield* ins('payslips', [
		{ id: 'payslip-owned', employment: 'employment-owned' },
		{ id: 'payslip-other', employment: 'employment-other' }
	]);
	return { db, visible };
});
class PolicyFixture extends Context.Service<PolicyFixture, Effect.Success<typeof fixture>>()(
	'test/PolicyFixture'
) {}
const PolicyFixtureLive = Layer.effect(PolicyFixture, fixture).pipe(
	Layer.provide(PgliteDb.layer())
);

describe('the production read-policy matrix on the new engine (L-BOLT-229)', () => {
	it.effect(
		'every row compiles to SQL carrying its expected operators and admits exactly its allow rows',
		() =>
			Effect.gen(function* () {
				const { visible } = yield* PolicyFixture;
				expect(new Set(matrix.map((r) => r.id)).size).toBe(matrix.length);
				for (const row of matrix) {
					const { sql, ids: seen } = yield* visible(
						row.root,
						toPred(manifest, row.root, row.where)
					);
					for (const fragment of row.sql) expect(sql, row.id).toContain(fragment);
					for (const id of row.allow) expect(seen, `${row.id} allows ${id}`).toContain(id);
					for (const id of row.deny) expect(seen, `${row.id} denies ${id}`).not.toContain(id);
				}
			}).pipe(Effect.provide(PolicyFixtureLive))
	);

	it.effect('a relation grant follows insert, delete and re-parent of the rows it crosses', () =>
		Effect.gen(function* () {
			const { db, visible } = yield* PolicyFixture;
			const first = matrix[0];
			if (first === undefined) throw new Error('The policy matrix is empty');
			const pred = toPred(manifest, 'sites', first.where);
			const sites = () => visible('sites', pred).pipe(Effect.map((answer) => answer.ids.sort()));
			try {
				yield* db.write({
					text: `insert into job_assignments (id, job, assignee) values ($1, $2, 'u1')`,
					params: [u('assignment-inserted'), u('job-other')]
				});
				expect(yield* sites()).toEqual(['site-other', 'site-owned']);
				yield* db.write({
					text: `delete from job_assignments where id = $1`,
					params: [u('assignment-inserted')]
				});
				expect(yield* sites()).toEqual(['site-owned']);
				yield* db.write({
					text: `update job_assignments set job = $1 where id = $2`,
					params: [u('job-other'), u('assignment-owned')]
				});
				expect(yield* sites()).toEqual(['site-other']);
			} finally {
				yield* db.write({
					text: `update job_assignments set job = $1 where id = $2`,
					params: [u('job-owned'), u('assignment-owned')]
				});
			}
		}).pipe(Effect.provide(PolicyFixtureLive))
	);
});
