import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BundleManifest,
	EffectId,
	EnvironmentName,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type Activation,
	type ConnectorRequest,
	type ConnectorResponse,
	type FacilityBinding,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import {
	describeIntegrations,
	manifestIntegrations
} from '../../src/authoring/integration-introspection.js';
import { renderArtifact } from '../../src/compiler/workspace-build.js';
import {
	collection,
	defineConnection,
	definePull,
	field,
	policy,
	workspace,
	type CompiledAuthoring
} from '../../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import * as Integrations from '../../src/runtime/integrations/integrations.js';
import {
	makeBoltTestRuntime,
	makeTestDatabase,
	provisioningStatements,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The two halves of "an authored schedule actually runs".
 *
 * Neither existed. `schedule` was carried from `+integrations.ts` through the compiler into
 * `workspace.integrations` and read by nothing — `grep -rn '\.schedule\b' src/runtime/` returned
 * nothing at all — and `buildManifest` consulted `workspace.integrations` only to hash it into the
 * fingerprint, so a host could not even see that an integration existed. A pull therefore ran
 * exactly once, when install or reconcile enqueued one, and every template's cron was decoration.
 *
 * What Bolt can honestly do about that is bounded, and these tests are deliberately scoped to it.
 * The artifact is sandboxed tenant code with no timer that outlives an invocation, so the clock is
 * the host's; Bolt's job is to *state* the recurrence somewhere a host reads, and to make one pull
 * safe to be invoked by that host repeatedly and concurrently. The trigger itself is Colony's to
 * implement against the registration proven below.
 */

/* -------------------------------------------------------------------------------------------------
 * An authored `+integrations.ts` with two bindings on two different schedules — which is the case
 * that makes a per-integration schedule wrong and a per-binding one necessary.
 * ---------------------------------------------------------------------------------------------- */

const erp = defineConnection({ baseUrl: 'https://erp.example/api' });

const Vendor = Schema.Struct({ code: Schema.NonEmptyString, title: Schema.NonEmptyString });

const authoredModule = {
	erp: {
		policies: ['admin'],
		connection: erp,
		receive: {
			vendors: definePull({
				pull: {
					schedule: '15 * * * *',
					method: 'GET',
					path: '/vendors',
					cursor: { send: { query: 'since' }, next: { field: 'next' } }
				},
				input: Vendor,
				records: { field: 'items' },
				identity: { column: 'external_id', value: (vendor) => vendor.code },
				map: (vendor) => ({ source: 'vendors', title: vendor.title })
			}),
			invoices: definePull({
				pull: {
					schedule: '0 3 * * *',
					method: 'GET',
					path: '/invoices',
					pages: { style: 'offset', offsetQuery: 'offset', limitQuery: 'limit', size: 50, max: 4 },
					cursor: { send: { query: 'since' }, next: { field: 'next' } }
				},
				input: Vendor,
				records: { field: 'items' },
				identity: { column: 'external_id', value: (entry) => entry.code },
				map: (entry) => ({ source: 'invoices', title: entry.title })
			})
		}
	}
};

const described = describeIntegrations({ mirrored: authoredModule });

const definition = workspace({
	name: 'scheduled-pull',
	version: '1',
	collections: [
		collection({
			name: 'mirrored',
			fields: {
				external_id: field.string({ required: true, indexed: true }),
				source: field.string({ required: true }),
				title: field.string()
			}
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	integrations: described.declarations,
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database', 'connector'],
	schemaFingerprint: 'sha256:scheduled-pull-fixture'
});

const manifest = buildManifest(definition, { artifactId: 'scheduled-pull' });

const compiledAuthoring = {
	collections: [],
	relationships: [],
	customTypeReferences: [],
	capabilities: { skills: [], mcp: [] }
} satisfies CompiledAuthoring;

/* -------------------------------------------------------------------------------------------------
 * Part one: the manifest.
 * ---------------------------------------------------------------------------------------------- */

describe('a host can read an integration out of the manifest', () => {
	/**
	 * `requiredFacilities` and the asset indexes are already in the manifest because a host has to
	 * know what a tenant runtime needs and what it serves. What it wants recurring is the same class
	 * of fact, and it was the one the manifest did not carry.
	 */
	it('publishes the declaration half of every binding, schedule included', () => {
		expect(manifest.integrations).toEqual([
			{
				name: 'mirrored.erp',
				collection: 'mirrored',
				receive: [
					{
						name: 'vendors',
						schedule: '15 * * * *',
						method: 'GET',
						path: '/vendors',
						cursor: { send: { query: 'since' }, next: { field: 'next' } },
						identityColumn: 'external_id'
					},
					{
						name: 'invoices',
						schedule: '0 3 * * *',
						method: 'GET',
						path: '/invoices',
						cursor: { send: { query: 'since' }, next: { field: 'next' } },
						pages: {
							style: 'offset',
							offsetQuery: 'offset',
							limitQuery: 'limit',
							size: 50,
							max: 4
						},
						identityColumn: 'external_id'
					}
				]
			}
		]);
	});

	/**
	 * The manifest crosses a wire, so what matters is not that the object looks right in this process
	 * but that it survives being decoded as the protocol's own schema. A field the schema does not
	 * declare would be dropped here rather than in a host, months later.
	 */
	it('round-trips through the protocol schema it is declared with', async () => {
		const decoded = await Effect.runPromise(
			Schema.decodeUnknownEffect(BundleManifest)(JSON.parse(JSON.stringify(manifest)))
		);
		expect(decoded.integrations[0]?.receive[0]?.schedule).toBe('15 * * * *');
		expect(decoded.integrations[0]?.receive[1]?.pages).toEqual({
			style: 'offset',
			offsetQuery: 'offset',
			limitQuery: 'limit',
			size: 50,
			max: 4
		});
	});

	/**
	 * And the same fact about the artifact the compiler actually emits.
	 *
	 * `buildManifest` is not what an artifact runs: `renderArtifact` writes its manifest as a literal
	 * assembled at compile time, so publishing integrations from the builder alone reached every test
	 * here and no `bundle.mjs` on disk. The emitted statement is executed rather than pattern-matched
	 * — a grep would pass on the spelling of a line — with the real projection supplied, so this fails
	 * if the artifact stops composing its manifest from the integrations it described at boot.
	 */
	it('is composed into the manifest the emitted artifact actually builds', () => {
		const artifact = renderArtifact({
			metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
			compiledAuthoring,
			collectionHooks: [],
			apps: [],
			policies: [],
			functions: [],
			toolFiles: [],
			envoyFiles: [],
			automations: [],
			automationFiles: [],
			pipelineFiles: [],
			prompt: 'You are the test workspace agent.',
			root: '/workspace',
			assetIndex: { browser: [], server: [] },
			customTypeDefinitions: [],
			environmentFile: undefined,
			migrations: [],
			schemaFingerprint: 'sha256:fixture'
		});
		const start = artifact.indexOf('const manifestValue = ');
		const end = artifact.indexOf('\nconst remoteHandlers', start);
		if (start < 0 || end < 0) throw new Error('the artifact no longer assembles a manifestValue');
		const built = new Function(
			'workspace',
			'buildManifest',
			'browserAssets',
			'serverAssets',
			'describedIntegrations',
			'manifestIntegrations',
			`${artifact.slice(start, end)}\nreturn manifestValue;`
		)(definition, buildManifest, [], [], described, manifestIntegrations) as Readonly<
			Record<string, unknown>
		>;
		expect(built['integrations']).toEqual(manifest.integrations);
	});

	/**
	 * The connection is deliberately absent. Its `{ env }` references name entries in the tenant's
	 * vault, and the manifest is the one artifact surface that travels to places where a tenant's
	 * credential names have no business being discussed.
	 */
	it('does not publish the connection or its credential references', () => {
		expect(JSON.stringify(manifest.integrations)).not.toContain('erp.example');
	});
});

/* -------------------------------------------------------------------------------------------------
 * Part two: the registration.
 * ---------------------------------------------------------------------------------------------- */

const activation: Activation = {
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make('activation-scheduled-pull'),
	scope: {
		tenantId: TenantId.make('tenant-1'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('release-1')
	},
	deadlineEpochMs: Date.now() + 10_000,
	reason: 'deploy'
};

/** Records what `activate` asks the host to hold, which is the only observable side of registration. */
const recordingTasks = (): {
	readonly binding: FacilityBinding<TaskRequest, TaskResponse>;
	readonly requests: ReadonlyArray<TaskRequest>;
} => {
	const requests: Array<TaskRequest> = [];
	return {
		binding: {
			call: async (_metadata, input) => {
				requests.push(input);
				return { _tag: 'Success', value: {} };
			}
		},
		requests
	};
};

/**
 * `activate` refuses before it registers anything when a required facility is unbound, and this
 * workspace requires both. The connector is never reached during activation, so it is bound to a
 * refusal rather than to a fake: a registration path that started calling it should fail here
 * loudly. The database is real, because activation now declares this release's schedules by
 * writing them into the tenant's own `bolt_schedule`.
 */
const unreachable = <Input, Output>(name: string): FacilityBinding<Input, Output> => ({
	call: async () => ({
		_tag: 'Failure',
		error: {
			code: `${name}.unreachable`,
			message: `activation must not call ${name}`,
			retryable: false,
			outcome: 'known'
		}
	})
});

const provisionedDatabase = async (): Promise<Awaited<ReturnType<typeof makeTestDatabase>>> => {
	const database = await makeTestDatabase();
	for (const step of await provisioningStatements(definition)) {
		const result = await database.binding.call(
			{
				invocationId: activation.id,
				effectId: EffectId.make(`provision:${step.id}`),
				deadlineEpochMs: activation.deadlineEpochMs,
				idempotencyKey: step.id
			},
			{ _tag: 'Query', sql: step.sql, parameters: [] },
			new AbortController().signal
		);
		if (result._tag !== 'Success')
			throw new Error(`provisioning ${step.id} failed: ${JSON.stringify(result)}`);
	}
	return database;
};

const activationFacilities = (
	tasks: FacilityBinding<TaskRequest, TaskResponse>,
	database: Awaited<ReturnType<typeof makeTestDatabase>>
) => ({
	scope: activation.scope,
	tasks,
	database: database.binding,
	connector: unreachable<ConnectorRequest, ConnectorResponse>('connector')
});

describe('activation hands the host the schedule', () => {
	it('writes one schedule row per binding, carrying its cron and its input', async () => {
		const tasks = recordingTasks();
		const database = await provisionedDatabase();
		try {
			const bundle = makeBundle(definition, manifest);
			const result = await bundle.activate(
				activation,
				activationFacilities(tasks.binding, database),
				new AbortController().signal
			);
			if (result._tag !== 'Activated')
				throw new Error(`activation failed: ${JSON.stringify(result)}`);
			// Registration is routing, and only routing: a host no longer needs to learn a cron to hold
			// one, because the guest is the only party that can read a release's declarations. One
			// routing registration per command.
			expect(result.registrations.filter(({ command }) => command === 'integrations.pull')).toEqual(
				[{ command: 'integrations.pull' }]
			);
			const schedules = await database.query(
				'select key, command, crontab, input from bolt_schedule order by key',
				[]
			);
			expect(schedules).toEqual([
				{
					key: 'integrations.pull:mirrored.erp.invoices',
					command: 'integrations.pull',
					crontab: '0 3 * * *',
					input: { name: 'mirrored.erp', binding: 'invoices', cursor: null }
				},
				{
					key: 'integrations.pull:mirrored.erp.vendors',
					command: 'integrations.pull',
					crontab: '15 * * * *',
					input: { name: 'mirrored.erp', binding: 'vendors', cursor: null }
				}
			]);
			// The host is told the one number it can act on: when anything is next due.
			expect(typeof result.nextDueAtEpochMs).toBe('number');
		} finally {
			await database.close();
		}
	});

	/**
	 * A schedule that exists only in the return value would look wired from here and do nothing on a
	 * host. The row is what a host's timer eventually reads, so it is asserted as a row: the two
	 * bindings share a command, and their schedule keys are what keep them apart.
	 */
	it('gives every schedule of the same command a distinct key', async () => {
		const tasks = recordingTasks();
		const database = await provisionedDatabase();
		try {
			const bundle = makeBundle(definition, manifest);
			const result = await bundle.activate(
				activation,
				activationFacilities(tasks.binding, database),
				new AbortController().signal
			);
			if (result._tag !== 'Activated')
				throw new Error(`activation failed: ${JSON.stringify(result)}`);
			const rows = await database.query(
				'select key from bolt_schedule where command = $1 order by key',
				['integrations.pull']
			);
			expect(rows.map((row) => row['key'])).toEqual([
				'integrations.pull:mirrored.erp.invoices',
				'integrations.pull:mirrored.erp.vendors'
			]);
			// One routing registration per command — the host is told where work may arrive, once.
			const registers = tasks.requests.filter(
				(request) => request._tag === 'Register' && request.command === 'integrations.pull'
			);
			expect(registers).toEqual([
				{
					_tag: 'Register',
					releaseId: activation.scope.releaseId,
					command: 'integrations.pull'
				}
			]);
		} finally {
			await database.close();
		}
	});
});

/* -------------------------------------------------------------------------------------------------
 * Part three: what has to be true for a host to be allowed to fire that registration repeatedly.
 * ---------------------------------------------------------------------------------------------- */

type Answer = Readonly<{ status: number; body: Schema.Json }>;

/** A connector that answers from a script and records the URLs it was asked for. */
const scriptedConnector = (
	answers: ReadonlyArray<Answer>
): {
	readonly binding: FacilityBinding<ConnectorRequest, ConnectorResponse>;
	readonly urls: ReadonlyArray<string>;
} => {
	const urls: Array<string> = [];
	let index = 0;
	return {
		binding: {
			call: async (_metadata, input) => {
				const request = input.input;
				const url =
					request !== null && typeof request === 'object' && !Array.isArray(request)
						? String(Reflect.get(request, 'url'))
						: '';
				urls.push(url);
				const answer = answers[Math.min(index, answers.length - 1)] ?? {
					status: 200,
					body: { items: [] }
				};
				index += 1;
				return {
					_tag: 'Success',
					value: { output: { status: answer.status, headers: {}, body: answer.body } }
				};
			}
		},
		urls
	};
};

let harness: BoltTestRuntime | undefined;

afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const pull = (run: string, binding?: string) => {
	const current = harness;
	if (current === undefined) throw new Error('harness not built');
	return current.runtime.runPromise(
		Effect.flatMap(Integrations.Service, (integrations) =>
			integrations.pull(EffectId.make(run), 'mirrored.erp', null, binding)
		)
	);
};

/** The report crosses as `Schema.Json`, so it is read the way a host would have to read it. */
const at = (value: Schema.Json, key: string): unknown =>
	value === null || typeof value !== 'object' || Array.isArray(value)
		? undefined
		: Reflect.get(value, key);

const storedCursor = async (): Promise<unknown> => {
	const current = harness;
	if (current === undefined) throw new Error('harness not built');
	const rows = await current.database.query(
		'select cursor from bolt_integrations where name = $1',
		['mirrored.erp']
	);
	return rows[0]?.['cursor'];
};

describe('a scheduled pull is safe to fire repeatedly', () => {
	/**
	 * The point of a schedule is the *second* run, and the second run is only worth anything if it
	 * starts where the first stopped. This asserts it at the wire — the `since` query parameter the
	 * runtime put on the request — rather than by reading the cursor row, because a cursor that is
	 * persisted and never sent back is the same as no cursor at all.
	 */
	it('resumes the second run from the cursor the first one persisted', async () => {
		const connector = scriptedConnector([
			{ status: 200, body: { next: 'cursor-1', items: [{ code: 'v-1', title: 'First' }] } },
			{ status: 200, body: { next: 'cursor-2', items: [{ code: 'v-1', title: 'Renamed' }] } }
		]);
		harness = await makeBoltTestRuntime(definition, {
			connector: connector.binding,
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
		await pull('run-1', 'vendors');
		await pull('run-2', 'vendors');
		expect(connector.urls[0]).not.toContain('since=');
		expect(connector.urls[1]).toContain('since=cursor-1');
		// And the mirror is a mirror: the same external key updated in place rather than inserted twice.
		const rows = await harness.database.query('select external_id, title from mirrored', []);
		expect(rows).toEqual([{ external_id: 'v-1', title: 'Renamed' }]);
	});

	/**
	 * Two bindings, two crons, two cursors. The stored cursor is a `{ binding: value }` object and a
	 * run that persisted it as a whole object would write back a snapshot taken before the other
	 * binding's run — so the nightly feed's progress would be silently reverted every hour.
	 */
	it('leaves the cursor of a binding it did not run exactly where it was', async () => {
		const connector = scriptedConnector([
			{ status: 200, body: { next: 'invoices-1', items: [] } },
			{ status: 200, body: { next: 'vendors-1', items: [] } }
		]);
		harness = await makeBoltTestRuntime(definition, {
			connector: connector.binding,
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
		await pull('run-invoices', 'invoices');
		await pull('run-vendors', 'vendors');
		expect(await storedCursor()).toEqual({ invoices: 'invoices-1', vendors: 'vendors-1' });
	});

	/**
	 * A cron fires on its own clock, so a run that outlives its interval and the next tick genuinely
	 * coexist. The second one has to decline rather than proceed: two runs of the same binding read
	 * the same resumption point and the slower one persists a cursor computed from a window the
	 * faster one already passed, which does not error — the mirror just stops making progress.
	 *
	 * Declining is reported, not swallowed. `skipped: true` with a reason is a different answer from
	 * "ran, imported nothing", and only one of them is fine.
	 */
	it('declines a second run while the first still holds the lease, and says so', async () => {
		const connector = scriptedConnector([{ status: 200, body: { next: 'cursor-1', items: [] } }]);
		harness = await makeBoltTestRuntime(definition, {
			connector: connector.binding,
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
		await harness.database.query(
			"insert into bolt_integrations (name, enabled, cursor, lease_until) values ($1, true, null, now() + interval '5 minutes')",
			['mirrored.erp']
		);
		const declined = await pull('run-overlapping', 'vendors');
		expect(at(declined, 'skipped')).toBe(true);
		expect(String(at(declined, 'reason'))).toContain('lease');
		expect(connector.urls).toEqual([]);
	});

	/**
	 * The lease is a claim with an expiry, not a flag. A run that dies without releasing — a deadline,
	 * a killed isolate — must cost one cycle of the cron and not the schedule itself.
	 */
	it('lets the schedule recover once an abandoned lease has expired', async () => {
		const connector = scriptedConnector([{ status: 200, body: { next: 'cursor-1', items: [] } }]);
		harness = await makeBoltTestRuntime(definition, {
			connector: connector.binding,
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
		await harness.database.query(
			"insert into bolt_integrations (name, enabled, cursor, lease_until) values ($1, true, null, now() - interval '1 minute')",
			['mirrored.erp']
		);
		const resumed = await pull('run-after-expiry', 'vendors');
		expect(at(resumed, 'skipped')).toBe(false);
		expect(connector.urls).toHaveLength(1);
		// And the lease is handed back, so the tick after this one is not declined either.
		const rows = await harness.database.query(
			'select lease_until from bolt_integrations where name = $1',
			['mirrored.erp']
		);
		expect(rows[0]?.['lease_until']).toBeNull();
	});

	/**
	 * A registration naming a binding the workspace no longer declares is a stale registration. It has
	 * to fail: an empty successful run is indistinguishable from a feed with nothing new, so the host
	 * would keep firing a schedule that can never import anything and never learn why.
	 */
	it('refuses a schedule that names a binding the workspace does not declare', async () => {
		const connector = scriptedConnector([{ status: 200, body: { items: [] } }]);
		harness = await makeBoltTestRuntime(definition, {
			connector: connector.binding,
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
		await expect(pull('run-stale', 'orders')).rejects.toThrow(/no receive binding named orders/);
	});
});
