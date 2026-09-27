// The production read-policy matrix (L-BOLT-229, ported from `access-structured-policy-matrix.integration.test.ts`) as
// a table on the new engine: each row's grant `Where` compiles through the query area (`toPred` → `whereSql`, the SQL
// every caller read conjoins, rule 13) and runs against allow/deny rows on PGlite. The approval-party rows are the
// approval read branch (`heldScope`, rule 46) over real `bolt_approvals` rows. The old rows over agent tables
// (conversation, plan, message, turn, usage, notification) are not here: those system collections are the agents
// area's. `jsonPath` has no counterpart (rule 16: no `Where` reads json); the correction flag is a stored enum.
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvals } from '../src/engine/approvals/approvals.ts';
import { catalogOf, toPred } from '../src/engine/access/pred.ts';
import type { Authority, Bindings, CollectionAuthority, EngineActor, EngineManifest, Pred, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { whereSql } from '../src/engine/query/sql.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';

const d = { description: 'x', label: 'name' } as const;
const name = { name: { kind: 'text', optional: true } } as const;
const models = {
	sites: { ...d, fields: name }, jobs: { ...d, fields: name }, held: { ...d, fields: name },
	job_assignments: { ...d, fields: { ...name, assignee: { kind: 'text' }, suspicion_checked_at: { kind: 'instant', optional: true } } },
	variation_requests: { ...d, fields: name }, photo_evidence: { ...d, fields: name }, communication_logs: { ...d, fields: name },
	suspicious_activity_logs: { ...d, fields: name }, employees: { ...d, fields: { ...name, email: { kind: 'text', format: 'email' } } },
	employments: { ...d, fields: name }, payslips: { ...d, fields: name }, loans: { ...d, fields: name },
	component_entries: { ...d, fields: { ...name, kind: { kind: 'enum', values: ['BONUS', 'MANUAL_ADJUSTMENT'], optional: true } } },
};
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' }, models,
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
		'component_entries.employment': { to: 'employments', inverse: 'entries' },
	},
	collections: Object.fromEntries(Object.keys(models).map((c) => [c, { read: { fields: 'all' } }])),
	integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {},
	customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

// ── the grant predicates, in the new `Where` ──
const OWN = { assignee: { eq: { actor: 'id' } } };
const UNCHECKED = { suspicion_checked_at: { isNull: true } };
const OWN_VARIATION = { assignment: { is: OWN } };
const OWN_EMPLOYMENT = { employee: { is: { email: { eq: { actor: 'email' } } } } };
const NOT_A_CORRECTION = { kind: { ne: 'MANUAL_ADJUSTMENT' } };
type Row = { id: string; root: string; where: unknown; sql: readonly string[]; allow: readonly string[]; deny: readonly string[] };
const matrix: readonly Row[] = [
	{ id: 'field-operations.assigned-site', root: 'sites', where: { jobs: { some: { assignments: { some: OWN } } } }, sql: ['EXISTS'], allow: ['site-owned'], deny: ['site-other'] },
	{ id: 'field-operations.assigned-job', root: 'jobs', where: { assignments: { some: OWN } }, sql: ['EXISTS'], allow: ['job-owned'], deny: ['job-other'] },
	{ id: 'field-operations.own-variation', root: 'variation_requests', where: OWN_VARIATION, sql: ['EXISTS'], allow: ['variation-owned'], deny: ['variation-other'] },
	{ id: 'field-operations.own-evidence', root: 'photo_evidence', where: { or: [{ assignment: { is: OWN } }, { variation: { is: OWN_VARIATION } }] },
		sql: ['EXISTS', ' OR '], allow: ['evidence-direct-owned', 'evidence-variation-owned'], deny: ['evidence-other'] },
	{ id: 'field-operations.own-communication', root: 'communication_logs', where: { assignment: { is: OWN } }, sql: ['EXISTS'], allow: ['communication-owned'], deny: ['communication-other'] },
	{ id: 'field-operations.unchecked-job', root: 'jobs', where: { assignments: { some: UNCHECKED } }, sql: ['EXISTS', 'IS NULL'], allow: ['job-owned'], deny: ['job-other'] },
	{ id: 'field-operations.unchecked-site', root: 'sites', where: { jobs: { some: { assignments: { some: UNCHECKED } } } }, sql: ['EXISTS', 'IS NULL'], allow: ['site-owned'], deny: ['site-other'] },
	{ id: 'field-operations.unchecked-variation', root: 'variation_requests', where: { assignment: { is: UNCHECKED } }, sql: ['EXISTS', 'IS NULL'], allow: ['variation-owned'], deny: ['variation-other'] },
	{ id: 'field-operations.unchecked-evidence', root: 'photo_evidence', where: { or: [{ assignment: { is: UNCHECKED } }, { variation: { is: { assignment: { is: UNCHECKED } } } }] },
		sql: ['EXISTS', ' OR ', 'IS NULL'], allow: ['evidence-direct-owned', 'evidence-variation-owned'], deny: ['evidence-other'] },
	{ id: 'field-operations.unchecked-assignment-child', root: 'suspicious_activity_logs', where: { assignment: { is: UNCHECKED } }, sql: ['EXISTS', 'IS NULL'],
		allow: ['suspicion-log-owned'], deny: ['suspicion-log-other'] },
	{ id: 'payroll.not-a-correction', root: 'component_entries', where: NOT_A_CORRECTION, sql: ['IS DISTINCT FROM'],
		allow: ['entry-owned', 'entry-other', 'entry-missing-kind'], deny: ['entry-correction'] },
	{ id: 'payroll.owned-employment-child', root: 'payslips', where: { employment: { is: OWN_EMPLOYMENT } }, sql: ['EXISTS', 'lower('], allow: ['payslip-owned'], deny: ['payslip-other'] },
	{ id: 'payroll.own-employment', root: 'employments', where: OWN_EMPLOYMENT, sql: ['EXISTS', 'lower('], allow: ['employment-owned'], deny: ['employment-other'] },
	{ id: 'payroll.own-entry-not-correction', root: 'component_entries', where: { and: [{ employment: { is: OWN_EMPLOYMENT } }, NOT_A_CORRECTION] },
		sql: ['EXISTS', 'lower(', 'IS DISTINCT FROM'], allow: ['entry-owned', 'entry-missing-kind'], deny: ['entry-correction', 'entry-other'] },
	{ id: 'payroll.own-loan', root: 'loans', where: { employment: { is: OWN_EMPLOYMENT } }, sql: ['EXISTS', 'lower('], allow: ['loan-owned'], deny: ['loan-other'] },
	{ id: 'employee.case-folded-email', root: 'employees', where: { email: { eq: { actor: 'email' } } }, sql: ['lower('], allow: ['employee-owned'], deny: ['employee-other'] },
];

// fixture names ↔ uuids (ids are uuids in the new engine)
const ids = new Map<string, string>(), names = new Map<string, string>();
const u = (n: string) => {
	let id = ids.get(n);
	if (id === undefined) { id = `0199a000-0000-7000-8000-${String(ids.size + 1).padStart(12, '0')}`; ids.set(n, id); names.set(id, n); }
	return id;
};
const b: Bindings = { now: '2026-09-25T10:00:00.000Z', today: '2026-09-25', tz: 'UTC', params: {} };
const ALL: CollectionAuthority = { read: [{ policy: 'p', where: { t: 'const', value: true }, fields: 'all' }], history: [], create: [], update: [], delete: [],
	queries: [], actions: [], moves: {}, masks: {} };
const who = (over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}, admin = false): Authority => ({
	key: 'k', admin, policies: ['p'], actor: { kind: 'member', id: 'u1', email: 'owner@example.test', external: false, teams: [], teamPath: ['Ops'], admin, party: null, ...over },
	collections: Object.fromEntries(Object.keys(models).map((c) => [c, ALL])), automations: [], capabilities: { apps: [], tools: [], mcp: [], skills: [] },
	limits: [], teamTree: [], scopes: {},
});
const owner = who();

let pg: PGlite, db: TenantDb;
const visible = async (root: string, pred: Pred, as: Authority = owner) => {
	const s = whereSql(catalogOf(manifest), root, pred, { as: 'caller', authority: as }, b);
	return { sql: s.text, ids: (await db.read([s]))[0]!.rows.map((r) => names.get(String(r['id'])) ?? String(r['id'])) };
};

beforeAll(async () => {
	({ pg, db } = await openPglite());
	await applyPlan(db, plan(null, manifest), { accept: true });
	const ins = async (t: string, rows: readonly Record<string, string | null>[]) => {
		for (const r of rows) {
			const cols = Object.keys(r);
			await pg.query(`insert into ${t} (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
				cols.map((c) => c === 'id' || ['site', 'job', 'assignment', 'variation', 'employee', 'employment'].includes(c) ? (r[c] === null ? null : u(r[c]!)) : r[c]));
		}
	};
	await ins('sites', [{ id: 'site-owned' }, { id: 'site-other' }]);
	await ins('jobs', [{ id: 'job-owned', site: 'site-owned' }, { id: 'job-other', site: 'site-other' }]);
	await ins('job_assignments', [{ id: 'assignment-owned', job: 'job-owned', assignee: 'u1', suspicion_checked_at: null },
		{ id: 'assignment-other', job: 'job-other', assignee: 'u2', suspicion_checked_at: '2026-01-01T00:00:00.000Z' }]);
	await ins('variation_requests', [{ id: 'variation-owned', assignment: 'assignment-owned' }, { id: 'variation-other', assignment: 'assignment-other' }]);
	await ins('photo_evidence', [{ id: 'evidence-direct-owned', assignment: 'assignment-owned', variation: null },
		{ id: 'evidence-variation-owned', assignment: null, variation: 'variation-owned' }, { id: 'evidence-other', assignment: 'assignment-other', variation: null }]);
	await ins('communication_logs', [{ id: 'communication-owned', assignment: 'assignment-owned' }, { id: 'communication-other', assignment: 'assignment-other' }]);
	await ins('suspicious_activity_logs', [{ id: 'suspicion-log-owned', assignment: 'assignment-owned' }, { id: 'suspicion-log-other', assignment: 'assignment-other' }]);
	await ins('employees', [{ id: 'employee-owned', email: 'Owner@Example.Test' }, { id: 'employee-other', email: 'other@example.test' }]);
	await ins('employments', [{ id: 'employment-owned', employee: 'employee-owned' }, { id: 'employment-other', employee: 'employee-other' }]);
	await ins('component_entries', [{ id: 'entry-owned', employment: 'employment-owned', kind: 'BONUS' }, { id: 'entry-missing-kind', employment: 'employment-owned', kind: null },
		{ id: 'entry-correction', employment: 'employment-owned', kind: 'MANUAL_ADJUSTMENT' }, { id: 'entry-other', employment: 'employment-other', kind: 'BONUS' }]);
	await ins('loans', [{ id: 'loan-owned', employment: 'employment-owned' }, { id: 'loan-other', employment: 'employment-other' }]);
	await ins('payslips', [{ id: 'payslip-owned', employment: 'employment-owned' }, { id: 'payslip-other', employment: 'employment-other' }]);
	// approval parties (rule 46): the requestor, an approver of the current step, a superseder, nobody, a malformed route
	const requests = [['approval-owned', 'member:u1', { steps: [[]], superceded_by: [] }], ['approval-team', 'member:u2', { steps: [['OPS']], superceded_by: [] }],
		['approval-superseder', 'member:u2', { steps: [['Finance']], superceded_by: ['oPs'] }], ['approval-denied', 'member:u2', { steps: [['Finance']], superceded_by: [] }],
		['approval-malformed', 'member:u2', { steps: { not: 'an array' }, superceded_by: null }]] as const;
	for (const [n, requestor, route] of requests) {
		await pg.query(`insert into bolt_approvals (id, state, step, collection, record, action, requestor, route, at) values ($1, 'Pending', 0, 'held', $4, 'create', $2, $3, now())`,
			[u(n), requestor, JSON.stringify(route), u(`held-${n}`)]);
		await pg.query(`insert into held (id, approval_id) values ($1, $2)`, [u(`held-${n}`), u(n)]);
	}
});

describe('the production read-policy matrix on the new engine (L-BOLT-229)', () => {
	it('every row compiles to SQL carrying its expected operators and admits exactly its allow rows', async () => {
		expect(new Set(matrix.map((r) => r.id)).size).toBe(matrix.length);
		for (const row of matrix) {
			const { sql, ids: seen } = await visible(row.root, toPred(manifest, row.root, row.where));
			for (const fragment of row.sql) expect(sql, row.id).toContain(fragment);
			for (const id of row.allow) expect(seen, `${row.id} allows ${id}`).toContain(id);
			for (const id of row.deny) expect(seen, `${row.id} denies ${id}`).not.toContain(id);
		}
	});

	const flows = () => approvals(manifest, db);
	const held = async (as: Authority) => (await visible('held', await flows().heldScope(as), as)).ids.map((n) => n.replace(/^held-/, '')).sort();

	it('the approval read branch: requestor, current-step team and superseder (case-insensitive) see the held row; malformed routes narrow to nobody', async () => {
		expect(await held(owner)).toEqual(['approval-owned', 'approval-superseder', 'approval-team']);
	});

	it('an administrator sees every held row, the malformed one included', async () => {
		expect(await held(who({ admin: true }, true))).toEqual(['approval-denied', 'approval-malformed', 'approval-owned', 'approval-superseder', 'approval-team']);
	});

	it('approval membership rebinds when the member\'s team changes', async () => {
		const seen = await held(who({ teamPath: ['Finance'] }));
		expect(seen).toContain('approval-denied');
		expect(seen).not.toContain('approval-team');
		expect(seen).not.toContain('approval-malformed');
	});

	it('a relation grant follows insert, delete and re-parent of the rows it crosses', async () => {
		const pred = toPred(manifest, 'sites', matrix[0]!.where);
		const sites = async () => (await visible('sites', pred)).ids.sort();
		try {
			await pg.query(`insert into job_assignments (id, job, assignee) values ($1, $2, 'u1')`, [u('assignment-inserted'), u('job-other')]);
			expect(await sites()).toEqual(['site-other', 'site-owned']);
			await pg.query(`delete from job_assignments where id = $1`, [u('assignment-inserted')]);
			expect(await sites()).toEqual(['site-owned']);
			await pg.query(`update job_assignments set job = $1 where id = $2`, [u('job-other'), u('assignment-owned')]);
			expect(await sites()).toEqual(['site-other']);
		} finally {
			await pg.query(`update job_assignments set job = $1 where id = $2`, [u('job-owned'), u('assignment-owned')]);
		}
	});
});
