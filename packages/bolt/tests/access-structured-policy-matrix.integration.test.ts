import { PGlite } from '@electric-sql/pglite';
import { Result, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	collection,
	field,
	workspace,
	type RelationDefinition,
	type WorkspaceDefinition
} from '../src/authoring/workspace-schema.js';
import { compileStructuredPredicate } from '../src/runtime/access/effective-plan.js';
import type { Subject } from '../src/runtime/identity/subject.js';
import { withSystemCollections } from '../src/runtime/schema/system-collections.js';

const SUBJECT_ID = { $subject: 'id' } as const;
const SUBJECT_EMAIL = { $subject: 'email' } as const;
const OWN_ASSIGNMENT = { assignee_user_id: { eq: SUBJECT_ID } } as const;
const ASSIGNED_JOB = { job_assignment_job: { some: OWN_ASSIGNMENT } } as const;
const ASSIGNED_SITE = { site_jobs: { some: ASSIGNED_JOB } } as const;
const OWN_VARIATION = { job_assignment_variations: { some: OWN_ASSIGNMENT } } as const;
const OWN_EVIDENCE = {
	OR: [
		{ job_assignment_photo_evidence: { some: OWN_ASSIGNMENT } },
		{ variation_request_photo_evidence: { some: OWN_VARIATION } }
	]
} as const;
const OWN_COMMUNICATION = { job_assignment_communications: { some: OWN_ASSIGNMENT } } as const;
const UNCHECKED_ASSIGNMENT = { suspicion_checked_at: { isNull: true } } as const;
const UNCHECKED_JOB = { job_assignment_job: { some: UNCHECKED_ASSIGNMENT } } as const;
const UNCHECKED_SITE = { site_jobs: { some: UNCHECKED_JOB } } as const;
const UNCHECKED_VARIATION = {
	job_assignment_variations: { some: UNCHECKED_ASSIGNMENT }
} as const;
const UNCHECKED_EVIDENCE = {
	OR: [
		{ job_assignment_photo_evidence: { some: UNCHECKED_ASSIGNMENT } },
		{ variation_request_photo_evidence: { some: UNCHECKED_VARIATION } }
	]
} as const;
const NOT_A_CORRECTION = {
	event: {
		jsonPath: { path: ['kind'], type: 'string', ne: 'MANUAL_ADJUSTMENT' }
	}
} as const;
const OWN_EMPLOYMENT = {
	employment_employee: { some: { email: { caseFoldEq: SUBJECT_EMAIL } } }
} as const;
const employmentChild = (relationship: string) => ({
	[relationship]: { some: OWN_EMPLOYMENT }
});

const relation = (
	name: string,
	source: string,
	target: string,
	fromCollection: string,
	fromColumn: string,
	toCollection: string,
	toColumn: string,
	cardinality: 'one' | 'many' = 'one'
): RelationDefinition => ({
	name,
	source,
	target,
	cardinality,
	from: { collection: fromCollection, column: fromColumn },
	to: { collection: toCollection, column: toColumn }
});

const definition: WorkspaceDefinition = withSystemCollections(
	workspace({
		name: 'structured-policy-matrix',
		version: '1',
		collections: [
			collection({ name: 'sites', fields: {} }),
			collection({ name: 'jobs', fields: { site_id: field.uuid({ required: true }) } }),
			collection({
				name: 'job_assignments',
				fields: {
					job_id: field.uuid({ required: true }),
					assignee_user_id: field.string({ required: true }),
					suspicion_checked_at: field.instant()
				}
			}),
			collection({
				name: 'variation_requests',
				fields: { job_assignment_id: field.uuid({ required: true }) }
			}),
			collection({
				name: 'photo_evidence',
				fields: {
					job_assignment_id: field.uuid(),
					variation_request_id: field.uuid()
				}
			}),
			collection({
				name: 'communication_logs',
				fields: { job_assignment_id: field.uuid({ required: true }) }
			}),
			collection({
				name: 'suspicious_activity_logs',
				fields: { job_assignment_id: field.uuid({ required: true }) }
			}),
			collection({
				name: 'suspicion_reviews',
				fields: { job_assignment_id: field.uuid({ required: true }) }
			}),
			collection({ name: 'employees', fields: { email: field.string({ required: true }) } }),
			collection({
				name: 'employments',
				fields: { employee_id: field.uuid({ required: true }) }
			}),
			...[
				'employment_terms',
				'employment_statutory_facts',
				'work_days',
				'loans',
				'leave_requests',
				'employee_children',
				'payslips'
			].map((name) =>
				collection({ name, fields: { employment_id: field.uuid({ required: true }) } })
			),
			collection({
				name: 'component_entries',
				fields: {
					employment_id: field.uuid({ required: true }),
					event: field.json({ required: true })
				}
			})
		],
		relations: [
			relation('site_jobs', 'sites', 'jobs', 'jobs', 'site_id', 'sites', 'id', 'many'),
			relation(
				'job_assignment_job',
				'jobs',
				'job_assignments',
				'job_assignments',
				'job_id',
				'jobs',
				'id',
				'many'
			),
			relation(
				'job_assignment_variations',
				'variation_requests',
				'job_assignments',
				'variation_requests',
				'job_assignment_id',
				'job_assignments',
				'id'
			),
			relation(
				'job_assignment_photo_evidence',
				'photo_evidence',
				'job_assignments',
				'photo_evidence',
				'job_assignment_id',
				'job_assignments',
				'id'
			),
			relation(
				'variation_request_photo_evidence',
				'photo_evidence',
				'variation_requests',
				'photo_evidence',
				'variation_request_id',
				'variation_requests',
				'id'
			),
			relation(
				'job_assignment_communications',
				'communication_logs',
				'job_assignments',
				'communication_logs',
				'job_assignment_id',
				'job_assignments',
				'id'
			),
			relation(
				'job_assignment_suspicions',
				'suspicious_activity_logs',
				'job_assignments',
				'suspicious_activity_logs',
				'job_assignment_id',
				'job_assignments',
				'id'
			),
			relation(
				'job_assignment_suspicion_reviews',
				'suspicion_reviews',
				'job_assignments',
				'suspicion_reviews',
				'job_assignment_id',
				'job_assignments',
				'id'
			),
			relation(
				'employment_employee',
				'employments',
				'employees',
				'employments',
				'employee_id',
				'employees',
				'id'
			),
			...[
				['term_employment', 'employment_terms'],
				['statutory_fact_employment', 'employment_statutory_facts'],
				['work_day_employment', 'work_days'],
				['component_entry_employment', 'component_entries'],
				['loan_employment', 'loans'],
				['leave_request_employment', 'leave_requests'],
				['child_employment', 'employee_children'],
				['payslip_employment', 'payslips']
			].map(([name, source]) =>
				relation(
					name ?? '',
					source ?? '',
					'employments',
					source ?? '',
					'employment_id',
					'employments',
					'id'
				)
			)
		],
		apps: [],
		policies: [],
		prompt: '',
		tools: [],
		skills: [],
		automations: [],
		envoys: [],
		integrations: [],
		requiredFacilities: []
	})
);

const owner: Subject = {
	userId: 'u1',
	tenantId: 'tenant',
	teamPath: ['Ops'],
	policies: [],
	email: 'owner@example.test',
	admin: false
};

type MatrixRow = Readonly<{
	readonly id: string;
	readonly root: string;
	readonly where: Readonly<Record<string, unknown>>;
	readonly dependencies: ReadonlyArray<string>;
	readonly reverse: ReadonlyArray<string>;
	readonly indexes: ReadonlyArray<string>;
	readonly sql: ReadonlyArray<string>;
	readonly allow: ReadonlyArray<string>;
	readonly deny: ReadonlyArray<string>;
}>;

const indexes = (...values: ReadonlyArray<string>): ReadonlyArray<string> => values;
const reverse = (...values: ReadonlyArray<string>): ReadonlyArray<string> => values;
const encodeMessage = Schema.encodeSync(Prompt.Message);
const userPrompt = (text: string): Prompt.MessageEncoded =>
	encodeMessage(Prompt.userMessage({ content: [Prompt.textPart({ text })] }));

const matrix: ReadonlyArray<MatrixRow> = [
	{
		id: 'system.approval-request-party',
		root: 'approval_request',
		where: { id: { approvalParty: true } },
		dependencies: ['approval_request', 'requestor'],
		reverse: reverse('requestor:approval_request.requestors'),
		indexes: indexes('requestor.approval_request_id:relationship'),
		sql: ['jsonb_typeof', 'approver_teams', 'superseder_teams', 'lower'],
		allow: ['approval-owned', 'approval-team', 'approval-superseder'],
		deny: ['approval-denied', 'approval-malformed']
	},
	{
		id: 'system.requestor-party',
		root: 'requestor',
		where: { approval_request_id: { approvalParty: true } },
		dependencies: ['approval_request', 'requestor'],
		reverse: reverse('approval_request:requestor.approvalRequest'),
		indexes: indexes('requestor.approval_request_id:relationship'),
		sql: ['jsonb_typeof', 'approver_teams', 'superseder_teams', 'lower'],
		allow: ['requestor-owned', 'requestor-team', 'requestor-superseder'],
		deny: ['requestor-denied', 'requestor-malformed']
	},
	{
		id: 'system.task-owner',
		root: 'agent_task',
		where: { subject_id: { eq: SUBJECT_ID } },
		dependencies: ['agent_task'],
		reverse: [],
		indexes: indexes('agent_task.subject_id:routing'),
		sql: ['is not distinct from'],
		allow: ['task-owned'],
		deny: ['task-other']
	},
	{
		id: 'system.plan-owner',
		root: 'agent_plan',
		where: { task: { some: { subject_id: { eq: SUBJECT_ID } } } },
		dependencies: ['agent_plan', 'agent_task'],
		reverse: reverse('agent_task:agent_plan.task'),
		indexes: indexes('agent_plan.task_id:relationship'),
		sql: ['exists', 'is not distinct from'],
		allow: ['plan-owned'],
		deny: ['plan-other']
	},
	{
		id: 'system.message-owner',
		root: 'agent_message',
		where: { task: { some: { subject_id: { eq: SUBJECT_ID } } } },
		dependencies: ['agent_message', 'agent_task'],
		reverse: reverse('agent_task:agent_message.task'),
		indexes: indexes('agent_message.task_id:relationship'),
		sql: ['exists', 'is not distinct from'],
		allow: ['message-owned'],
		deny: ['message-other']
	},
	{
		id: 'system.inbox-owner',
		root: 'agent_inbox',
		where: { task: { some: { subject_id: { eq: SUBJECT_ID } } } },
		dependencies: ['agent_inbox', 'agent_task'],
		reverse: reverse('agent_task:agent_inbox.task'),
		indexes: indexes('agent_inbox.task_id:relationship'),
		sql: ['exists', 'is not distinct from'],
		allow: ['inbox-owned'],
		deny: ['inbox-other']
	},
	{
		id: 'system.run-owner',
		root: 'agent_run',
		where: { task: { some: { subject_id: { eq: SUBJECT_ID } } } },
		dependencies: ['agent_run', 'agent_task'],
		reverse: reverse('agent_task:agent_run.task'),
		indexes: indexes('agent_run.task_id:relationship'),
		sql: ['exists', 'is not distinct from'],
		allow: ['run-owned'],
		deny: ['run-other']
	},
	{
		id: 'system.usage-owner',
		root: 'agent_usage',
		where: { run: { some: { task: { some: { subject_id: { eq: SUBJECT_ID } } } } } },
		dependencies: ['agent_run', 'agent_task', 'agent_usage'],
		reverse: reverse(
			'agent_run:agent_usage.run',
			'agent_task:agent_run.task>agent_usage.run'
		),
		indexes: indexes(
			'agent_run.task_id:relationship',
			'agent_usage.run_id:relationship'
		),
		sql: ['exists', 'is not distinct from'],
		allow: ['usage-owned'],
		deny: ['usage-other']
	},
	{
		id: 'system.notification-owner',
		root: 'bolt_notifications',
		where: { recipient: { eq: SUBJECT_ID } },
		dependencies: ['bolt_notifications'],
		reverse: [],
		indexes: indexes('bolt_notifications.recipient:routing'),
		sql: ['is not distinct from'],
		allow: ['notification-owned'],
		deny: ['notification-other']
	},
	{
		id: 'field-operations.assigned-site',
		root: 'sites',
		where: ASSIGNED_SITE,
		dependencies: ['job_assignments', 'jobs', 'sites'],
		reverse: reverse('job_assignments:jobs.job_assignment_job>sites.site_jobs', 'jobs:sites.site_jobs'),
		indexes: indexes(
			'job_assignments.job_id:relationship',
			'jobs.site_id:relationship'
		),
		sql: ['exists', 'is not distinct from'],
		allow: ['site-owned'],
		deny: ['site-other']
	},
	{
		id: 'field-operations.assigned-job',
		root: 'jobs',
		where: ASSIGNED_JOB,
		dependencies: ['job_assignments', 'jobs'],
		reverse: reverse('job_assignments:jobs.job_assignment_job'),
		indexes: indexes('job_assignments.job_id:relationship'),
		sql: ['exists', 'is not distinct from'],
		allow: ['job-owned'],
		deny: ['job-other']
	},
	{
		id: 'field-operations.own-variation',
		root: 'variation_requests',
		where: OWN_VARIATION,
		dependencies: ['job_assignments', 'variation_requests'],
		reverse: reverse('job_assignments:variation_requests.job_assignment_variations'),
		indexes: indexes(
			'variation_requests.job_assignment_id:relationship'
		),
		sql: ['exists', 'is not distinct from'],
		allow: ['variation-owned'],
		deny: ['variation-other']
	},
	{
		id: 'field-operations.own-evidence',
		root: 'photo_evidence',
		where: OWN_EVIDENCE,
		dependencies: ['job_assignments', 'photo_evidence', 'variation_requests'],
		reverse: reverse(
			'job_assignments:photo_evidence.job_assignment_photo_evidence',
			'job_assignments:variation_requests.job_assignment_variations>photo_evidence.variation_request_photo_evidence',
			'variation_requests:photo_evidence.variation_request_photo_evidence'
		),
		indexes: indexes(
			'photo_evidence.job_assignment_id:relationship',
			'photo_evidence.variation_request_id:relationship',
			'variation_requests.job_assignment_id:relationship'
		),
		sql: ['exists', ' or ', 'is not distinct from'],
		allow: ['evidence-direct-owned', 'evidence-variation-owned'],
		deny: ['evidence-other']
	},
	{
		id: 'field-operations.own-communication',
		root: 'communication_logs',
		where: OWN_COMMUNICATION,
		dependencies: ['communication_logs', 'job_assignments'],
		reverse: reverse('job_assignments:communication_logs.job_assignment_communications'),
		indexes: indexes(
			'communication_logs.job_assignment_id:relationship'
		),
		sql: ['exists', 'is not distinct from'],
		allow: ['communication-owned'],
		deny: ['communication-other']
	},
	{
		id: 'field-operations.unchecked-job',
		root: 'jobs',
		where: UNCHECKED_JOB,
		dependencies: ['job_assignments', 'jobs'],
		reverse: reverse('job_assignments:jobs.job_assignment_job'),
		indexes: indexes('job_assignments.job_id:relationship'),
		sql: ['exists', 'is null'],
		allow: ['job-owned'],
		deny: ['job-other']
	},
	{
		id: 'field-operations.unchecked-site',
		root: 'sites',
		where: UNCHECKED_SITE,
		dependencies: ['job_assignments', 'jobs', 'sites'],
		reverse: reverse('job_assignments:jobs.job_assignment_job>sites.site_jobs', 'jobs:sites.site_jobs'),
		indexes: indexes(
			'job_assignments.job_id:relationship',
			'jobs.site_id:relationship'
		),
		sql: ['exists', 'is null'],
		allow: ['site-owned'],
		deny: ['site-other']
	},
	{
		id: 'field-operations.unchecked-variation',
		root: 'variation_requests',
		where: UNCHECKED_VARIATION,
		dependencies: ['job_assignments', 'variation_requests'],
		reverse: reverse('job_assignments:variation_requests.job_assignment_variations'),
		indexes: indexes(
			'variation_requests.job_assignment_id:relationship'
		),
		sql: ['exists', 'is null'],
		allow: ['variation-owned'],
		deny: ['variation-other']
	},
	{
		id: 'field-operations.unchecked-evidence',
		root: 'photo_evidence',
		where: UNCHECKED_EVIDENCE,
		dependencies: ['job_assignments', 'photo_evidence', 'variation_requests'],
		reverse: reverse(
			'job_assignments:photo_evidence.job_assignment_photo_evidence',
			'job_assignments:variation_requests.job_assignment_variations>photo_evidence.variation_request_photo_evidence',
			'variation_requests:photo_evidence.variation_request_photo_evidence'
		),
		indexes: indexes(
			'photo_evidence.job_assignment_id:relationship',
			'photo_evidence.variation_request_id:relationship',
			'variation_requests.job_assignment_id:relationship'
		),
		sql: ['exists', ' or ', 'is null'],
		allow: ['evidence-direct-owned', 'evidence-variation-owned'],
		deny: ['evidence-other']
	},
	{
		id: 'field-operations.unchecked-assignment-child',
		root: 'suspicious_activity_logs',
		where: { job_assignment_suspicions: { some: UNCHECKED_ASSIGNMENT } },
		dependencies: ['job_assignments', 'suspicious_activity_logs'],
		reverse: reverse('job_assignments:suspicious_activity_logs.job_assignment_suspicions'),
		indexes: indexes(
			'suspicious_activity_logs.job_assignment_id:relationship'
		),
		sql: ['exists', 'is null'],
		allow: ['suspicion-log-owned'],
		deny: ['suspicion-log-other']
	},
	{
		id: 'payroll.not-a-correction',
		root: 'component_entries',
		where: NOT_A_CORRECTION,
		dependencies: ['component_entries'],
		reverse: [],
		indexes: [],
		sql: ['#>>', 'is distinct from'],
		allow: ['entry-owned', 'entry-other', 'entry-missing-kind'],
		deny: ['entry-correction']
	},
	{
		id: 'payroll.owned-employment-child',
		root: 'payslips',
		where: employmentChild('payslip_employment'),
		dependencies: ['employees', 'employments', 'payslips'],
		reverse: reverse(
			'employees:employments.employment_employee>payslips.payslip_employment',
			'employments:payslips.payslip_employment'
		),
		indexes: indexes(
			'employments.employee_id:relationship',
			'payslips.employment_id:relationship'
		),
		sql: ['exists', 'lower'],
		allow: ['payslip-owned'],
		deny: ['payslip-other']
	},
	{
		id: 'payroll.own-employment',
		root: 'employments',
		where: OWN_EMPLOYMENT,
		dependencies: ['employees', 'employments'],
		reverse: reverse('employees:employments.employment_employee'),
		indexes: indexes('employments.employee_id:relationship'),
		sql: ['exists', 'lower'],
		allow: ['employment-owned'],
		deny: ['employment-other']
	},
	{
		id: 'payroll.own-entry-not-correction',
		root: 'component_entries',
		where: { AND: [employmentChild('component_entry_employment'), NOT_A_CORRECTION] },
		dependencies: ['component_entries', 'employees', 'employments'],
		reverse: reverse(
			'employees:employments.employment_employee>component_entries.component_entry_employment',
			'employments:component_entries.component_entry_employment'
		),
		indexes: indexes(
			'component_entries.employment_id:relationship',
			'employments.employee_id:relationship'
		),
		sql: ['exists', 'lower', '#>>', 'is distinct from'],
		allow: ['entry-owned', 'entry-missing-kind'],
		deny: ['entry-correction', 'entry-other']
	},
	{
		id: 'payroll.own-loan-not-children',
		root: 'loans',
		where: employmentChild('loan_employment'),
		dependencies: ['employees', 'employments', 'loans'],
		reverse: reverse(
			'employees:employments.employment_employee>loans.loan_employment',
			'employments:loans.loan_employment'
		),
		indexes: indexes(
			'employments.employee_id:relationship',
			'loans.employment_id:relationship'
		),
		sql: ['exists', 'lower'],
		allow: ['loan-owned'],
		deny: ['loan-other']
	}
];

const compile = (row: MatrixRow, subject: Subject = owner) => {
	const compiled = compileStructuredPredicate({
		definition,
		rootCollection: row.root,
		where: row.where,
		subject,
		qualifier: 'root',
		node: `matrix.${row.id}`
	});
	if (Result.isFailure(compiled)) throw compiled.failure;
	const query = compiled.success.sql.getSQL().toQuery({
		escapeName: (name) => `"${name.replaceAll('"', '""')}"`,
		escapeParam: (index) => `$${index + 1}`,
		escapeString: (text) => `'${text.replaceAll("'", "''")}'`
	});
	return { ...compiled.success, query };
};

const reverseKeys = (row: ReturnType<typeof compile>): ReadonlyArray<string> =>
	row.semantics.reversePaths
		.map(
			(path) =>
				`${path.collection}:${path.segments.map(({ relationship }) => relationship).join('>')}`
		)
		.toSorted();

const indexKeys = (row: ReturnType<typeof compile>): ReadonlyArray<string> =>
	row.semantics.indexRequirements
		.map(({ collection: name, field: nameField, reason }) => `${name}.${nameField}:${reason}`)
		.toSorted();

let database: PGlite;

beforeAll(async () => {
	database = new PGlite();
	await database.exec(`
		create table approval_request (id text primary key, approver_teams jsonb, superseder_teams jsonb);
		create table requestor (id text primary key, approval_request_id text, user_id text);
		create table agent_task (id text primary key, subject_id text);
		create table agent_plan (id text primary key, task_id text);
		create table agent_message (id text primary key, task_id text, message jsonb);
		create table agent_inbox (id text primary key, task_id text, message_id text);
		create table agent_run (id text primary key, task_id text);
		create table agent_usage (id text primary key, run_id text);
		create table bolt_notifications (id text primary key, recipient text);
		create table sites (id text primary key);
		create table jobs (id text primary key, site_id text);
		create table job_assignments (id text primary key, job_id text, assignee_user_id text, suspicion_checked_at text);
		create table variation_requests (id text primary key, job_assignment_id text);
		create table photo_evidence (id text primary key, job_assignment_id text, variation_request_id text);
		create table communication_logs (id text primary key, job_assignment_id text);
		create table suspicious_activity_logs (id text primary key, job_assignment_id text);
		create table suspicion_reviews (id text primary key, job_assignment_id text);
		create table employees (id text primary key, email text);
		create table employments (id text primary key, employee_id text);
		create table employment_terms (id text primary key, employment_id text);
		create table employment_statutory_facts (id text primary key, employment_id text);
		create table work_days (id text primary key, employment_id text);
		create table component_entries (id text primary key, employment_id text, event jsonb);
		create table loans (id text primary key, employment_id text);
		create table leave_requests (id text primary key, employment_id text);
		create table employee_children (id text primary key, employment_id text);
		create table payslips (id text primary key, employment_id text);

		insert into approval_request values
			('approval-owned', '[]', '[]'),
			('approval-team', '["OPS"]', '[]'),
			('approval-superseder', '[]', '["oPs"]'),
			('approval-denied', '["Finance"]', '[]'),
			('approval-malformed', '{"not":"an array"}', 'null');
		insert into requestor values
			('requestor-owned', 'approval-owned', 'u1'),
			('requestor-team', 'approval-team', 'u2'),
			('requestor-superseder', 'approval-superseder', 'u2'),
			('requestor-denied', 'approval-denied', 'u2'),
			('requestor-malformed', 'approval-malformed', 'u2');
		insert into agent_task values
			('task-owned', 'u1'),
			('task-other', 'u2');
		insert into agent_plan values
			('plan-owned', 'task-owned'),
			('plan-other', 'task-other');
		insert into agent_inbox values
			('inbox-owned', 'task-owned', 'message-owned'),
			('inbox-other', 'task-other', 'message-other');
		insert into agent_run values
			('run-owned', 'task-owned'),
			('run-other', 'task-other');
		insert into agent_usage values
			('usage-owned', 'run-owned'),
			('usage-other', 'run-other');
		insert into bolt_notifications values
			('notification-owned', 'u1'),
			('notification-other', 'u2');
		insert into sites values ('site-owned'), ('site-other');
		insert into jobs values ('job-owned', 'site-owned'), ('job-other', 'site-other');
		insert into job_assignments values
			('assignment-owned', 'job-owned', 'u1', null),
			('assignment-other', 'job-other', 'u2', '2026-01-01T00:00:00.000Z');
		insert into variation_requests values
			('variation-owned', 'assignment-owned'),
			('variation-other', 'assignment-other');
		insert into photo_evidence values
			('evidence-direct-owned', 'assignment-owned', null),
			('evidence-variation-owned', null, 'variation-owned'),
			('evidence-other', 'assignment-other', null);
		insert into communication_logs values
			('communication-owned', 'assignment-owned'),
			('communication-other', 'assignment-other');
		insert into suspicious_activity_logs values
			('suspicion-log-owned', 'assignment-owned'),
			('suspicion-log-other', 'assignment-other');
		insert into suspicion_reviews values
			('suspicion-review-owned', 'assignment-owned'),
			('suspicion-review-other', 'assignment-other');
		insert into employees values
			('employee-owned', 'Owner@Example.Test'),
			('employee-other', 'other@example.test');
		insert into employments values
			('employment-owned', 'employee-owned'),
			('employment-other', 'employee-other');
		insert into component_entries values
			('entry-owned', 'employment-owned', '{"kind":"BONUS"}'),
			('entry-missing-kind', 'employment-owned', '{}'),
			('entry-correction', 'employment-owned', '{"kind":"MANUAL_ADJUSTMENT"}'),
			('entry-other', 'employment-other', '{"kind":"BONUS"}');
		insert into loans values ('loan-owned', 'employment-owned'), ('loan-other', 'employment-other');
		insert into payslips values
			('payslip-owned', 'employment-owned'),
			('payslip-other', 'employment-other');
	`);
	await database.query(
		'insert into agent_message (id, task_id, message) values ' +
			"('message-owned', 'task-owned', $1::jsonb), " +
			"('message-other', 'task-other', $2::jsonb)",
		[JSON.stringify(userPrompt('Owned task')), JSON.stringify(userPrompt('Other task'))]
	);
});

afterAll(async () => {
	await database.close();
});

describe('sync engine production read-policy matrix', () => {
	it('has exactly 24 named structured policies with exact derived plan receipts', () => {
		expect(matrix).toHaveLength(24);
		expect(new Set(matrix.map(({ id }) => id)).size).toBe(24);
		for (const row of matrix) {
			const compiled = compile(row);
			expect(compiled.semantics.dependencies, row.id).toEqual(row.dependencies);
			expect(reverseKeys(compiled), row.id).toEqual([...row.reverse].toSorted());
			expect(indexKeys(compiled), row.id).toEqual([...row.indexes].toSorted());
			for (const fragment of row.sql) expect(compiled.query.sql, row.id).toContain(fragment);
		}
	});

	it('executes every generated parameterized SQL tree against allow/deny PostgreSQL fixtures', async () => {
		for (const row of matrix) {
			const compiled = compile(row);
			const rows = await database.query<{ id: string }>(
				`select root.id from "${row.root}" as root where ${compiled.query.sql} order by root.id`,
				compiled.query.params
			);
			const ids = new Set(rows.rows.map(({ id }) => id));
			for (const id of row.allow) expect(ids.has(id), `${row.id} allows ${id}`).toBe(true);
			for (const id of row.deny) expect(ids.has(id), `${row.id} denies ${id}`).toBe(false);
		}
	}, 60_000);

	it('narrows malformed approval JSON, preserves superseders, and admits the explicit admin override', async () => {
		const row = matrix[0];
		if (row === undefined) throw new TypeError('approval matrix row is missing');
		const administrator = { ...owner, admin: true };
		const compiled = compile(row, administrator);
		const rows = await database.query<{ id: string }>(
			`select root.id from approval_request as root where ${compiled.query.sql} order by root.id`,
			compiled.query.params
		);
		expect(rows.rows.map(({ id }) => id)).toContain('approval-malformed');
	});

	it('rebinds approval membership when the subject team changes', async () => {
		const row = matrix[0];
		if (row === undefined) throw new TypeError('approval matrix row is missing');
		const finance = compile(row, { ...owner, teamPath: ['Finance'] });
		const rows = await database.query<{ id: string }>(
			`select root.id from approval_request as root where ${finance.query.sql} order by root.id`,
			finance.query.params
		);
		const ids = rows.rows.map(({ id }) => id);
		expect(ids).toContain('approval-denied');
		expect(ids).not.toContain('approval-team');
		expect(ids).not.toContain('approval-malformed');
	});

	it('preserves relation-policy meaning across insert, delete, and re-parent fixtures', async () => {
		const row = matrix.find(({ id }) => id === 'field-operations.assigned-site');
		if (row === undefined) throw new TypeError('assigned-site matrix row is missing');
		const visible = async (): Promise<ReadonlyArray<string>> => {
			const compiled = compile(row);
			const rows = await database.query<{ id: string }>(
				`select root.id from sites as root where ${compiled.query.sql} order by root.id`,
				compiled.query.params
			);
			return rows.rows.map(({ id }) => id);
		};
		await database.exec('begin');
		try {
			await database.exec(
				"insert into job_assignments values ('assignment-inserted', 'job-other', 'u1', null)"
			);
			expect(await visible()).toEqual(['site-other', 'site-owned']);
			await database.exec("delete from job_assignments where id = 'assignment-inserted'");
			expect(await visible()).toEqual(['site-owned']);
			await database.exec(
				"update job_assignments set job_id = 'job-other' where id = 'assignment-owned'"
			);
			expect(await visible()).toEqual(['site-other']);
		} finally {
			await database.exec('rollback');
		}
	});

	it('case-folds the direct employee address and keeps missing event.kind null-safe', async () => {
		const employee = compile({
			id: 'employee.case-folded-email',
			root: 'employees',
			where: { email: { caseFoldEq: SUBJECT_EMAIL } },
			dependencies: ['employees'],
			reverse: [],
			indexes: [],
			sql: ['lower'],
			allow: ['employee-owned'],
			deny: ['employee-other']
		});
		const rows = await database.query<{ id: string }>(
			`select root.id from employees as root where ${employee.query.sql}`,
			employee.query.params
		);
		expect(rows.rows.map(({ id }) => id)).toEqual(['employee-owned']);
		expect(matrix.find(({ id }) => id === 'payroll.not-a-correction')?.allow).toContain(
			'entry-missing-kind'
		);
	});
});
