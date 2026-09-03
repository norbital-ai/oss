import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref, Schema } from 'effect';
import { EffectId, type DatabaseRequest, type DatabaseResponse } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as AccessControl from '../src/runtime/access/access-control.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime
} from '../src/runtime/collections/authored.js';
import * as Database from '../src/runtime/facilities/database.js';
import { AI, Files, SyncCommit, Tasks } from '../src/runtime/facilities/services.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import * as Workspace from '../src/runtime/workspace.js';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
import * as Automations from '../src/runtime/automations/automations.js';
import * as InvocationBudget from '../src/runtime/budget.js';
import { testCallContext } from './support/bolt-test-layer.js';
import * as TenantScope from '../src/runtime/tenant.js';

/**
 * A JSON column holding a list has to reach Postgres as JSON.
 *
 * A driver binds a JavaScript array to a Postgres *array*, so `jsonb` handed `[{...}]` gets
 * array-literal syntax and answers `invalid input syntax for type json`. An object does not take
 * that path — a driver serialises it — which is why only list-valued columns were broken, and why
 * nothing caught it until a workspace stored one. `time_entries.worked_intervals` is a list, and no
 * attendance record could be written or corrected through the runtime at all.
 *
 * The third case is the one that keeps the fix honest: a model can declare a real Postgres array
 * with `.array()`, and a list bound for one must stay a list. Deciding from the value's JavaScript
 * type rather than the column's declared type would corrupt exactly the column that already worked.
 */
const definition = workspace({
	name: 'json-arrays',
	version: '1.0.0',
	collections: [
		collection({
			name: 'shifts',
			fields: {
				name: field.string({ required: true }),
				intervals: field.json({ required: true }),
				metadata: field.json(),
				// A real Postgres array, declared as such. Nothing here may re-encode it as JSON.
				labels: { type: 'string' as const, required: false, indexed: false, dimensions: 1 }
			}
		})
	],
	apps: [app({ name: 'shifts', label: 'Shifts' })],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'shifts', action: 'create' },
				{ collection: 'shifts', action: 'update' },
				{ collection: 'shifts', action: 'read' }
			]
		})
	],
	teams: {
		'admin-data': ['admin-data'],
		admin: ['admin-data']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database']
});

const subject: Identity.Subject = {
	userId: 'admin-1',
	tenantId: 'tenant-json',
	teamPath: ['admin'],
	policies: []
};

const RECORD_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Records every statement so the test can assert how a value was bound, not only that it was.
 *
 * A stored row may be supplied: the write engine reads the pre-imaged rows of its wave through the
 * same facility, so an update against an empty recording database would rightfully refuse "no longer
 * exists" before any statement was planned. Only the wave-read query answers it; everything else
 * stays a bare success.
 */
const recordingDatabase = (
	seen: Array<DatabaseRequest>,
	stored?: Readonly<Record<string, Schema.Json>>
) =>
	Layer.effect(
		Database.Service,
		Effect.gen(function* () {
			const counter = yield* Ref.make(0);
			return Database.Service.of({
				execute: Effect.fn('recording.execute')(function* (_id, request: DatabaseRequest) {
					seen.push(request);
					yield* Ref.update(counter, (value) => value + 1);
					if (
						stored !== undefined &&
						request._tag === 'Query' &&
						request.sql.includes('__bolt_write_wave')
					)
						return {
							rows: [
								{
									__bolt_write_wave_kind: 'row',
									__bolt_write_wave_ordinal: 0,
									__bolt_write_wave_record: stored
								}
							],
							affectedRows: 1
						} satisfies DatabaseResponse;
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				})
			});
		})
	);

const context = testCallContext('json-arrays');
const tasks = Tasks.layer({ call: () => Promise.resolve({ _tag: 'Success', value: {} }) }, context);

const testLayer = (
	seen: Array<DatabaseRequest>,
	stored?: Readonly<Record<string, Schema.Json>>
) => {
	const database = recordingDatabase(seen, stored);
	const workspaceLayer = Workspace.layer(definition);
	const taskQueue = TaskQueue.layer(context).pipe(Layer.provide(Layer.mergeAll(database, tasks)));
	const tenantScope = TenantScope.layer('tenant-json');
	const syncCommit = SyncCommit.layer(undefined, context);
	const automations = Automations.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				workspaceLayer,
				database,
				taskQueue,
				syncCommit,
				InvocationBudget.layer(0),
				tenantScope
			)
		)
	);
	const access = AccessControl.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database)));
	const approvals = Approvals.layer.pipe(
		Layer.provide(Layer.mergeAll(workspaceLayer, access, database, taskQueue))
	);
	return Collections.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				workspaceLayer,
				tenantScope,
				access,
				approvals,
				database,
				AI.layer(undefined, context),
				Files.layer(undefined, context),
				taskQueue,
				automations,
				syncCommit,
				Layer.succeed(AuthoredRuntimeService, emptyAuthoredRuntime)
			)
		)
	);
};

/** The statement that writes the collection's own row, not the history or outbox rows beside it. */
const rowStatement = (seen: ReadonlyArray<DatabaseRequest>, fragment: string) =>
	seen
		.flatMap((request) => (request._tag === 'Transaction' ? request.statements : []))
		.find((statement) => statement.sql.includes(fragment));

describe('JSON columns holding a list', () => {
	const intervals = [{ start_at: '2026-05-31T01:00:00.000Z', end_at: '2026-05-31T09:00:00.000Z' }];

	it.effect('binds a list as JSON text under a cast on create', () => {
		const seen: Array<DatabaseRequest> = [];
		return Effect.gen(function* () {
			yield* (yield* Collections.Service).mutate(
				EffectId.make('create-shift'),
				subject,
				'shifts',
				[
					{
						id: RECORD_ID,
						name: 'Night',
						intervals,
						metadata: { source: 'roster' },
						labels: ['night', 'weekend']
					}
				],
				false,
				0,
				{ root: { id: RECORD_ID, action: 'create' } }
			);
			const statement = rowStatement(seen, 'insert into "shifts"');
			expect(statement).toBeDefined();
			// The cast is what makes the difference: without it the driver sends array-literal syntax.
			expect(statement?.sql).toContain('::jsonb');
			expect(statement?.parameters).toContain(JSON.stringify(intervals));
			// An object is left alone — a driver already serialises it, and stringifying it here would
			// double-encode a column that was never broken.
			expect(statement?.parameters).toContainEqual({ source: 'roster' });
			// The array column keeps its array: one `::jsonb` in the statement, for `intervals` alone.
			expect(statement?.parameters).toContainEqual(['night', 'weekend']);
			expect(statement?.sql.match(/::jsonb/g)).toHaveLength(1);
		}).pipe(Effect.provide(testLayer(seen)));
	});

	it.effect('binds a list as JSON text under a cast on update', () => {
		const seen: Array<DatabaseRequest> = [];
		return Effect.gen(function* () {
			// The authoritative row the update lands on: the write engine's wave read answers it, and
			// an update the wave read cannot pre-image is refused before any statement is planned.
			yield* (yield* Collections.Service).mutate(
				EffectId.make('update-shift'),
				subject,
				'shifts',
				[{ id: RECORD_ID, intervals }],
				false,
				0,
				{ root: { id: RECORD_ID, action: 'update' } }
			);
			const statement = rowStatement(seen, 'update "shifts"');
			expect(statement).toBeDefined();
			expect(statement?.sql).toContain('"intervals" = $1::jsonb');
			expect(statement?.parameters?.[0]).toBe(JSON.stringify(intervals));
		}).pipe(
			Effect.provide(
				testLayer(seen, {
					id: RECORD_ID,
					name: 'Night',
					intervals: [],
					metadata: { source: 'roster' },
					labels: ['night'],
					row_version: 1,
					created_at: '2026-05-31T01:00:00.000Z',
					updated_at: '2026-05-31T01:00:00.000Z'
				})
			)
		);
	});
});
