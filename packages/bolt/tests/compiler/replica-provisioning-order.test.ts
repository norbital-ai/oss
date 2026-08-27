import { describe, expect, it } from 'vitest';
import { text } from '../../src/authoring/index.js';
import { collection, workspace } from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan, replicaProvisioningSteps } from '../../src/compiler/schema-plan.js';

/**
 * A browser replica applies this list into an empty database, so its order is load-bearing in a
 * way the server's never was.
 *
 * A workspace migration may reference a system table — a relation to `user` makes drizzle emit
 * `REFERENCES "user"("id")` inside the workspace lineage. The server already holds `user` by the
 * time any lineage runs, so nothing there depended on the order. The replica creates everything
 * from nothing: with system tables emitted after the lineage, that constraint executed against a
 * database where `user` did not exist yet, provisioning failed at that step, and the workspace
 * silently fell back to server-only with no browser replica at all.
 */
describe('replica provisioning order', () => {
	const definition = workspace({
		name: 'dispatch',
		version: '1',
		collections: [
			collection({ name: 'job_assignments', fields: { note: text() } })
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
					'ALTER TABLE "job_assignments" ADD CONSTRAINT "job_assignments_assignee_user_id_user_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id")'
				]
			}
		]
	});

	const ids = replicaProvisioningSteps(definition).map(({ id }) => id);
	const at = (id: string): number => ids.indexOf(id);

	it('creates every system table the lineage can reference before the lineage runs', () => {
		const firstLineage = ids.findIndex((id) => id.startsWith('lineage:'));
		expect(firstLineage).toBeGreaterThan(-1);
		const created = ids
			.slice(0, firstLineage)
			.filter((id) => id.startsWith('collection:') && !id.includes(':column:'));
		expect(created).toContain('collection:user');
		expect(created).toContain('collection:team');
		expect(created).toContain('collection:bolt_task');
	});

	it('puts the foreign key to user after the table it references', () => {
		expect(at('collection:user')).toBeLessThan(
			at('lineage:20260824074156_baseline:1')
		);
	});

	it('still applies extensions and functions first', () => {
		const firstBolt = ids.findIndex((id) => id.startsWith('bolt:'));
		const firstCollection = ids.findIndex((id) => id.startsWith('collection:'));
		expect(firstBolt).toBe(0);
		expect(firstBolt).toBeLessThan(firstCollection);
	});

	it('leaves indexes and initialisers after the lineage', () => {
		const lastLineage = ids.map((id) => id.startsWith('lineage:')).lastIndexOf(true);
		const indexes = ids.filter((id) => id.startsWith('index:') || id.includes(':index:'));
		for (const id of indexes) expect(at(id)).toBeGreaterThan(lastLineage);
	});

	/**
	 * Pins the defect itself, so this file cannot pass against the order it was written to reject.
	 *
	 * This rebuilds the previous expression — foundation, lineage, then every remaining plan step —
	 * from the same plan the fixed function consumes. It is the exact list a replica used to
	 * receive, and it puts `collection:user` after the constraint that references `user`.
	 */
	it('rejects the previous order, which emitted the table after the constraint', () => {
		const plan = buildSchemaPlan(definition);
		const previous = [
			...plan.steps.filter(({ id }) => id.startsWith('bolt:')),
			...[{ id: 'lineage:20260824074156_baseline:1' }],
			...plan.steps.filter(({ id }) => !id.startsWith('bolt:'))
		].map(({ id }) => id);
		expect(previous.indexOf('collection:user')).toBeGreaterThan(
			previous.indexOf('lineage:20260824074156_baseline:1')
		);
		// and the shipped order is the other way round
		expect(at('collection:user')).toBeLessThan(at('lineage:20260824074156_baseline:1'));
	});
});
