import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { ConfigProvider, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import {
	EffectId,
	InvocationId,
	type AIRequest,
	type AIResponse,
	type CommunicationRequest,
	type CommunicationResponse,
	type ConnectorRequest,
	type ConnectorResponse,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type FacilityCall,
	type FileRequest,
	type FileResponse,
	type IdentityHookRequest,
	type IdentityHookResponse,
	type TaskRequest,
	type TaskResponse,
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
import { policyRuntimeFunctionsFor } from '../../src/authoring/policy-introspection.js';
import { buildSchemaPlan, collectionIndexName } from '../../src/compiler/schema-plan.js';
import { planWorkspaceMigration } from '../../src/compiler/schema-migrations.js';
import {
	boolean,
	doublePrecision,
	jsonb,
	timestamp as pgInstant,
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
		Object.entries(collection.fields).flatMap(([name, field]) => {
			// A logical reference is an exclusive arc of nullable UUID columns in PostgreSQL. The
			// runtime verifies those storage columns, not the client-facing `{ kind, id }` field.
			if (field.reference !== undefined) {
				return field.reference.targets.map(({ storageColumn }) => [
					storageColumn,
					uuidColumn(storageColumn)
				]);
			}
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
							: field.type === 'instant'
								? pgInstant(name, { withTimezone: true, mode: 'string' })
								: field.type === 'json'
									? jsonb(name)
									: authoredText({ search: field.search === true });
			return [[name, field.required ? base.notNull() : base] as const];
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
		// Extensions, functions and `bolt_*` tables: generated columns call `bolt_date` and the
		// trigram indexes need `pg_trgm`.
		...plan.filter(({ id }) => id.startsWith('bolt:')),
		...(migration?.statements ?? []).map((sql, index) => ({ id: `lineage:${index}`, sql })),
		// EXCLUDE constraints and Bolt's own system collections.
		...plan.filter(({ id }) => !id.startsWith('bolt:'))
	];
};

import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import * as ChatDocuments from '../../src/runtime/agents/documents.js';
import * as Automations from '../../src/runtime/automations/automations.js';
import * as Envoys from '../../src/runtime/envoys/envoys.js';
import * as Integrations from '../../src/runtime/integrations/integrations.js';
import * as Notifications from '../../src/runtime/notifications/notifications.js';
import * as WorkspaceSchema from '../../src/runtime/schema/workspace-schema.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as SyncWake from '../../src/runtime/sync/wake.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime,
	type AuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import * as Database from '../../src/runtime/facilities/database.js';
import type { CallContext } from '../../src/runtime/facilities/database.js';
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
import * as Identity from '../../src/runtime/identity/identity.js';
import { remoteRegistryLayer } from '../../src/runtime/remotes.js';
import * as InvocationBudget from '../../src/runtime/budget.js';
import * as RateLimits from '../../src/runtime/rate-limits.js';
import * as TenantScope from '../../src/runtime/tenant.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { PersonalSecrets } from '../../src/runtime/secrets/personal-secrets.js';
import { SECRET_KEY_VARIABLE, SecretCipher } from '@norbital-ai/std/secret';
import * as Sync from '../../src/runtime/sync/sync.js';
import * as TaskQueue from '../../src/runtime/tasks/tasks.js';
import * as Workspace from '../../src/runtime/workspace.js';

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
/** The tenant every fixture is scoped to, named once so a minted subject and a subject fixture agree. */
export const TEST_TENANT = 'test-tenant';

const context: CallContext = {
	invocationId: InvocationId.make('test-invocation'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	environment: TEST_ENVIRONMENT,
	tenantId: TEST_TENANT
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
		readonly tenantId?: string;
	} = {}
): CallContext => ({
	invocationId: InvocationId.make(invocationId),
	deadlineEpochMs: options.deadlineEpochMs ?? Date.now() + 10_000,
	environment: options.environment ?? TEST_ENVIRONMENT,
	tenantId: options.tenantId ?? TEST_TENANT
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
					let rows: ReadonlyArray<Schema.Json> = [];
					await database.transaction(async (transaction) => {
						for (const statement of input.statements) {
							statements.push(statement.sql);
							const result = await transaction.query<Record<string, unknown>>(statement.sql, [
								...statement.parameters
							]);
							affectedRows += result.affectedRows ?? 0;
							// A transaction has one result surface: the rows returned by its final statement.
							// This is how both production database bindings behave, and it matters when earlier
							// assertions also happen to return rows before a final commit-capture SELECT.
							rows = jsonSafe(result.rows);
						}
					});
					return { _tag: 'Success', value: { rows, affectedRows } };
				} catch (cause) {
					const sqlState =
						typeof cause === 'object' && cause !== null ? Reflect.get(cause, 'code') : undefined;
					return {
						_tag: 'Failure',
						error: {
							code: 'database.failed',
							message: cause instanceof Error ? cause.message : String(cause),
							retryable: sqlState === '40001',
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
		readonly description?: string;
		readonly icon?: string;
	}>;
	readonly policies?: ReadonlyArray<PolicyDeclaration>;
	readonly teams?: Readonly<Record<string, ReadonlyArray<string>>>;
	/** `src/+agents.md`, when a test cares what the system message says. */
	readonly prompt?: string;
	/** The workspace's authored tools; a policy still has to name one for anybody to reach it. */
	readonly tools?: WorkspaceDefinition['tools'];
	readonly skills?: WorkspaceDefinition['skills'];
	readonly envoys?: WorkspaceDefinition['envoys'];
	readonly automations?: WorkspaceDefinition['automations'];
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
		).map(collection),
		apps: [],
		policies: input.policies ?? [
			policy({
				name: 'admin',
				effect: 'allow',
				actions: ['*'],
				capabilities: { apps: ['*'] }
			})
		],
		/**
		 * One team per declared policy, named after it.
		 *
		 * Authority is a team's now, and a team's policies are declared rather than stored — so a
		 * fixture that wants a subject holding the `manager` policy needs a team that declares it.
		 * Minting one per policy keeps every test's intent legible as `teamPath: ['manager']`, which
		 * reads as "holds exactly the manager policy" and is exactly what the old `teamPath: ['manager']`
		 * meant. A test that wants a team combining several declares its own `teams`.
		 */
		teams:
			input.teams ??
			(() => {
				const declared = input.policies ?? [{ name: 'admin' } as PolicyDeclaration];
				return {
					// One team per policy, so `teamPath: ['orders-reader']` reads as "holds exactly that".
					...Object.fromEntries(declared.map(({ name }) => [name, [name]])),
					// And an `admin` team holding all of them, which is what the fixtures that used to say
					// `roles: ['admin']` against policies declaring `roles: ['admin']` actually meant.
					admin: declared.map(({ name }) => name)
				};
			})(),
		// A workspace's shared system prompt. Required of a real workspace — the compiler refuses one
		// without `src/+agents.md` — so the fixture states one rather than leaving it absent.
		prompt: input.prompt ?? 'You are the test workspace agent.',
		tools: input.tools ?? [],
		skills: input.skills ?? [],
		automations: input.automations ?? [],
		envoys: input.envoys ?? [],
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
		readonly ai?: FacilityBinding<AIRequest, AIResponse>;
		readonly connector?: FacilityBinding<ConnectorRequest, ConnectorResponse>;
		readonly communication?: FacilityBinding<CommunicationRequest, CommunicationResponse>;
		readonly files?: FacilityBinding<FileRequest, FileResponse>;
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
	const tasks = makeTestTasks();
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
	const testSchemaFingerprint = `sha256:${createHash('sha256')
		.update(JSON.stringify({ collections: definition.collections, relations: definition.relations }))
		.digest('hex')}`;
	const provisioned: WorkspaceDefinition = {
		...definition,
		migrations: [baseline, ...(definition.migrations ?? [])],
		mutationCompatibility:
			definition.mutationCompatibility ?? {
				offlineHorizonMillis: 14 * 24 * 60 * 60 * 1000,
				currentSchemaFingerprint: testSchemaFingerprint,
				adapters: []
			}
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
		AI.layer(bindings.ai, context),
		Communication.layer(bindings.communication, context),
		Connector.layer(bindings.connector, context),
		Files.layer(bindings.files, context),
		HostTools.layer(undefined, context),
		IdentityHooks.layer(bindings.identityHooks, context),
		Tasks.layer(tasks.binding, context),
		Transport.layer(bindings.transport, context)
	);
	const workspaceLayer = Workspace.layer(provisioned);
	// A compiled tenant runtime carries the live closures captured while its strict policy modules
	// are described. Mirror that boundary here so a test cannot accidentally serialize the marker
	// half of a policy and omit the implementation half.
	const declaredPolicyFunctions = policyRuntimeFunctionsFor(definition.policies);
	const suppliedAuthored = bindings.authored ?? emptyAuthoredRuntime;
	const authoredLayer = Layer.succeed(AuthoredRuntimeService, {
		...suppliedAuthored,
		policyAuthorizations: {
			...declaredPolicyFunctions.authorizations,
			...suppliedAuthored.policyAuthorizations
		},
		approvalFlows: {
			...declaredPolicyFunctions.approvalFlows,
			...suppliedAuthored.approvalFlows
		}
	});
	// The task queue, over the database facility and the host's timer. Everything that used to enqueue
	// through the tasks facility — automations, approvals, integrations, agents — writes a `bolt_task`
	// row through this instead, and wakes the host through the facility bound above.
	const wake = Layer.provideMerge(SyncWake.layer, facilities);
	const taskQueue = TaskQueue.layer(context).pipe(Layer.provide(Layer.merge(facilities, wake)));
	const foundation = Layer.provideMerge(
		Layer.mergeAll(Identity.layer, AccessControl.layer),
		Layer.mergeAll(workspaceLayer, facilities, taskQueue)
	);
	// The budget an invocation carries. Zero depth, because a test drives the runtime directly rather
	// than through a task the runtime itself enqueued — which is the only thing that produces a
	// non-zero one. Provided rather than defaulted so a service that starts consulting it fails here
	// instead of silently reading a stand-in.
	// The workspace's pre-sign-in rate policy, or none. A test workspace declares none, so every
	// anonymous command is admitted uncounted — which is what a suite about anything else needs, and
	// what a suite about the limiter overrides by building its own. A *holder's* limits are resolved
	// per subject from the policies they hold and never come from here.
	const rateLimits = RateLimits.layer(definition.rateLimits);
	const budget = InvocationBudget.layer(0);
	// Which tenant this runtime is for. It is provided rather than defaulted because a *static*
	// identity — an envoy, an automation — is minted with a tenant and has no row to read one off, so
	// a service that reached for it and found nothing would mint a subject scoped to nowhere.
	const tenantScope = TenantScope.layer(context.tenantId, context.environment);
	// Automations sits above Collections rather than below it: starting one is a declaration check, a
	// nesting check, and a row on the queue, and the authored api Collections hands a hook carries
	// `automations.run`, so Collections is the consumer.
	const automations = Automations.layer.pipe(
		Layer.provide(Layer.mergeAll(workspaceLayer, taskQueue, budget, tenantScope))
	);
	// Collections announces every committed write on the sync topic, so the wake has to be present for
	// the write path to resolve at all. The harness binds no transport, which is the point: the
	// announcement is `Effect.ignore`d, so a runtime with nowhere to publish still writes normally.
	const data = Layer.provideMerge(Approvals.layer, Layer.mergeAll(foundation, taskQueue, wake));
	const collections = Layer.provideMerge(
		Collections.layer,
		Layer.mergeAll(data, authoredLayer, wake, taskQueue, automations, tenantScope)
	);
	// Dispatch resolves authored remotes through this registry, and the registry resolves them
	// through Collections — so it layers over them, not alongside the facilities. No handlers are
	// registered: a test that calls one should fail on the missing name, not a missing service.
	const remotes = Layer.provideMerge(remoteRegistryLayer({}), collections);
	const chatDocuments = ChatDocuments.layer.pipe(Layer.provide(Layer.mergeAll(facilities, wake)));
	// Dispatch routes agent commands too, so the service has to be present for the command surface to
	// typecheck — its AI facility is bound unavailable, so calling one fails rather than pretending.
	const agents = Layer.provideMerge(
		Agents.layer,
		Layer.mergeAll(remotes, taskQueue, budget, wake, chatDocuments)
	);
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
		Layer.mergeAll(Envoys.layer, Integrations.layer, Notifications.layer, WorkspaceSchema.layer),
		Layer.mergeAll(
			vault,
			authoredLayer,
			budget,
			taskQueue,
			automations,
			rateLimits,
			tenantScope,
			wake,
			chatDocuments
		)
	);
	const complete = Layer.provideMerge(
		Sync.layer,
		Layer.mergeAll(surfaces, authoredLayer, budget, rateLimits, tenantScope)
	);

	const runtime = ManagedRuntime.make(complete);
	return {
		runtime,
		database,
		tasks,
		effectId: (name: string) => EffectId.make(name),
		dispose: async () => {
			await runtime.dispose();
			await database.close();
		}
	};
};

/** A subject with both explicit `admin` team grants and administrative status. */
export const adminSubject: Identity.Subject = {
	userId: 'admin-1',
	tenantId: TEST_TENANT,
	teamPath: ['admin'],
	// A person holds policies through their team, never directly. The array is what a *static*
	// identity carries, and this fixture is a person.
	policies: [],
	// Administrative status is the runtime's complete workspace bypass. The team and authored
	// policies above are still used by ordinary subjects and explicit team previews.
	admin: true
};

/**
 * Binds the host's tasks facility to a sink, recording what it was asked to hold.
 *
 * The runtime's only message to this facility is `Wake` — "come back no later than this instant" —
 * so the sink's job is to accept it and remember it, never to act on it: a test runtime has no host
 * timer, and a write that queued work must succeed whether or not one is listening. Recording is
 * what lets a test assert that the host was told, which is the observable half of the contract.
 */
export const makeTestTasks = (): {
	readonly binding: FacilityBinding<TaskRequest, TaskResponse>;
	readonly requests: ReadonlyArray<TaskRequest>;
	readonly effectIds: ReadonlyArray<string>;
	readonly forget: () => void;
} => {
	const requests: Array<TaskRequest> = [];
	const effectIds: Array<string> = [];
	return {
		binding: {
			call: async (metadata, input) => {
				requests.push(input);
				effectIds.push(String(metadata.effectId));
				return { _tag: 'Success', value: {} };
			}
		},
		requests,
		effectIds,
		forget: () => {
			requests.length = 0;
			effectIds.length = 0;
		}
	};
};

/** The harness as a type, derived rather than restated so the two can never disagree. */
export type BoltTestRuntime = Awaited<ReturnType<typeof makeBoltTestRuntime>>;

/**
 * A stable UUID for a readable fixture name.
 *
 * Records are keyed by `id uuid`, so `'order-2'` is not a usable identifier — it was only
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
