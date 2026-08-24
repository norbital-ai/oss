import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, text } from '../../src/authoring/index.js';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import { planWorkspaceMigration } from '../../src/compiler/schema-migrations.js';
import { buildSchemaPlan, collectionIndexName } from '../../src/compiler/schema-plan.js';

/**
 * `field.string({ indexed: true })` used to reach no DDL at all: the flag was validated at the
 * authoring boundary and then read by nothing that emits SQL, so a declared index was accepted and
 * dropped — on authored collections and on Bolt's own `approval_request` and `requestor` alike.
 *
 * Both emitters are pinned here, because they reach different databases: the plan provisions from
 * nothing, the lineage evolves a deployed workspace, and an index in only one of them is an index
 * half the estate does not have.
 */
const indexed = workspace({
	name: 'work-items',
	version: '1',
	collections: [
		collection({
			name: 'work_items',
			fields: {
				zeta: field.string({ indexed: true }),
				ignored: field.string(),
				alpha: field.number({ indexed: true })
			}
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
	requiredFacilities: []
});

/**
 * What the plan still renders. Authored collections now get their tables and indexes from the drizzle
 * lineage, so for one of those this is empty by design — which is the assertion below.
 */
const declaredIndexSql = (name: string): ReadonlyArray<string> =>
	buildSchemaPlan(indexed)
		.steps.filter(({ id }) => id.startsWith(`collection:${name}:index:`))
		.map(({ sql }) => sql);

describe('declared collection indexes', () => {
	/**
	 * The plan renders nothing for an authored collection now, indexes included. The positive case —
	 * that a declared column becomes an index, under the shared name — is the lineage test below, which
	 * is where authored index DDL actually comes from.
	 */
	it('renders no index for an authored collection', () => {
		expect(declaredIndexSql('work_items')).toEqual([]);
	});

	/**
	 * The plan still renders indexes for Bolt's own collections on every provision, so those keep their
	 * `if not exists` guard. Lineage entries run exactly once against a ledger instead, which is what
	 * makes an unguarded `CREATE INDEX` correct for an authored collection.
	 */
	it('guards every system-collection index so re-running the plan is a no-op', () => {
		expect(
			declaredIndexSql('approval_request').every((sql) =>
				sql.startsWith('create index if not exists')
			)
		).toBe(true);
	});

	/**
	 * Bolt's own runtime collections declare `indexed: true` on the columns every approval lookup
	 * filters by. They are merged into the plan by `withSystemCollections`, so they are the case that
	 * proves the flag is honoured for collections no workspace authored.
	 */
	it('indexes the system collections that declare it', () => {
		expect(declaredIndexSql('approval_request')).toEqual([
			'create index if not exists "approval_request_approver_teams_idx" on "approval_request" using gin ("approver_teams")',
			'create index if not exists "approval_request_superseder_teams_idx" on "approval_request" using gin ("superseder_teams")',
			'create index if not exists "approval_request_collection_name_idx" on "approval_request" ("collection_name")',
			'create index if not exists "approval_request_record_id_idx" on "approval_request" ("record_id")',
			'create index if not exists "approval_request_status_idx" on "approval_request" ("status")'
		]);
	});

	/**
	 * The lineage half. A deployed workspace only changes through migrations, so an index the plan
	 * alone knows about never reaches it — and the two must agree on the name or the workspace ends
	 * up with the same index twice.
	 */
	it('creates the same index in the migration lineage, under the same name', async () => {
		const models = {
			work_items: defineModel(
				{ zeta: text(), ignored: text() },
				{
					indexes: [{ name: collectionIndexName('work_items', 'zeta'), columns: ['zeta'] }]
				}
			)
		};
		const migration = await Effect.runPromise(
			planWorkspaceMigration({ models, relations: [], previous: undefined })
		);

		expect(
			migration?.statements.some((statement) =>
				statement.includes(collectionIndexName('work_items', 'zeta'))
			),
			JSON.stringify(migration?.statements)
		).toBe(true);
		expect(
			migration?.statements.some((statement) =>
				statement.includes(collectionIndexName('work_items', 'ignored'))
			)
		).toBe(false);
	});

	/** A second `bolt migrate` over an unchanged model must propose nothing, not the index again. */
	it('converges: re-diffing an unchanged model proposes no further index', async () => {
		const models = {
			work_items: defineModel(
				{ zeta: text(), ignored: text() },
				{
					indexes: [{ name: collectionIndexName('work_items', 'zeta'), columns: ['zeta'] }]
				}
			)
		};
		const first = await Effect.runPromise(
			planWorkspaceMigration({ models, relations: [], previous: undefined })
		);
		if (first === undefined)
			throw new Error('a schema built from nothing must produce a migration');

		expect(
			await Effect.runPromise(
				planWorkspaceMigration({ models, relations: [], previous: first.snapshot })
			)
		).toBeUndefined();
	});
});
