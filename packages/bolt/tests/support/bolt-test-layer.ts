import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import {
	EffectId,
	InvocationId,
	type CommunicationRequest,
	type CommunicationResponse,
	type ConnectorRequest,
	type ConnectorResponse,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityCall,
	type IdentityHookRequest,
	type IdentityHookResponse,
	TransportRequest,
	TransportResponse
} from '@norbital-ai/bolt-protocol';
import {
	collection,
	field,
	policy,
	workspace,
	type CollectionDefinition,
	type FieldDefinition,
	type PolicyDeclaration,
	type WorkspaceDefinition,
	type WorkspaceMigrationEntry
} from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan, collectionIndexName } from '../../src/compiler/schema-plan.js';
import { planWorkspaceMigration } from '../../src/compiler/schema-migrations.js';
import {
	boolean,
	doublePrecision,
	jsonb,
	timestamp,
	uuid as uuidColumn,
	type AnyPgColumnBuilder
} from 'drizzle-orm/pg-core';
import { text as authoredText } from '../../src/authoring/index.js';

/**
 * A test collection's columns as drizzle builders.
 *
 * Test definitions are assembled from `field.*` calls, which carry a scalar type and never the column
 * builder a `+model.ts` would have, so there is nothing to recover and the mapping has to be stated.
 * It lives here, in the harness, rather than in the plan: production collection DDL now has exactly
 * one source, and this is a fixture for workspaces that were never authored as models.
 */
const drizzleColumns = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): Readonly<Record<string, AnyPgColumnBuilder>> =>
	Object.fromEntries(
		Object.entries(collection.fields).map(([name, field]) => {
			// `text` comes from Bolt's own authoring factory rather than Drizzle's, because that is what
			// records the `search` marker on the builder. `describeModelColumns` reads it back off there,
			// and it is what `searchIndexes` uses to decide a trigram index — so a bridge that reached for
			// `pgText()` would silently produce a schema with no searchable columns in it.
			const base =
				field.type === 'uuid'
					? uuidColumn(name)
					: field.type === 'number'
						? doublePrecision(name)
						: field.type === 'boolean'
							? boolean(name)
							: field.type === 'datetime'
								? timestamp(name, { withTimezone: true })
								: field.type === 'json'
									? jsonb(name)
									: authoredText({ search: field.search === true });
			return [name, field.required ? base.notNull() : base];
		})
	);

/**
 * The ordered DDL a database is actually provisioned with.
 *
 * One place, because "what does a table look like" now has three contributors and asking only one of
 * them is how the plan/lineage disagreement went unnoticed for so long: the plan's foundation, the
 * drizzle lineage that owns collection tables and their indexes, and the plan's supplements for what
 * Drizzle cannot express. Tests that assert on schema shape assert on this, not on any single half.
 */

/**
 * A hand-written `indexed: true` as an explicit index declaration.
 *
 * `describeModelColumns` recovers `indexed` from a builder's `isUnique`/`primaryKey`, so expressing
 * it that way on a synthesized builder would create a UNIQUE *constraint* rather than an index — and
 * a fixture that declares `indexed` on a repeating column would then reject 23 of 25 rows. Declaring
 * the index directly says the intended thing, under the same shared name the plan and lineage use.
 */
const declaredIndexMetadata = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }> =>
	Object.entries(collection.fields)
		.filter(([, field]) => field.indexed)
		.map(([name]) => name)
		.toSorted()
		.map((name) => ({ name: collectionIndexName(collection.name, name), columns: [name] }));

export const provisioningStatements = async (
	definition: WorkspaceDefinition
): Promise<ReadonlyArray<{ readonly id: string; readonly sql: string }>> => {
	const plan = buildSchemaPlan(definition).steps;
	const migration = await Effect.runPromise(
		planWorkspaceMigration({
			models: Object.fromEntries(
				definition.collections.map((collection) => [
					collection.name,
					{
						__kind: 'model' as const,
						columns: drizzleColumns(collection),
						metadata: { indexes: declaredIndexMetadata(collection) }
					}
				])
			),
			relations: definition.relations ?? [],
			previous: undefined
		})
	);
	return [
		// Extensions, functions and `bolt_*` tables: generated columns call `norbital_date` and the
		// trigram indexes need `pg_trgm`.
		...plan.filter(({ id }) => id.startsWith('bolt:')),
		...(migration?.statements ?? []).map((sql, index) => ({ id: `lineage:${index}`, sql })),
		// EXCLUDE constraints and Bolt's own system collections.
		...plan.filter(({ id }) => !id.startsWith('bolt:'))
	];
};

import { AccessControl } from '../../src/runtime/access/access-control.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import { Automations } from '../../src/runtime/automations/automations.js';
import { Channels } from '../../src/runtime/channels/channels.js';
import { Integrations } from '../../src/runtime/integrations/integrations.js';
import { Notifications } from '../../src/runtime/notifications/notifications.js';
import { WorkspaceSchema } from '../../src/runtime/schema/workspace-schema.js';
import { Approvals } from '../../src/runtime/approvals/approvals.js';
import { Collections } from '../../src/runtime/collections/collections.js';
import { SyncWake } from '../../src/runtime/sync/wake.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import { Database, type CallContext } from '../../src/runtime/facilities/database.js';
import {
	AI,
	Communication,
	Connector,
	Files,
	HostTools,
	IdentityHooks,
	Tasks,
	Transport
} from '../../src/runtime/facilities/services.js';
import { Identity } from '../../src/runtime/identity/identity.js';
import { remoteRegistryLayer } from '../../src/runtime/remotes.js';
import { InvocationBudget } from '../../src/runtime/budget.js';
import { RateLimits } from '../../src/runtime/rate-limits.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { PersonalSecrets } from '../../src/runtime/secrets/personal-secrets.js';
import { SECRET_KEY_VARIABLE, SecretCipher } from '@norbital-ai/std/secret';
import { Sync } from '../../src/runtime/sync/sync.js';
import { Workspace } from '../../src/runtime/workspace.js';

/**
 * A whole Bolt runtime over real SQL, without a host.
 *
 * Data semantics are the part of Bolt that pure functions cannot prove: visibility predicates,
 * approval interception, the sync outbox and its cursor all only exist once statements actually run.
 * PGlite gives that a Postgres to run against in-process, so these stay deterministic unit tests
 * rather than something that needs a container.
 */

/**
 * The environment every test invocation is scoped to unless one asks for another.
 *
 * A host scopes each invocation to a named environment, and the runtime reads that name rather than
 * any ambient variable to decide anything mode-dependent — today, whether a sign-in code is the
 * fixed development one or random. The harness is neither somebody's laptop nor a deployment, so it
 * says `test`: anything that is not exactly `development` takes the ordinary path, which is the one
 * a deployed workspace runs, so no test can pick up development behaviour by accident. A test that
 * wants the development path has to name it, which `testCallContext` lets it do.
 */
export const TEST_ENVIRONMENT = 'test';

const context: CallContext = {
	invocationId: InvocationId.make('test-invocation'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	environment: TEST_ENVIRONMENT
};

/**
 * A call context for a test that wires one facility layer directly rather than the whole harness.
 *
 * `Database.layer`, `Transport.layer` and the rest all take one, so a test checking a single
 * facility builds it by hand and otherwise has no reason to know what a call context contains. One
 * factory keeps that knowledge in a single place: when the context grows a field, these call sites
 * inherit a sound value instead of each inventing one.
 */
export const testCallContext = (
	invocationId: string,
	options: {
		readonly deadlineEpochMs?: number;
		readonly environment?: string;
	} = {}
): CallContext => ({
	invocationId: InvocationId.make(invocationId),
	deadlineEpochMs: options.deadlineEpochMs ?? Date.now() + 10_000,
	environment: options.environment ?? TEST_ENVIRONMENT
});

/**
 * The vault key every test runtime is built with unless one asks otherwise.
 *
 * Fixed rather than random so a failure is reproducible, and obviously a fixture rather than
 * plausibly a real key. 32 bytes, base64 — anything else and the cipher refuses to encrypt, which
 * would fail every vault test for a reason that has nothing to do with what it is checking.
 */
export const TEST_SECRET_KEY = 'dGVzdC12YXVsdC1rZXktMzItYnl0ZXMtZXhhY3RseS4=';

/** Rows cross the facility boundary as JSON, so non-JSON driver values are normalised first. */
const jsonSafe = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Schema.Json> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(row).map(([key, value]) => [
				key,
				value instanceof Date
					? value.toISOString()
					: typeof value === 'bigint'
						? Number(value)
						: (value as Schema.Json)
			])
		)
	);

/** Binds a PGlite instance as the Database facility, recording every statement for assertions. */
export const makeTestDatabase = async (): Promise<{
	readonly binding: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	readonly statements: ReadonlyArray<string>;
	/**
	 * The metadata every facility call arrived with, in order.
	 *
	 * The SQL alone cannot answer who a call was made for — `subject` rides on the call envelope, not
	 * in the statement — so a test that wants to know what the host is told has to read the envelope.
	 */
	readonly calls: ReadonlyArray<FacilityCall>;
	/** Drops what has been recorded so far, so a test asserts on its own statements and not on setup. */
	readonly forget: () => void;
	readonly query: (
		sql: string,
		parameters?: ReadonlyArray<unknown>
	) => Promise<ReadonlyArray<Record<string, unknown>>>;
	readonly close: () => Promise<void>;
}> => {
	// Registered explicitly, because PGlite ships these but enables none by default. Without them the
	// schema plan's `create extension` answers "not available", and a test cannot express a trigram
	// index or an effective-dating EXCLUDE — so the constraint the deployed database enforces is one
	// the suite is structurally unable to check.
	const database = await PGlite.create('memory://', {
		extensions: { pg_trgm, btree_gist, vector }
	});
	const statements: Array<string> = [];
	const calls: Array<FacilityCall> = [];
	const run = async (sql: string, parameters: ReadonlyArray<unknown>) => {
		statements.push(sql);
		return database.query<Record<string, unknown>>(sql, [...parameters]);
	};
	return {
		binding: {
			call: async (metadata, input) => {
				calls.push(metadata);
				try {
					if (input._tag === 'Query') {
						const result = await run(input.sql, input.parameters);
						return {
							_tag: 'Success',
							value: { rows: jsonSafe(result.rows), affectedRows: result.affectedRows ?? 0 }
						};
					}
					let affectedRows = 0;
					const rows: Array<Schema.Json> = [];
					await database.transaction(async (transaction) => {
						for (const statement of input.statements) {
							statements.push(statement.sql);
							const result = await transaction.query<Record<string, unknown>>(statement.sql, [
								...statement.parameters
							]);
							affectedRows += result.affectedRows ?? 0;
							rows.push(...jsonSafe(result.rows));
						}
					});
					return { _tag: 'Success', value: { rows, affectedRows } };
				} catch (cause) {
					return {
						_tag: 'Failure',
						error: {
							code: 'database.failed',
							message: cause instanceof Error ? cause.message : String(cause),
							retryable: false,
							outcome: 'known' as const
						}
					};
				}
			}
		},
		statements,
		calls,
		forget: () => {
			statements.length = 0;
			calls.length = 0;
		},
		query: async (sql, parameters = []) =>
			(await database.query<Record<string, unknown>>(sql, [...parameters])).rows,
		close: () => database.close()
	};
};

export type TestWorkspaceInput = Readonly<{
	readonly collections?: ReadonlyArray<{
		readonly name: string;
		readonly fields: Readonly<Record<string, FieldDefinition>>;
		readonly approvalLock?: boolean;
		readonly description?: string;
		readonly icon?: string;
	}>;
	readonly policies?: ReadonlyArray<PolicyDeclaration>;
	/** The `.norbital/migrations` lineage the artifact would have carried, oldest first. */
	readonly migrations?: ReadonlyArray<WorkspaceMigrationEntry>;
}>;

/** A minimal workspace: one `people` collection and an admin-everything policy unless overridden. */
export const testWorkspace = (input: TestWorkspaceInput = {}): WorkspaceDefinition =>
	workspace({
		name: 'test-workspace',
		version: '1',
		collections: (
			input.collections ?? [
				{ name: 'people', fields: { name: field.string({ required: true }), team: field.string() } }
			]
		).map((entry) => collection(entry)),
		apps: [],
		policies: input.policies ?? [
			policy({ name: 'admin', effect: 'allow', actions: ['*'], roles: ['admin'], apps: ['*'] })
		],
		agents: [],
		automations: [],
		channels: [],
		integrations: [],
		requiredFacilities: [],
		...(input.migrations === undefined ? {} : { migrations: input.migrations })
	});

/**
 * Builds the data-owning services over a migrated PGlite database. Facilities the data path does not
 * reach are bound as unavailable rather than faked, so a service that starts calling one fails
 * loudly in a test instead of silently succeeding against a stub.
 */
export const makeBoltTestRuntime = async (
	definition: WorkspaceDefinition = testWorkspace(),
	/**
	 * The two things an integration test has to be able to supply.
	 *
	 * `connector` is a real facility binding — the integrations runtime plans a request and the host
	 * performs it, so a test that wants to prove a pull has to bind the performer. `authored` carries
	 * the live half of `+integrations.ts` and `+pipelines.ts`, which the compiler builds from a live
	 * import and a test builds by hand.
	 */
	bindings: {
		readonly connector?: FacilityBinding<ConnectorRequest, ConnectorResponse>;
		readonly communication?: FacilityBinding<CommunicationRequest, CommunicationResponse>;
		readonly identityHooks?: FacilityBinding<IdentityHookRequest, IdentityHookResponse>;
		/** Bound when a test wants to observe what the write path announces on the sync topic. */
		readonly transport?: FacilityBinding<TransportRequest, TransportResponse>;
		readonly authored?: AuthoredRuntime;
		/**
		 * The vault encryption key this runtime is built with.
		 *
		 * `null` means the host configured none, which is the state a fail-closed test needs and which
		 * no ambient environment can accidentally supply — the provider below is an explicit record, not
		 * `process.env`, so a `BOLT_SECRETS_KEY` on the developer's machine cannot make that test pass
		 * for the wrong reason.
		 */
		readonly secretKey?: string | null;
	} = {}
) => {
	const database = await makeTestDatabase();
	const run = async (id: string, sql: string): Promise<void> => {
		const result = await database.binding.call(
			{
				invocationId: context.invocationId,
				effectId: EffectId.make(`migrate:${id}`),
				deadlineEpochMs: context.deadlineEpochMs,
				idempotencyKey: id
			},
			{ _tag: 'Query', sql, parameters: [] },
			new AbortController().signal
		);
		if (result._tag !== 'Success')
			throw new Error(`migration ${id} failed: ${JSON.stringify(result)}`);
	};
	for (const step of await provisioningStatements(definition)) await run(step.id, step.sql);
	const migration = await Effect.runPromise(
		planWorkspaceMigration({
			models: Object.fromEntries(
				definition.collections.map((collection) => [
					collection.name,
					{
						__kind: 'model' as const,
						columns: drizzleColumns(collection),
						metadata: { indexes: declaredIndexMetadata(collection) }
					}
				])
			),
			relations: definition.relations ?? [],
			previous: undefined
		})
	);
	/**
	 * The generated baseline becomes a real lineage entry, not just statements run on the side.
	 *
	 * `migrate` provisions collection tables from the lineage now, so a harness that created tables
	 * outside it would leave the runtime unable to rebuild them — and the tests that drop a table to
	 * watch it come back would be testing a path production does not have. Executing it *and*
	 * recording its tag leaves the database in the state a provisioned tenant is actually in: tables
	 * present, lineage at its head, any test-supplied entries still pending.
	 */
	const baseline = { tag: '00000000000000_baseline', statements: migration?.statements ?? [] };
	const provisioned: WorkspaceDefinition = {
		...definition,
		migrations: [baseline, ...(definition.migrations ?? [])]
	};
	// Recorded, because it has just been run. Without this a `migrate` in a test would find the
	// baseline pending and replay `CREATE TABLE` against tables that already exist.
	await run(
		'lineage:ledger',
		`insert into __drizzle_migrations (tag) values ('${baseline.tag}') on conflict (tag) do nothing`
	);
	// The schema plan's own statements are setup, not behaviour under test.
	database.forget();

	const facilities = Layer.mergeAll(
		Database.layer(database.binding, context),
		AI.layer(undefined, context),
		Communication.layer(bindings.communication, context),
		Connector.layer(bindings.connector, context),
		Files.layer(undefined, context),
		HostTools.layer(undefined, context),
		IdentityHooks.layer(bindings.identityHooks, context),
		Tasks.layer(undefined, context),
		Transport.layer(bindings.transport, context)
	);
	const workspaceLayer = Workspace.layer(provisioned);
	const authoredLayer = Layer.succeed(
		AuthoredRuntimeService,
		bindings.authored ?? emptyAuthoredRuntime
	);
	const foundation = Layer.provideMerge(
		Layer.mergeAll(Identity.layer, AccessControl.layer),
		Layer.merge(workspaceLayer, facilities)
	);
	const data = Layer.provideMerge(Approvals.layer, foundation);
	// Collections announces every committed write on the sync topic, so the wake has to be present for
	// the write path to resolve at all. The harness binds no transport, which is the point: the
	// announcement is `Effect.ignore`d, so a runtime with nowhere to publish still writes normally.
	const wake = Layer.provideMerge(SyncWake.layer, facilities);
	const collections = Layer.provideMerge(
		Collections.layer,
		Layer.mergeAll(data, authoredLayer, wake)
	);
	// Dispatch resolves authored remotes through this registry, and the registry resolves them
	// through Collections — so it layers over them, not alongside the facilities. No handlers are
	// registered: a test that calls one should fail on the missing name, not a missing service.
	const remotes = Layer.provideMerge(remoteRegistryLayer({}), collections);
	// Dispatch routes agent commands too, so the service has to be present for the command surface to
	// typecheck — its AI facility is bound unavailable, so calling one fails rather than pretending.
	// The budget an invocation carries. Zero depth, because a test drives the runtime directly rather
	// than through a task the runtime itself enqueued — which is the only thing that produces a
	// non-zero one. Provided rather than defaulted so a service that starts consulting it fails here
	// instead of silently reading a stand-in.
	const budget = InvocationBudget.layer(0);
	const agents = Layer.provideMerge(Agents.layer, Layer.merge(remotes, budget));
	// The rest of the command surface dispatch routes. Their facilities are bound unavailable, so a
	// test that reaches one fails loudly instead of succeeding against a stub.
	// Secrets sits under the rest rather than beside it: `Integrations` resolves a connection's
	// `{ env }` credential through the vault, and a service cannot see a sibling in its own `mergeAll`.
	// Both vaults seal through one cipher, over an explicit config record so the key under test is the
	// one this call asked for and never one the machine happens to have exported.
	const cipher = SecretCipher.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromEnvRecord(
					bindings.secretKey === null
						? {}
						: { [SECRET_KEY_VARIABLE]: bindings.secretKey ?? TEST_SECRET_KEY }
				)
			)
		)
	);
	const vault = Layer.provideMerge(
		Layer.merge(Secrets.layer, PersonalSecrets.layer),
		Layer.merge(agents, cipher)
	);
	const surfaces = Layer.provideMerge(
		Layer.mergeAll(
			Automations.layer,
			Channels.layer,
			Integrations.layer,
			Notifications.layer,
			WorkspaceSchema.layer
		),
		Layer.mergeAll(vault, authoredLayer, budget)
	);
	// The workspace's own declared rate policy, or none. A test workspace declares none, so every
	// command is admitted uncounted — which is what a suite about anything else needs, and what a
	// suite about the limiter overrides by building its own.
	const rateLimits = RateLimits.layer(definition.rateLimits);
	const complete = Layer.provideMerge(
		Sync.layer,
		Layer.mergeAll(surfaces, authoredLayer, budget, rateLimits)
	);

	const runtime = ManagedRuntime.make(complete);
	return {
		runtime,
		database,
		effectId: (name: string) => EffectId.make(name),
		dispose: async () => {
			await runtime.dispose();
			await database.close();
		}
	};
};

/** The admin subject every data test acts as unless it is specifically testing refusal. */
export const adminSubject: Identity.Subject = {
	userId: 'admin-1',
	tenantId: 'test-tenant',
	roles: ['admin'],
	teams: []
};

/**
 * Derived from the harness rather than restated.
 *
 * The hand-written version listed seven fewer services than the layer provides, so every dispatch
 * in a test was checked against a runtime that could not satisfy it — the mismatch surfaced as an
 * unrelated-looking complaint about a Database request not being an AI request.
 */
export type BoltTestRuntime = Awaited<ReturnType<typeof makeBoltTestRuntime>>;

/**
 * A stable UUID for a readable fixture name.
 *
 * Records are keyed by `norbital_id uuid`, so `'order-2'` is not a usable identifier — it was only
 * ever accepted because Bolt used to invent an `id text` primary key, which took any string. Tests
 * built rows a real database would have rejected, and passed.
 *
 * Derived rather than random so a failure names the same id twice and assertions stay legible:
 * `recordId('order-2')` reads as well as the literal did, and is valid where the literal was not.
 */
export const recordId = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	// Stamped to v5/variant-8 so Postgres accepts it as a well-formed UUID rather than merely hex.
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
