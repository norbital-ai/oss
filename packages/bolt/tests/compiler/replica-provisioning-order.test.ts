import { describe, expect, it } from 'vitest';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import {
	buildSchemaPlan,
	planTableNames,
	replicaProvisioningSteps
} from '../../src/compiler/schema-plan.js';

/**
 * A browser replica is a projection of the current sync-visible model, not a copy of the server
 * schema. In particular, an authored relation to `user` keeps its scalar UUID locally while the
 * server remains the only database that creates and enforces the foreign key.
 */
describe('replica provisioning boundary', () => {
	const definition = workspace({
		name: 'dispatch',
		version: '1',
		collections: [
			collection({
				name: 'job_assignments',
				fields: { assignee_user_id: field.uuid(), note: field.string() }
			}),
			collection({
				name: 'private_notes',
				fields: { note: field.string() },
				sync: false
			})
		],
		apps: [],
		policies: [],
		automations: [],
		integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		envoys: [],
		requiredFacilities: [],
		migrations: [
			{
				tag: '20260824074156_baseline',
				statements: [
					'CREATE TABLE "job_assignments" ("id" uuid PRIMARY KEY, "assignee_user_id" uuid)',
					'ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_assignee_user_id_user_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id")',
					'CREATE TABLE "private_notes" ("id" uuid PRIMARY KEY, "note" text)'
				]
			}
		]
	});

	const steps = replicaProvisioningSteps(definition);
	const sql = steps.map(({ sql }) => sql).join('\n');

	it('creates only replicated tenant tables and approval_request', () => {
		expect(planTableNames({ fingerprint: 'replica', steps })).toEqual([
			'approval_request',
			'job_assignments'
		]);
	});

	it('does not carry private server table names or migration lineage', () => {
		for (const privateName of [
			'user',
			'team',
			'session',
			'account',
			'verification',
			'requestor',
			'chat_session',
			'chat_message',
			'agent_mailbox',
			'agent_run',
			'automation_run',
			'bolt_notifications',
			'bolt_task',
			'bolt_sync_outbox'
		]) {
			expect(sql).not.toMatch(new RegExp(`(?:^|[^a-z0-9_])${privateName}(?:$|[^a-z0-9_])`, 'i'));
		}
		expect(steps.some(({ id }) => id.startsWith('lineage:'))).toBe(false);
		expect(sql).not.toContain('private_notes');
	});

	it('keeps the identity reference as a UUID without a local foreign key', () => {
		const assignment = steps.find(({ id }) => id === 'replica:collection:job_assignments');
		expect(assignment?.sql).toContain('"assignee_user_id" uuid');
		expect(assignment?.sql.toLowerCase()).not.toContain('foreign key');
		expect(assignment?.sql.toLowerCase()).not.toContain('references');
	});

	it('leaves the authoritative server plan and its private tables intact', () => {
		const serverPlan = buildSchemaPlan(definition);
		expect(planTableNames(serverPlan)).toContain('user');
		expect(definition.migrations?.[0]?.statements[1]).toContain('REFERENCES "user"');
	});

	it('installs only the pure schema helpers before the replica tables', () => {
		const firstCollection = steps.findIndex(({ id }) => id.startsWith('replica:collection:'));
		expect(firstCollection).toBeGreaterThan(0);
		expect(steps.slice(0, firstCollection).every(({ id }) => id.startsWith('bolt:'))).toBe(true);
		expect(sql).not.toContain('bolt_capture_sync_change');
		expect(sql).not.toContain('bolt_project_');
	});
});
