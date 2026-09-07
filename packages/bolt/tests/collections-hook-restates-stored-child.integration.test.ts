import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import {
	EffectId,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { authoredHooks, type Api } from '../src/authoring/contracts-schema.js';
import { AuthoredRefusal } from '../src/authoring/refusal.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import * as Workspace from '../src/runtime/workspace.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	TEST_ENVIRONMENT,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { seedSession } from './support/fixture-identity.js';

/**
 * A hook restating a stored child, grandchildren included, inside a browser mutation.
 *
 * The shape is hr-payroll's employment → entitlements → entries: a non-cascade edge at the first
 * level, so the ledger must restate its complete set of entitlements on every write, and a cascade
 * edge at the second, so each entitlement's entries are its own. An exit-date edit reaches the
 * engine as a browser push carrying a base version for the root and nothing else; the employment's
 * `before` returns the stored entitlements by id with their entries, and the engine has to read the
 * relation of a child the browser never declared before it can plan its grandchildren.
 *
 * `primeRelatedRows` used to classify every nested child of a browser mutation by the browser's
 * `baseVersions`, which is right for the caller's own payload and wrong for a workspace seed: a
 * hook-restated stored child was primed as a create, its relation never read, and `planRelation`
 * refused the grandchildren with `The write-wave read omitted relationship …` (learning 170,
 * RFC hook-authority-simplification §3). The caller's own nested payload keeps the browser rule.
 */
const definition = workspace({
	name: 'hook-restates-stored-child',
	version: '1.0.0',
	collections: [
		collection({ name: 'employments', fields: { name: field.string({ required: true }) } }),
		collection({
			name: 'entitlements',
			fields: {
				employment_id: field.uuid({ required: true }),
				kind: field.string({ required: true }),
				quantity: field.number({ required: true })
			}
		}),
		collection({
			name: 'entries',
			fields: {
				entitlement_id: field.uuid({ required: true }),
				code: field.string({ required: true }),
				amount: field.number({ required: true })
			}
		}),
		collection({
			name: 'facts',
			fields: {
				employment_id: field.uuid({ required: true }),
				note: field.string({ required: true })
			}
		})
	],
	relations: [
		{
			name: 'employment_entitlements',
			source: 'employments',
			target: 'entitlements',
			cardinality: 'many',
			from: { collection: 'employments', column: 'id' },
			to: { collection: 'entitlements', column: 'employment_id' }
		},
		{
			name: 'entitlement_entries',
			source: 'entitlements',
			target: 'entries',
			cardinality: 'many',
			from: { collection: 'entitlements', column: 'id' },
			to: { collection: 'entries', column: 'entitlement_id' },
			cascade: true
		}
	],
	apps: [app({ name: 'hr', label: 'HR' })],
	teams: { admin: ['admin-data'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: (['employments', 'entitlements', 'entries', 'facts'] as const).flatMap(
				(name) =>
					(['create', 'read', 'update', 'delete'] as const).map((action) => ({
						collection: name,
						action
					}))
			)
		})
	]
});

/** The fixture tables as a schema, so the hooks return graphs typed the way a compiled workspace's are. */
interface RestatementSchema {
	readonly tables: {
		readonly employments: {
			readonly $inferSelect: { readonly id: string; readonly name: string };
			readonly $inferInsert: { readonly id?: string; readonly name: string };
		};
		readonly entitlements: {
			readonly $inferSelect: {
				readonly id: string;
				readonly employment_id: string;
				readonly kind: string;
				readonly quantity: number;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly employment_id: string;
				readonly kind: string;
				readonly quantity: number;
			};
		};
		readonly entries: {
			readonly $inferSelect: {
				readonly id: string;
				readonly entitlement_id: string;
				readonly code: string;
				readonly amount: number;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly entitlement_id: string;
				readonly code: string;
				readonly amount: number;
			};
		};
		readonly facts: {
			readonly $inferSelect: {
				readonly id: string;
				readonly employment_id: string;
				readonly note: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly employment_id: string;
				readonly note: string;
			};
		};
	};
	readonly relations: {
		readonly employments: {
			readonly employment_entitlements: {
				readonly cardinality: 'many';
				readonly target: 'entitlements';
				readonly column: 'employment_id';
				readonly parentColumn: 'id';
			};
		};
		readonly entitlements: {
			readonly entitlement_entries: {
				readonly cardinality: 'many';
				readonly target: 'entries';
				readonly column: 'entitlement_id';
				readonly parentColumn: 'id';
			};
		};
	};
}

/**
 * The ledger's complete set for one employment: every stored entitlement by id, each carrying its
 * stored entries by id plus one new entry the write derives. The stored rows are restated so the
 * non-cascade edge deletes nothing; the new entry is the grandchild whose commit is under test.
 */
const restatedEntitlements = (api: Api<RestatementSchema, unknown>, employmentId: string, code: string) =>
	Effect.gen(function* () {
		const entitlements = yield* api.db.entitlements.findMany({
			where: { employment_id: { eq: employmentId } }
		});
		const entries = yield* api.db.entries.findMany({
			where: { entitlement_id: { in: entitlements.map((entitlement) => entitlement.id) } }
		});
		return entitlements.map((entitlement) => ({
			id: entitlement.id,
			kind: entitlement.kind,
			quantity: entitlement.quantity,
			entitlement_entries: [
				...entries
					.filter((entry) => entry.entitlement_id === entitlement.id)
					.map((entry) => ({ id: entry.id, code: entry.code, amount: entry.amount })),
				{ code, amount: 1 }
			]
		}));
	});

const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		employments: authoredHooks<RestatementSchema, 'employments'>({
			mutate: {
				perRecord: {
					before: {
						description: 'Restates the ledger every edit of a stored employment implies.',
						handler: ({ input, existing, relationships, api }) =>
							Effect.gen(function* () {
								// A caller who submitted the relation is judged on it; the ledger is the
								// workspace's only when the caller left it alone.
								if (existing === undefined || relationships.includes('employment_entitlements'))
									return input;
								return {
									...input,
									employment_entitlements: yield* restatedEntitlements(
										api,
										existing.id,
										`edit:${input.name ?? existing.name}`
									)
								};
							})
					}
				}
			}
		}),
		facts: authoredHooks<RestatementSchema, 'facts'>({
			mutate: {
				perRecord: {
					before: {
						description: 'Stages the employment ledger the new fact changes, then refuses one fact by name.',
						handler: ({ input, existing, api }) =>
							Effect.gen(function* () {
								if (existing !== undefined) return input;
								yield* api.db.employments.mutate([
									{
										id: input.employment_id,
										employment_entitlements: yield* restatedEntitlements(
											api,
											input.employment_id,
											`fact:${input.note}`
										)
									}
								]);
								if (input.note === 'refuse')
									return yield* Effect.fail(
										new AuthoredRefusal({ message: 'the fact is refused after staging' })
									);
								return input;
							})
					}
				}
			}
		})
	}
};

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make(TEST_ENVIRONMENT),
	releaseId: ReleaseId.make('local')
};

const MUTATION_PARTITION_KEY = 'sha256:hook-restates-partition';

let sequence = 0;
const command = (name: string, input: unknown) => {
	const invocationSequence = (sequence += 1);
	return Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${invocationSequence}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: ['Bearer admin-token'] }
	});
};

const schemaFingerprint = async (runtime: BoltTestRuntime): Promise<string> => {
	const workspaceService = await runtime.runtime.runPromise(Workspace.Service);
	const fingerprint = workspaceService.definition.schemaFingerprint;
	if (typeof fingerprint !== 'string')
		throw new TypeError('The test runtime provisioned no schema fingerprint.');
	return fingerprint;
};

type BaseVersion = Readonly<{
	readonly row: Readonly<{ readonly collection: string; readonly recordId: string }>;
	readonly rowVersion: number;
}>;

/** One browser push over the wire, as `collections.mutate` receives it from a client. */
const push = async (
	runtime: BoltTestRuntime,
	input: Readonly<{
		readonly idempotencyKey: string;
		readonly collection: string;
		readonly row: Readonly<{ readonly action: 'create' | 'update'; readonly values: Record<string, unknown> }>;
		readonly baseVersions?: ReadonlyArray<BaseVersion>;
	}>
) => {
	const fingerprint = await schemaFingerprint(runtime);
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(
			command('collections.mutate', {
				protocolVersion: 2,
				idempotencyKey: input.idempotencyKey,
				issuedAtEpochMs: Date.now(),
				partitionKey: MUTATION_PARTITION_KEY,
				schemaFingerprint: fingerprint,
				graph: { action: 'mutate', collection: input.collection, rows: [input.row] },
				baseVersions: input.baseVersions ?? []
			})
		)
	);
	return outcome.value as Readonly<Record<string, unknown>>;
};

const requiredId = (row: Readonly<Record<string, unknown>> | undefined, label: string): string => {
	const id = row?.['id'];
	if (typeof id !== 'string') throw new Error(`${label} has no id`);
	return id;
};

const requiredVersion = (row: Readonly<Record<string, unknown>> | undefined, label: string): number => {
	const version = row?.['row_version'];
	if (typeof version !== 'number') throw new Error(`${label} has no row_version`);
	return version;
};

/** An employment with two entitlements, each holding one stored entry, written server-side. */
const seedEmployment = async (runtime: BoltTestRuntime) => {
	await runtime.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).mutate(EffectId.make('seed-employment'), adminSubject, 'employments', [
				{
					name: 'Ada',
					employment_entitlements: [
						{ kind: 'annual', quantity: 14, entitlement_entries: [{ code: 'opening', amount: 14 }] },
						{ kind: 'sick', quantity: 10, entitlement_entries: [{ code: 'opening', amount: 10 }] }
					]
				}
			]);
		})
	);
	const employment = (await runtime.database.query('select id, row_version from employments'))[0];
	const entitlements = await runtime.database.query(
		'select id, row_version, kind from entitlements order by kind'
	);
	return {
		id: requiredId(employment, 'employment'),
		version: requiredVersion(employment, 'employment'),
		entitlements: entitlements.map((row) => ({
			id: requiredId(row, 'entitlement'),
			version: requiredVersion(row, 'entitlement'),
			kind: String(row['kind'])
		}))
	};
};

const entriesByEntitlement = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`select entitlements.kind, entries.code, entries.amount
		 from entries join entitlements on entitlements.id = entries.entitlement_id
		 order by entitlements.kind, entries.code`
	);

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const open = async (): Promise<BoltTestRuntime> => {
	const runtime = await makeBoltTestRuntime(definition, { authored });
	await seedSession(runtime, { token: 'admin-token', user: 'user-admin', team: 'admin' });
	return runtime;
};

describe('a hook restating a stored child inside a browser mutation', () => {
	it("commits the grandchildren of the stored children the root's before hook restates", async () => {
		harness = await open();
		const employment = await seedEmployment(harness);
		expect(employment.entitlements).toHaveLength(2);

		// The browser declares the root and nothing else: it edited the employment's name and never
		// saw the ledger the hook derives from it.
		const outcome = await push(harness, {
			idempotencyKey: 'exit-edit',
			collection: 'employments',
			row: { action: 'update', values: { id: employment.id, name: 'Ada (exited)' } },
			baseVersions: [
				{ row: { collection: 'employments', recordId: employment.id }, rowVersion: employment.version }
			]
		});
		expect(outcome, JSON.stringify(outcome)).toMatchObject({ resolution: 'accepted' });

		expect(await harness.database.query('select name from employments')).toEqual([
			{ name: 'Ada (exited)' }
		]);
		// Both stored entitlements survive the non-cascade restatement, and each gained the entry the
		// hook derived beside the one it already held.
		expect(await entriesByEntitlement(harness)).toEqual([
			{ kind: 'annual', code: 'edit:Ada (exited)', amount: 1 },
			{ kind: 'annual', code: 'opening', amount: 14 },
			{ kind: 'sick', code: 'edit:Ada (exited)', amount: 1 },
			{ kind: 'sick', code: 'opening', amount: 10 }
		]);
	}, 90_000);

	it("commits a sibling hook's staged restatement of the root, grandchildren included, in the fact's transaction", async () => {
		harness = await open();
		const employment = await seedEmployment(harness);
		const factId = '00000000-0000-4000-8000-00000000f001';

		const outcome = await push(harness, {
			idempotencyKey: 'fact-taken',
			collection: 'facts',
			row: { action: 'create', values: { id: factId, employment_id: employment.id, note: 'taken' } }
		});
		expect(outcome, JSON.stringify(outcome)).toMatchObject({ resolution: 'accepted' });
		expect(await harness.database.query('select id, note from facts')).toEqual([
			{ id: factId, note: 'taken' }
		]);
		expect(await entriesByEntitlement(harness)).toEqual([
			{ kind: 'annual', code: 'fact:taken', amount: 1 },
			{ kind: 'annual', code: 'opening', amount: 14 },
			{ kind: 'sick', code: 'fact:taken', amount: 1 },
			{ kind: 'sick', code: 'opening', amount: 10 }
		]);

		// One transaction: the hook stages the same restatement and then refuses its own record, and
		// neither the fact nor the staged ledger lands.
		const refused = await push(harness, {
			idempotencyKey: 'fact-refused',
			collection: 'facts',
			row: {
				action: 'create',
				values: { id: '00000000-0000-4000-8000-00000000f002', employment_id: employment.id, note: 'refuse' }
			}
		});
		expect(refused).toMatchObject({
			resolution: 'rejected',
			code: 'refused',
			message: 'the fact is refused after staging'
		});
		expect(await harness.database.query('select note from facts')).toEqual([{ note: 'taken' }]);
		expect((await entriesByEntitlement(harness)).map((row) => row['code'])).toEqual([
			'fact:taken',
			'opening',
			'fact:taken',
			'opening'
		]);
	}, 90_000);

	it("keeps the browser base-version rule for the caller's own nested payload", async () => {
		harness = await open();
		const employment = await seedEmployment(harness);
		const [annual, sick] = employment.entitlements;
		if (annual === undefined || sick === undefined) throw new Error('two entitlements were seeded');
		const values = {
			id: employment.id,
			name: 'Ada (edited)',
			employment_entitlements: [
				{ id: annual.id, quantity: 15 },
				{ id: sick.id }
			]
		};
		const rootVersion = {
			row: { collection: 'employments', recordId: employment.id },
			rowVersion: employment.version
		};
		const sickVersion = { row: { collection: 'entitlements', recordId: sick.id }, rowVersion: sick.version };

		// The caller submitted the entitlement itself, so it is the caller's row: a stale whole-row
		// base version on it is a conflict, exactly as before the workspace-seed rule.
		const stale = await push(harness, {
			idempotencyKey: 'caller-stale-child',
			collection: 'employments',
			row: { action: 'update', values },
			baseVersions: [
				rootVersion,
				{ row: { collection: 'entitlements', recordId: annual.id }, rowVersion: 99 },
				sickVersion
			]
		});
		expect(stale, JSON.stringify(stale)).toMatchObject({ resolution: 'rejected', code: 'conflict' });
		expect(await harness.database.query('select name from employments')).toEqual([{ name: 'Ada' }]);
		expect(await harness.database.query('select quantity from entitlements where id = $1', [annual.id])).toEqual([
			{ quantity: 14 }
		]);

		// The same payload with the versions the browser really read is accepted: the refusal above
		// was the stale version, not the nesting.
		const fresh = await push(harness, {
			idempotencyKey: 'caller-fresh-child',
			collection: 'employments',
			row: { action: 'update', values },
			baseVersions: [
				rootVersion,
				{ row: { collection: 'entitlements', recordId: annual.id }, rowVersion: annual.version },
				sickVersion
			]
		});
		expect(fresh, JSON.stringify(fresh)).toMatchObject({ resolution: 'accepted' });
		expect(await harness.database.query('select name from employments')).toEqual([
			{ name: 'Ada (edited)' }
		]);
		expect(await harness.database.query('select quantity from entitlements where id = $1', [annual.id])).toEqual([
			{ quantity: 15 }
		]);
		// The caller's relation stood, so the hook derived nothing: the ledger is untouched.
		expect((await entriesByEntitlement(harness)).map((row) => row['code'])).toEqual(['opening', 'opening']);
	}, 90_000);
});
