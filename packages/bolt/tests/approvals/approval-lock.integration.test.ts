import { createHash } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Ref, Schema } from 'effect';
import { EffectId, type DatabaseRequest, type DatabaseResponse } from '@norbital-ai/bolt-protocol';
import { approveBy } from '../../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import { ApprovalConflict } from '../../src/runtime/approvals/approvals.js';
import * as Automations from '../../src/runtime/automations/automations.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import {
	AuthoredRuntimeService,
	emptyAuthoredRuntime
} from '../../src/runtime/collections/authored.js';
import * as Database from '../../src/runtime/facilities/database.js';
import { AI, Files, Tasks } from '../../src/runtime/facilities/services.js';
import * as TenantScope from '../../src/runtime/tenant.js';
import * as InvocationBudget from '../../src/runtime/budget.js';
import { Subject } from '../../src/runtime/identity/identity.js';
import * as TaskQueue from '../../src/runtime/tasks/tasks.js';
import * as Workspace from '../../src/runtime/workspace.js';
import { testCallContext } from '../support/bolt-test-layer.js';

/** A stable UUID for a readable fixture name — records are keyed by `id uuid`. */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const oneStep = { flow: () => approveBy('approvers'), superceded_by: [] };
const twoStep = {
	flow: () => approveBy('approvers').thenBy('approvers'),
	superceded_by: []
};

const dataPolicy = describePolicy('admin-data', {
	description: 'Exercises one- and two-stage approval settlement.',
	grants: {
		orders: {
			create: { approval: oneStep },
			update: { approval: oneStep },
			delete: { approval: oneStep },
			read: {}
		},
		employees: {
			create: { approval: twoStep },
			update: { approval: twoStep },
			delete: { approval: twoStep },
			read: {}
		},
		notes: {
			create: {},
			update: { approval: oneStep },
			delete: {},
			read: {}
		}
	}
});

const definition = workspace({
	name: 'hr',
	version: '1.0.0',
	collections: [
		collection({
			name: 'orders',
			fields: { title: field.string({ required: true }) }
		}),
		collection({ name: 'employees', fields: { name: field.string({ required: true }) } }),
		collection({ name: 'notes', fields: { body: field.string({ required: true }) } })
	],
	apps: [app({ name: 'hr', label: 'HR' }), app({ name: 'approvals', label: 'Approvals' })],
	policies: [
		dataPolicy,
		policy({
			name: 'admin-approval',
			effect: 'allow',
			actions: ['approve'],
			capabilities: { apps: ['approvals'] }
		})
	],
	teams: {
		'admin-data': ['admin-data'],
		'admin-approval': ['admin-approval'],
		admin: ['admin-data', 'admin-approval'],
		approvers: ['admin-data', 'admin-approval']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: ['database', 'tasks']
});

const subject = Subject.make({
	userId: 'admin-1',
	tenantId: 'tenant-1',
	teamPath: ['approvers'],
	policies: []
});

const mutateRecord = (
	service: Collections.Interface,
	effectId: EffectId,
	collection: string,
	id: string,
	action: 'create' | 'update',
	values: Readonly<Record<string, unknown>>
) =>
	service.mutate(effectId, subject, collection, [{ ...values, id }], false, 0, {
		root: { id, action }
	});

const dataFunctions = policyRuntimeFunctionsFor([dataPolicy]);

type Row = Record<string, Schema.Json>;
type ApprovalRow = {
	readonly requestId: string;
	readonly state: Schema.Json;
	readonly requestorId: string;
};
type AuditRow = {
	readonly kind: string;
	readonly subjectId: string;
	readonly payload: Schema.Json;
};

const storedApprovalState = (
	value: Schema.Json
): Readonly<Record<string, Schema.Json>> | undefined => {
	const decoded =
		typeof value === 'string'
			? (() => {
					try {
						return JSON.parse(value) as unknown;
					} catch {
						return undefined;
					}
				})()
			: value;
	return Schema.is(Schema.Record(Schema.String, Schema.Json))(decoded) ? decoded : undefined;
};

const quotedName = (sql: string, keyword: 'into' | 'from' | 'update'): string | undefined => {
	const match = new RegExp(`${keyword} "((?:[^"]|"")+)"`).exec(sql);
	return match?.[1]?.replaceAll('""', '"');
};

const memoryDatabaseLayer = (taskInserts: Array<string> = []) =>
	Layer.effect(
		Database.Service,
		Effect.gen(function* () {
			const approvals = yield* Ref.make<ReadonlyMap<string, ApprovalRow>>(new Map());
			const tables = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, Row>>>(new Map());
			const audit = yield* Ref.make<ReadonlyArray<AuditRow>>([]);
			const runQuery = Effect.fn('MemoryDatabase.query')(function* (
				sql: string,
				parameters: ReadonlyArray<Schema.Json>
			) {
				// Drizzle quotes identifiers while the approval transition CTEs use the same
				// identifiers unquoted. This fake models database meaning, not either SQL spelling.
				const unquotedSql = sql.replaceAll('"', '');
				if (unquotedSql.includes('bolt_task') && !unquotedSql.includes('bolt_approvals')) {
					// The follow-up work a decision schedules is a row now, not a facility call, so the
					// tests observe it the way a host would: as `bolt_task` inserts, with the command
					// first among the parameters.
					taskInserts.push(JSON.stringify(parameters));
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (unquotedSql.includes('insert into bolt_approvals')) {
					const pendingState = parameters
						.map(storedApprovalState)
						.find(
							(value) => value?.['_tag'] === 'Pending' && typeof value['requestId'] === 'string'
						);
					if (pendingState === undefined)
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const requestId = String(pendingState['requestId']);
					const operation = pendingState['operation'];
					const operationRecord = Schema.is(Schema.Record(Schema.String, Schema.Json))(operation)
						? operation
						: {};
					const subjectIndex = parameters.findIndex((value) => value === 'approval_requested') + 1;
					const requestorId = String(parameters[subjectIndex]);
					const current = yield* Ref.get(approvals);
					if (current.has(requestId))
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					if (unquotedSql.includes('with locked as')) {
						const table = quotedName(sql, 'update');
						const id = String(operationRecord['id']);
						const currentTables = yield* Ref.get(tables);
						const rows = new Map(currentTables.get(table ?? '') ?? new Map());
						const row = rows.get(id);
						if (
							row === undefined ||
							(typeof row['approval_id'] === 'string' && row['approval_id'].length > 0)
						)
							return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
						rows.set(id, { ...row, approval_id: requestId });
						yield* Ref.set(tables, new Map(currentTables).set(table ?? '', rows));
					}
					// JSONB is a value boundary: mirror its normalisation instead of retaining any
					// optional `undefined` properties from the in-process authoring object.
					const state = JSON.parse(JSON.stringify(pendingState)) as Schema.Json;
					yield* Ref.set(
						approvals,
						new Map(current).set(requestId, {
							requestId,
							state,
							requestorId
						})
					);
					if (sql.includes('bolt_audit')) {
						const events = yield* Ref.get(audit);
						yield* Ref.set(audit, [
							...events,
							{
								kind: 'approval_requested',
								subjectId: requestorId,
								payload: state
							}
						]);
					}
					return { rows: [{ state }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (
					unquotedSql.trimStart().startsWith('select') &&
					unquotedSql.includes('from requestor') &&
					unquotedSql.includes('approval_request_id') &&
					unquotedSql.includes('user_id')
				) {
					const current = yield* Ref.get(approvals);
					const row = current.get(String(parameters[0]));
					return {
						rows: row?.requestorId === String(parameters[1]) ? [{ '?column?': 1 }] : [],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (
					unquotedSql.includes("state->>'_tag' = 'Pending'") &&
					unquotedSql.includes("state->'operation'->>'collection'")
				) {
					const collectionName = String(parameters[0]);
					const recordId = String(parameters[1]);
					const current = yield* Ref.get(approvals);
					const found = Array.from(current.values()).find((row) => {
						if (!Schema.is(Schema.Record(Schema.String, Schema.Json))(row.state)) return false;
						if (row.state['_tag'] !== 'Pending') return false;
						const operation = row.state['operation'];
						return (
							Schema.is(Schema.Record(Schema.String, Schema.Json))(operation) &&
							operation['collection'] === collectionName &&
							operation['id'] === recordId
						);
					});
					return {
						rows: found === undefined ? [] : [{ state: found.state }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (
					unquotedSql.trimStart().startsWith('select') &&
					unquotedSql.includes('state') &&
					unquotedSql.includes('from bolt_approvals') &&
					unquotedSql.includes('request_id')
				) {
					const current = yield* Ref.get(approvals);
					const row = current.get(String(parameters[0]));
					return {
						rows: row === undefined ? [] : [{ state: row.state }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (
					unquotedSql.trimStart().startsWith('select') &&
					unquotedSql.includes('from approval_request') &&
					unquotedSql.includes('collection_name') &&
					unquotedSql.includes('record_id') &&
					unquotedSql.includes('status')
				) {
					const collectionName = String(parameters[0]);
					const recordId = String(parameters[1]);
					const current = yield* Ref.get(approvals);
					const found = Array.from(current.values()).find((row) => {
						const state = storedApprovalState(row.state);
						const operation = state?.['operation'];
						return (
							state?.['_tag'] === 'Pending' &&
							Schema.is(Schema.Record(Schema.String, Schema.Json))(operation) &&
							operation['collection'] === collectionName &&
							operation['id'] === recordId
						);
					});
					return {
						rows: found === undefined ? [] : [{ id: found.requestId }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (
					unquotedSql.includes('update bolt_approvals') ||
					unquotedSql.includes('with updated as')
				) {
					const nextState = parameters
						.map(storedApprovalState)
						.find(
							(value) =>
								typeof value?.['_tag'] === 'string' && typeof value['requestId'] === 'string'
						);
					if (nextState === undefined)
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const requestId = String(nextState['requestId']);
					const next = JSON.parse(JSON.stringify(nextState)) as Schema.Json;
					const current = yield* Ref.get(approvals);
					const existing = current.get(requestId);
					if (
						existing === undefined ||
						!Schema.is(Schema.Record(Schema.String, Schema.Json))(existing.state) ||
						existing.state['_tag'] !== 'Pending'
					) {
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					}
					yield* Ref.set(
						approvals,
						new Map(current).set(requestId, {
							requestId,
							state: next,
							requestorId: existing.requestorId
						})
					);
					if (sql.includes('bolt_task')) taskInserts.push(JSON.stringify(parameters));
					if (sql.includes('bolt_audit')) {
						const auditKindIndex = parameters.findIndex(
							(value) => typeof value === 'string' && value.startsWith('approval_')
						);
						const events = yield* Ref.get(audit);
						yield* Ref.set(audit, [
							...events,
							{
								kind: auditKindIndex < 0 ? 'approval_decided' : String(parameters[auditKindIndex]),
								subjectId: String(parameters[auditKindIndex + 1]),
								payload: next
							}
						]);
					}
					return { rows: [{ state: next }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('insert into bolt_audit')) {
					const events = yield* Ref.get(audit);
					yield* Ref.set(audit, [
						...events,
						{
							kind: String(parameters[0]),
							subjectId: String(parameters[1]),
							payload: parameters[2] ?? null
						}
					]);
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (unquotedSql.includes('from bolt_audit')) {
					const requestId = String(parameters[0]);
					const events = yield* Ref.get(audit);
					return {
						rows: events
							.filter(
								(event) =>
									Schema.is(Schema.Record(Schema.String, Schema.Json))(event.payload) &&
									event.payload['requestId'] === requestId
							)
							.map((event) => ({
								kind: event.kind,
								subjectId: event.subjectId,
								payload: event.payload
							})),
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				const updatedTable = quotedName(sql, 'update');
				const setClause = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|$)/i.exec(unquotedSql)?.[1];
				const approvalAssignment =
					setClause === undefined ? null : /\bapproval_id\s*=\s*(null|\$(\d+))/i.exec(setClause);
				if (updatedTable !== undefined && approvalAssignment !== null) {
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(updatedTable) ?? new Map());
					const id = parameters.map(String).find((candidate) => existing.has(candidate));
					if (id === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const row = existing.get(id);
					if (row === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const parameterIndex = approvalAssignment[2];
					const approvalId =
						approvalAssignment[1]?.toLocaleLowerCase() === 'null'
							? null
							: (parameters[Number(parameterIndex) - 1] ?? null);
					if (
						approvalId !== null &&
						typeof row['approval_id'] === 'string' &&
						row['approval_id'].length > 0
					) {
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					}
					const next = { ...row };
					for (const assignment of setClause?.matchAll(/\b([a-z_][a-z0-9_]*)\s*=\s*\$(\d+)/gi) ??
						[]) {
						const column = assignment[1];
						const index = Number(assignment[2]);
						if (column !== undefined) next[column] = parameters[index - 1] ?? null;
					}
					next['approval_id'] = approvalId;
					existing.set(id, next);
					yield* Ref.set(tables, new Map(current).set(updatedTable, existing));
					return { rows: [{ record_id: id }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('with locked as') && sql.includes('approval_id = $2')) {
					const table = quotedName(sql, 'update');
					const id = String(parameters[0]);
					const requestId = String(parameters[1]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (
						row === undefined ||
						(typeof row['approval_id'] === 'string' && row['approval_id'].length > 0)
					)
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					existing.set(id, { ...row, approval_id: requestId });
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [{ record_id: id }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.includes('with released as') && sql.includes('approval_id = null')) {
					const table = quotedName(sql, 'update');
					const id = String(parameters[parameters.length === 2 ? 0 : 1]);
					const requestId = parameters.length === 2 ? undefined : String(parameters[0]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (row === undefined || (requestId !== undefined && row['approval_id'] !== requestId))
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					existing.set(id, { ...row, approval_id: null });
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [{ record_id: id }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('insert into bolt_') || sql.includes('insert into bolt_')) {
					return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('insert into "')) {
					const table = quotedName(sql, 'into');
					if (table === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const columns = [...sql.matchAll(/"((?:[^"]|"")+)"/g)]
						.slice(1)
						.map((match) => match[1]?.replaceAll('""', '"') ?? '');
					const row = Object.fromEntries(
						columns
							.filter((column) => column !== table)
							.map((column, index) => [column, parameters[index] ?? null])
					);
					const id = String(row['id'] ?? parameters[0]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table) ?? new Map());
					existing.set(id, row);
					yield* Ref.set(tables, new Map(current).set(table, existing));
					return { rows: [row], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('update "') && unquotedSql.includes('set approval_id = $2')) {
					const table = quotedName(sql, 'update');
					const id = String(parameters[0]);
					const requestId = String(parameters[1]);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (
						row === undefined ||
						(typeof row['approval_id'] === 'string' && row['approval_id'].length > 0)
					) {
						return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					}
					const next = { ...row, approval_id: requestId };
					existing.set(id, next);
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [{ id }], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('update "')) {
					const table = quotedName(sql, 'update');
					const idIndex = [...sql.matchAll(/\$(\d+)/g)].at(-1);
					const id = String(
						parameters[(idIndex === undefined ? parameters.length : Number(idIndex[1])) - 1]
					);
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const row = existing.get(id);
					if (row === undefined) return { rows: [], affectedRows: 0 } satisfies DatabaseResponse;
					const next = { ...row };
					for (const assignment of sql.matchAll(/"((?:[^"]|"")+)" = \$(\d+)/g)) {
						const column = assignment[1]?.replaceAll('""', '"');
						const index = Number(assignment[2]);
						if (column !== undefined) next[column] = parameters[index - 1] ?? null;
					}
					// Drizzle renders a null assignment as a literal rather than a bound parameter. Interpret
					// the update's table/column intent after normalizing identifier quotes instead of depending
					// on one exact generated statement.
					if (/\bset\b[\s\S]*\bapproval_id\s*=\s*null\b/.test(unquotedSql)) {
						next['approval_id'] = null;
					}
					existing.set(id, next);
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [next], affectedRows: 1 } satisfies DatabaseResponse;
				}
				if (unquotedSql.includes('__bolt_write_wave_kind')) {
					// The write engine's wave read: one `union all` of per-row and per-relation
					// branches, each carrying its ordinal and the id to look up. Parameters arrive
					// in branch order — row branches bind (ordinal, id); relation branches bind
					// (ordinal, parentId) against `child."<column>"`.
					const current = yield* Ref.get(tables);
					const branches = sql.split(/ union all /i);
					const rows: Array<Schema.Json> = [];
					let index = 0;
					for (const branch of branches) {
						const ordinal = parameters[index] ?? null;
						index += 1;
						const table = quotedName(branch, 'from');
						const bucket = current.get(table ?? '');
						if (branch.includes("'row'::text")) {
							const id = parameters[index];
							index += 1;
							const row = bucket?.get(String(id));
							if (row !== undefined)
								rows.push({
									__bolt_write_wave_kind: 'row',
									__bolt_write_wave_ordinal: ordinal,
									__bolt_write_wave_record: row
								});
						} else {
							const parent = parameters[index];
							index += 1;
							const column = /child\."([^"]+)" = /.exec(branch)?.[1] ?? '';
							for (const child of bucket?.values() ?? []) {
								if (String(child[column] ?? '') === String(parent))
									rows.push({
										__bolt_write_wave_kind: 'relation',
										__bolt_write_wave_ordinal: ordinal,
										__bolt_write_wave_record: child
									});
							}
						}
					}
					return { rows, affectedRows: 0 } satisfies DatabaseResponse;
				}
				if (unquotedSql.includes('select approval_id')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					const row = current.get(table ?? '')?.get(String(parameters[0]));
					return {
						rows: row === undefined ? [] : [{ approval_id: row['approval_id'] ?? null }],
						affectedRows: 0
					} satisfies DatabaseResponse;
				}
				if (unquotedSql.trimStart().startsWith('select')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					// Ordinary collection reads now project explicit Drizzle columns rather than
					// spelling `select *`. Only intercept a table this fake actually owns so the
					// system-table readers above retain their purpose-built behavior.
					if (table === undefined || !current.has(table))
						return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
					const rows = Array.from(current.get(table ?? '')?.values() ?? []);
					if (unquotedSql.includes('count('))
						return { rows: [{ count: rows.length }], affectedRows: 0 } satisfies DatabaseResponse;
					return { rows, affectedRows: 0 } satisfies DatabaseResponse;
				}
				if (sql.startsWith('delete from "')) {
					const table = quotedName(sql, 'from');
					const current = yield* Ref.get(tables);
					const existing = new Map(current.get(table ?? '') ?? new Map());
					const removed = existing.delete(String(parameters[0]));
					yield* Ref.set(tables, new Map(current).set(table ?? '', existing));
					return { rows: [], affectedRows: removed ? 1 : 0 } satisfies DatabaseResponse;
				}
				return { rows: [], affectedRows: 1 } satisfies DatabaseResponse;
			});
			return Database.Service.of({
				execute: Effect.fn('Database.execute')(function* (_effectId, request: DatabaseRequest) {
					if (request._tag === 'Transaction') {
						let last: DatabaseResponse = { rows: [], affectedRows: 0 };
						for (const statement of request.statements) {
							last = yield* runQuery(statement.sql, statement.parameters);
						}
						return last;
					}
					return yield* runQuery(request.sql, request.parameters);
				})
			});
		})
	);

const context = testCallContext('approval-lock');

/**
 * A tasks facility that accepts the runtime's only message, `Wake`.
 *
 * The follow-up work a decision schedules is the part that is easy to leave out — `resume` was
 * enqueued on approval and nothing at all was enqueued on rejection, so the lock a refused request
 * had taken was never released by anybody. The enqueue is now a `bolt_task` row in the caller's own
 */
const recordingTasks = () =>
	Tasks.layer(
		{
			call: () => Promise.resolve({ _tag: 'Success', value: {} })
		},
		context
	);

const workspaceLayer = Workspace.layer(definition);
const testLayer = (recorded: Array<string> = []) => {
	const tasks = recordingTasks();
	const database = memoryDatabaseLayer(recorded);
	const taskQueue = TaskQueue.layer(context).pipe(Layer.provide(Layer.mergeAll(database, tasks)));
	const tenantScope = TenantScope.layer(context.tenantId);
	const automations = Automations.layer.pipe(
		Layer.provide(
			Layer.mergeAll(workspaceLayer, database, taskQueue, InvocationBudget.layer(0), tenantScope)
		)
	);
	const access = AccessControl.layer.pipe(Layer.provide(Layer.mergeAll(workspaceLayer, database)));
	const approvalsLayer = Approvals.layer.pipe(
		Layer.provide(Layer.mergeAll(workspaceLayer, access, database, taskQueue))
	);
	const authoredLayer = Layer.succeed(AuthoredRuntimeService, {
		...emptyAuthoredRuntime,
		policyAuthorizations: dataFunctions.authorizations,
		approvalFlows: dataFunctions.approvalFlows
	});
	const collectionsLayer = Collections.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				workspaceLayer,
				tenantScope,
				access,
				approvalsLayer,
				database,
				AI.layer(undefined, context),
				Files.layer(undefined, context),
				taskQueue,
				automations,
				authoredLayer,
				tasks
				// No transport is bound, so the announcement is ignored — which is exactly the behaviour
				// under test here: a write path must not depend on anywhere to publish.
			)
		)
	);
	return Layer.mergeAll(collectionsLayer, approvalsLayer);
};

describe('approval lock and resume', () => {
	it.effect('writes the row a pending mutation requested, and holds it', () =>
		Effect.gen(function* () {
			const service = yield* Collections.Service;
			const pending = yield* Effect.flip(
				mutateRecord(service, EffectId.make('create-order'), 'orders', rid('order-1'), 'create', {
					title: 'Held'
				})
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			// A request id is derived from the intercepted write, not a readable join of its parts:
			// `approval_request` is keyed by `id uuid`. What matters is that it is well formed
			// and stable, so a retry re-joins this approval rather than opening a second one.
			expect(pending.requestId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
			);
			// Review state owns the engine graph; no provisional domain row is visible.
			const orders = yield* service.findMany(EffectId.make('read-order'), subject, {
				collection: 'orders'
			});
			expect(orders).toEqual([]);
			const stored = yield* (yield* Approvals.Service).status(
				EffectId.make('status-order'),
				pending.requestId
			);
			expect(stored?._tag).toBe('Pending');
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('applies the stored row after approve and collections.resume', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-resume'),
					'orders',
					rid('order-2'),
					'create',
					{ title: 'Released' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-resume'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			const decided = yield* approvalsService.decide(
				EffectId.make('decide-resume'),
				subject,
				requested,
				'approve'
			);
			expect(decided._tag).toBe('Approved');
			yield* collectionsService.resume(EffectId.make('resume-order'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-resume'), subject, {
					collection: 'orders'
				})
			).toEqual([expect.objectContaining({ id: rid('order-2'), title: 'Released' })]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('conflicts a second mutation while the record is locked', () =>
		Effect.gen(function* () {
			const service = yield* Collections.Service;
			const first = yield* Effect.flip(
				mutateRecord(service, EffectId.make('create-lock-1'), 'orders', rid('order-3'), 'create', {
					title: 'First'
				})
			);
			expect(first).toBeInstanceOf(PendingApproval);
			const second = yield* Effect.flip(
				mutateRecord(service, EffectId.make('create-lock-2'), 'orders', rid('order-3'), 'create', {
					title: 'Second'
				})
			);
			expect(second).toBeInstanceOf(ApprovalConflict);
			if (!(second instanceof ApprovalConflict)) return;
			// The engine's lock refusal names the holding approval request rather than the word 'locked'.
			expect(second.reason).toContain('is held by another approval request');
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('keeps a two-step approval pending after the first approve', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-two-step'),
					'employees',
					rid('employee-1'),
					'create',
					{ name: 'Ada' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-two-step'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			const first = yield* approvalsService.decide(
				EffectId.make('decide-two-step-1'),
				subject,
				requested,
				'approve'
			);
			expect(first).toMatchObject({ _tag: 'Pending', step: 1 });
			// Still held after the first of two approvals; the row is created only after the last.
			const employees = yield* collectionsService.findMany(
				EffectId.make('read-two-step'),
				subject,
				{
					collection: 'employees'
				}
			);
			expect(employees).toEqual([]);
			const last = yield* approvalsService.decide(
				EffectId.make('decide-two-step-2'),
				subject,
				first,
				'approve'
			);
			expect(last._tag).toBe('Approved');
			yield* collectionsService.resume(EffectId.make('resume-two-step'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-two-step-done'), subject, {
					collection: 'employees'
				})
			).toEqual([expect.objectContaining({ id: rid('employee-1'), name: 'Ada' })]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('locks an existing row without writing pending values', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			yield* mutateRecord(
				collectionsService,
				EffectId.make('create-note'),
				'notes',
				rid('note-1'),
				'create',
				{ body: 'Original' }
			);
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('update-note'),
					'notes',
					rid('note-1'),
					'update',
					{ body: 'Pending' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					id: rid('note-1'),
					body: 'Original',
					approval_id: pending.requestId
				})
			]);
			const requested = yield* approvalsService.status(
				EffectId.make('status-note'),
				pending.requestId
			);
			expect(requested?._tag).toBe('Pending');
			if (requested === undefined) return;
			yield* approvalsService.decide(EffectId.make('decide-note'), subject, requested, 'approve');
			yield* collectionsService.resume(EffectId.make('resume-note'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note-resumed'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					id: rid('note-1'),
					body: 'Pending',
					approval_id: null
				})
			]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('keeps a rejected create absent when its hold is discarded', () => {
		const enqueued: Array<string> = [];
		return Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-rejected'),
					'orders',
					rid('order-rejected'),
					'create',
					{ title: 'Refused' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-rejected'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-rejected'),
				subject,
				requested,
				'reject',
				'not this one'
			);
			// The decision schedules its own durable cleanup. Asserted before running it by hand because
			// the approval and browser-mutation hold must still reach a terminal state.
			expect(enqueued.some((request) => request.includes('collections.discard'))).toBe(true);
			yield* collectionsService.discard(EffectId.make('discard-rejected'), pending.requestId);
			// PREPARE held the graph before COMMIT, so rejecting it leaves the domain row absent.
			expect(
				yield* collectionsService.findMany(EffectId.make('read-rejected'), subject, {
					collection: 'orders'
				})
			).toEqual([]);
		}).pipe(Effect.provide(testLayer(enqueued)));
	});

	it.effect('releases the lock on an existing row when its update is rejected', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			yield* mutateRecord(
				collectionsService,
				EffectId.make('create-note-reject'),
				'notes',
				rid('note-reject'),
				'create',
				{ body: 'Original' }
			);
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('update-note-reject'),
					'notes',
					rid('note-reject'),
					'update',
					{ body: 'Pending' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-note-reject'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-note-reject'),
				subject,
				requested,
				'reject'
			);
			yield* collectionsService.discard(EffectId.make('discard-note-reject'), pending.requestId);
			// The update was never applied, so the record is already what it should be and only the
			// lock has to come off. Left on, the row stayed invisible and could not be edited again.
			expect(
				yield* collectionsService.findMany(EffectId.make('read-note-reject'), subject, {
					collection: 'notes'
				})
			).toEqual([
				expect.objectContaining({
					id: rid('note-reject'),
					body: 'Original',
					approval_id: null
				})
			]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('preserves request-for-change as its own final state and schedules cleanup', () => {
		const enqueued: Array<string> = [];
		return Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-changes-requested'),
					'orders',
					rid('order-changes-requested'),
					'create',
					{ title: 'Needs revision' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-changes-requested'),
				pending.requestId
			);
			if (requested === undefined) return;
			const changed = yield* approvalsService.decide(
				EffectId.make('decide-changes-requested'),
				subject,
				requested,
				'request_changes',
				'Please add the missing evidence.'
			);
			expect(changed).toMatchObject({
				_tag: 'ChangesRequested',
				reason: 'Please add the missing evidence.'
			});
			expect(enqueued.some((request) => request.includes('collections.discard'))).toBe(true);
			const stored = yield* approvalsService.status(
				EffectId.make('status-changes-requested-final'),
				pending.requestId
			);
			expect(stored?._tag).toBe('ChangesRequested');
		}).pipe(Effect.provide(testLayer(enqueued)));
	});

	it.effect('releases the lock when a pending request is withdrawn', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-withdrawn'),
					'orders',
					rid('order-withdrawn'),
					'create',
					{ title: 'Recalled' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-withdrawn'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.withdraw(EffectId.make('withdraw'), subject, requested);
			yield* collectionsService.discard(EffectId.make('discard-withdrawn'), pending.requestId);
			expect(
				yield* collectionsService.findMany(EffectId.make('read-withdrawn'), subject, {
					collection: 'orders'
				})
			).toEqual([]);
		}).pipe(Effect.provide(testLayer()))
	);

	it.effect('returns decision events from the approval timeline', () =>
		Effect.gen(function* () {
			const collectionsService = yield* Collections.Service;
			const approvalsService = yield* Approvals.Service;
			const pending = yield* Effect.flip(
				mutateRecord(
					collectionsService,
					EffectId.make('create-timeline'),
					'orders',
					rid('order-4'),
					'create',
					{ title: 'Audited' }
				)
			);
			expect(pending).toBeInstanceOf(PendingApproval);
			if (!(pending instanceof PendingApproval)) return;
			const requested = yield* approvalsService.status(
				EffectId.make('status-timeline'),
				pending.requestId
			);
			if (requested === undefined) return;
			yield* approvalsService.decide(
				EffectId.make('decide-timeline'),
				subject,
				requested,
				'approve'
			);
			const events = yield* approvalsService.timeline(EffectId.make('timeline'), pending.requestId);
			expect(events.map((event) => event.kind)).toEqual(['approval_requested', 'approval_decided']);
			expect(events[1]).toMatchObject({
				subjectId: 'admin-1',
				payload: { _tag: 'Approved', requestId: pending.requestId }
			});
		}).pipe(Effect.provide(testLayer()))
	);
});
