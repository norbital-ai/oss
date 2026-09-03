import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, text } from '../src/authoring/index.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { planWorkspaceMigration } from '../src/compiler/schema-migrations.js';
import { compileWorkspaceAuthoring } from '../src/authoring/model-introspection.js';
import {
	APPROVAL_REQUEST_ONGOING_INDEX_NAME,
	buildSchemaPlan,
	collectionIndexName
} from '../src/runtime/schema/schema-plan.js';

/**
 * `field.string({ indexed: true })` reaches DDL in both emitters: the flag is read by the schema
 * plan, not only validated at the authoring boundary, so a declared index is provisioned and
 * evolved — on authored collections and on Bolt's own `approval_request` and `requestor` alike.
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
				/^create (?:unique )?index if not exists/.test(sql)
			)
		).toBe(true);
	});

	/**
	 * Bolt's own runtime collections declare indexes on the columns every approval lookup filters by.
	 * The compiler adds the partial unique guard that serializes ongoing ownership of a root. They are
	 * merged into the plan by `withSystemCollections`, so both reach collections no workspace authors.
	 */
	it('indexes system lookups and serializes ongoing approval ownership', () => {
		expect(declaredIndexSql('approval_request')).toEqual([
			'create index if not exists "approval_request_approver_teams_idx" on "approval_request" using gin ("approver_teams")',
			`create unique index if not exists "${APPROVAL_REQUEST_ONGOING_INDEX_NAME}" on "approval_request" ("collection_name", "record_id") where "status" = 'ONGOING'`,
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
			planWorkspaceMigration({
				authoring: compileWorkspaceAuthoring({
					models,
					sourcePaths: Object.fromEntries(
						Object.keys(models).map((name) => [name, `fixture:${name}`])
					)
				}),
				previous: undefined
			})
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
			planWorkspaceMigration({
				authoring: compileWorkspaceAuthoring({
					models,
					sourcePaths: Object.fromEntries(
						Object.keys(models).map((name) => [name, `fixture:${name}`])
					)
				}),
				previous: undefined
			})
		);
		if (first === undefined)
			throw new Error('a schema built from nothing must produce a migration');

		expect(
			await Effect.runPromise(
				planWorkspaceMigration({
					authoring: compileWorkspaceAuthoring({
						models,
						sourcePaths: Object.fromEntries(
							Object.keys(models).map((name) => [name, `fixture:${name}`])
						)
					}),
					previous: first.snapshot
				})
			)
		).toBeUndefined();
	});
});
