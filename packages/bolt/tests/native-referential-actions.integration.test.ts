import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		roots: { description: 'A root', label: 'name', fields: { name: { kind: 'text' } } },
		archives: { description: 'An archive', label: 'name', fields: { name: { kind: 'text' } } },
		branches: { description: 'A branch', label: 'name', fields: { name: { kind: 'text' } } },
		leaves: { description: 'A leaf', label: 'name', fields: { name: { kind: 'text' } } },
		watchers: { description: 'A watcher', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {
		'branches.root': { to: 'roots', onDelete: 'cascade' },
		'leaves.branch': { to: 'branches', onDelete: 'cascade' },
		'watchers.first': { to: ['roots', 'archives'], optional: true, onDelete: 'setNull' },
		'watchers.second': { to: ['roots', 'archives'], optional: true, onDelete: 'setNull' }
	},
	exposures: {
		roots: {
			read: { roots: { fields: 'all' } },
			create: { columns: { roots: ['name'] } },
			delete: {}
		},
		archives: {
			read: { archives: { fields: 'all' } },
			create: { columns: { archives: ['name'] } }
		},
		branches: {
			read: { branches: { fields: 'all' } },
			create: { columns: { branches: ['name', 'root'] } }
		},
		leaves: {
			read: { leaves: { fields: 'all' } },
			create: { columns: { leaves: ['name', 'branch'] } }
		},
		watchers: {
			read: { watchers: { fields: 'all' } },
			create: { columns: { watchers: ['name', 'first', 'second'] } },
			update: { columns: { watchers: ['name'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests changes',
			grants: {
				roots: { read: true, history: true, delete: { check: true } },
				watchers: { read: true, history: true, update: { check: true } }
			}
		},
		reviewer: {
			description: 'Reviews changes',
			grants: { roots: { read: true }, watchers: { read: true } }
		}
	},
	teams: { requesters: ['requester'], reviewers: ['reviewer'] }
};
const guest = program(`export default { policy: { requester: { grants: {
	roots: { delete: { check: function* (rows, ctx) { return ctx.approve((flow) => flow.step('Review deletion', {teams:['reviewers']})); } } },
	watchers: { update: { check: function* (changes, ctx) { return ctx.approve((flow) => flow.step('Review watcher', {teams:['reviewers']})); } } }
} } } };`);
const Watcher = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	first__roots: Schema.NullOr(Schema.String),
	first__archives: Schema.NullOr(Schema.String),
	second__roots: Schema.NullOr(Schema.String),
	second__archives: Schema.NullOr(Schema.String),
	revision: Schema.Number
});
const History = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Number,
	op: Schema.String,
	cause: Schema.String,
	changes: Schema.Record(Schema.String, Schema.Json),
	request: Schema.NullOr(Schema.String)
});
// a stored checkpoint entry keeps its `collection` key (the audit trigger reads it)
const Checkpoint = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	op: Schema.String,
	before: Schema.NullOr(Schema.Number)
}).pipe(Schema.encodeKeys({ model: 'collection' }));
type Model = 'roots' | 'archives' | 'branches' | 'leaves' | 'watchers';

const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace),
		writes = Context.get(context, Writes),
		approvals = Context.get(context, Approvals),
		admin = t.as(t.admin).authority,
		requester = t.as(
			t.member(['requester'], { teams: ['requesters'], teamPath: ['requesters'] })
		).authority,
		reviewer = t.as(
			t.member(['reviewer'], { teams: ['reviewers'], teamPath: ['reviewers'] })
		).authority;
	const act = (
		model: Model,
		verb: 'create' | 'update' | 'delete',
		input: Json,
		authority = admin,
		key = randomUUID(),
		retry = false
	) => {
		const now = t.clock.now();
		return writes.act({
			model,
			verb,
			input,
			authority,
			key,
			retry,
			issuedAt: now,
			invocationId: key,
			mode: { _tag: 'Direct' },
			bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
		});
	};
	const create = Effect.fnUntraced(function* (model: Model, input: Json) {
		const { outcome } = yield* act(model, 'create', [input]);
		assert.ok(outcome.kind === 'committed');
		const row = outcome.records.find((record) => record.model === model);
		assert.ok(row);
		return row.id;
	});
	const root = yield* create('roots', { name: 'Root' }),
		archive = yield* create('archives', { name: 'Archive' }),
		branch = yield* create('branches', { name: 'Branch', root }),
		leaf = yield* create('leaves', { name: 'Leaf', branch }),
		watcher = yield* create('watchers', {
			name: 'Watcher',
			first: { model: 'roots', id: root },
			second: { model: 'roots', id: root }
		});
	const watcherRows = () =>
		t.db.rows(Watcher, {
			text: 'SELECT id,name,first__roots,first__archives,second__roots,second__archives,revision FROM watchers WHERE id=$1',
			params: [watcher]
		});
	const history = () =>
		t.db.rows(History, {
			text: 'SELECT collection AS model,record::text,revision,op,cause,changes,request::text FROM bolt_history ORDER BY collection,record,revision',
			params: []
		});
	const tables = [
		'roots',
		'archives',
		'branches',
		'leaves',
		'watchers',
		'bolt_history',
		'bolt_approvals',
		'approval_request'
	];
	const snapshot = () =>
		t.db.rows(Schema.Struct({ model: Schema.String, image: Schema.Json }), {
			text: `SELECT * FROM (${tables.map((table) => `SELECT '${table}'::text AS model,to_jsonb(t) AS image FROM ${table} t`).join(' UNION ALL ')}) captured ORDER BY model,image::text`,
			params: []
		});
	const counts = () =>
		t.db.rows(
			Schema.Struct({
				roots: Schema.Number,
				branches: Schema.Number,
				leaves: Schema.Number,
				archives: Schema.Number
			}),
			{
				text: 'SELECT (SELECT count(*)::int FROM roots) AS roots,(SELECT count(*)::int FROM branches) AS branches,(SELECT count(*)::int FROM leaves) AS leaves,(SELECT count(*)::int FROM archives) AS archives',
				params: []
			}
		);
	const cleanJournal = Effect.gen(function* () {
		for (const table of [
			'pg_temp.bolt_write_context',
			'pg_temp.bolt_write_targets',
			'pg_temp.bolt_changes',
			'pg_temp.bolt_erased',
			'pg_temp.bolt_origins'
		]) {
			const exists = yield* t.db.value(Schema.Boolean, {
				text: 'SELECT to_regclass($1) IS NOT NULL',
				params: [table]
			});
			if (exists) {
				const count = yield* t.db.value(Schema.Number, {
					text: `SELECT count(*)::int FROM ${table}`,
					params: []
				});
				assert.equal(count, 0, `${table} must not retain settled writes`);
			}
		}
	});
	const rawDelete = { text: 'DELETE FROM roots WHERE id=$1', params: [root] };
	return {
		t,
		approvals,
		requester,
		reviewer,
		act,
		root,
		archive,
		branch,
		leaf,
		watcher,
		watcherRows,
		history,
		snapshot,
		counts,
		cleanJournal,
		rawDelete
	};
});

describe('database-owned referential actions', () => {
	it.live(
		'raw DELETE refuses a held descendant; released, it cascades and records both polymorphic SET NULL updates atomically',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const held = yield* f.act(
						'watchers',
						'update',
						[{ target: f.watcher, set: { name: 'Held watcher' } }],
						f.requester
					);
					assert.ok(held.outcome.kind === 'pendingApproval');
					const holding = yield* f.snapshot();
					const refused = yield* Effect.result(f.t.db.write(f.rawDelete));
					assert.ok(Result.isFailure(refused));
					assert.equal(refused.failure.sqlstate, 'BA001');
					assert.match(refused.failure.message, /^underApproval(?: |$)/);
					assert.deepEqual(yield* f.snapshot(), holding);
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 1, branches: 1, leaves: 1, archives: 1 }]);
					yield* f.approvals.decide({
						requestId: held.outcome.requestId,
						decision: 'reject',
						reason: 'Keep the name',
						authority: f.reviewer,
						now: f.t.clock.now()
					});
					// the held update and its rejection are revisions 2 and 3
					const before = yield* f.snapshot();
					const failed = yield* Effect.result(
						f.t.db.transaction({
							statements: [
								f.rawDelete,
								{
									text: "SELECT bolt_assert(false,'conflict','late referential guard')",
									params: []
								}
							]
						})
					);
					assert.ok(Result.isFailure(failed));
					assert.equal(failed.failure.sqlstate, 'BA001');
					assert.deepEqual(yield* f.snapshot(), before);
					yield* f.cleanJournal;
					yield* f.t.db.write(f.rawDelete);
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 0, branches: 0, leaves: 0, archives: 1 }]);
					assert.deepEqual(yield* f.watcherRows(), [
						{
							id: f.watcher,
							name: 'Watcher',
							first__roots: null,
							first__archives: null,
							second__roots: null,
							second__archives: null,
							revision: 5
						}
					]);
					const history = yield* f.history();
					assert.deepEqual(
						history
							.filter((row) => row.op === 'delete')
							.map((row) => ({
								model: row.model,
								record: row.record,
								revision: row.revision,
								cause: row.cause
							})),
						[
							{ model: 'branches', record: f.branch, revision: 2, cause: 'cascade' },
							{ model: 'leaves', record: f.leaf, revision: 2, cause: 'cascade' },
							{ model: 'roots', record: f.root, revision: 2, cause: 'direct' }
						]
					);
					const updates = history.filter(
						(row) => row.model === 'watchers' && row.op === 'update' && row.cause === 'cascade'
					);
					assert.deepEqual(
						updates.map((row) => ({
							revision: row.revision,
							cause: row.cause,
							request: row.request
						})),
						[
							{ revision: 4, cause: 'cascade', request: null },
							{ revision: 5, cause: 'cascade', request: null }
						]
					);
					assert.deepEqual(updates.flatMap((row) => Object.keys(row.changes)).sort(), [
						'first__roots',
						'second__roots'
					]);
					for (const row of updates) assert.deepEqual(Object.values(row.changes), [null]);
				})
			)
	);

	it.live(
		'a provisional native delete keeps the earliest checkpoint across both SET NULL events and key replay',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const key = randomUUID(),
						input = [{ target: f.root }];
					const first = yield* f.act('roots', 'delete', input, f.requester, key);
					assert.ok(first.outcome.kind === 'pendingApproval');
					const requestId = first.outcome.requestId;
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 0, branches: 0, leaves: 0, archives: 1 }]);
					assert.equal((yield* f.watcherRows())[0]?.revision, 3);
					const checkpoints = yield* f.t.db.value(Schema.Array(Checkpoint), {
						text: 'SELECT records FROM bolt_approvals WHERE id=$1',
						params: [requestId]
					});
					assert.deepEqual(
						[...checkpoints].sort((a, b) => a.model.localeCompare(b.model)),
						[
							{ model: 'branches', id: f.branch, op: 'delete', before: 1 },
							{ model: 'leaves', id: f.leaf, op: 'delete', before: 1 },
							{ model: 'roots', id: f.root, op: 'delete', before: 1 },
							{ model: 'watchers', id: f.watcher, op: 'update', before: 1 }
						]
					);
					const history = yield* f.history();
					assert.deepEqual(
						history
							.filter((row) => row.model === 'watchers' && row.op === 'update')
							.map((row) => ({
								revision: row.revision,
								request: row.request
							})),
						[
							{ revision: 2, request: requestId },
							{ revision: 3, request: requestId }
						]
					);
					assert.deepEqual(
						(yield* f.act('roots', 'delete', input, f.requester, key, true)).outcome,
						first.outcome
					);
					assert.deepEqual(yield* f.history(), history);
					yield* f.cleanJournal;
					assert.deepEqual(
						yield* f.approvals.decide({
							requestId,
							decision: 'reject',
							reason: 'Keep the root and both references',
							authority: f.reviewer,
							now: f.t.clock.now()
						}),
						{ kind: 'decided', requestId, status: 'Rejected' }
					);
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 1, branches: 1, leaves: 1, archives: 1 }]);
					assert.deepEqual(yield* f.watcherRows(), [
						{
							id: f.watcher,
							name: 'Watcher',
							first__roots: f.root,
							first__archives: null,
							second__roots: f.root,
							second__archives: null,
							revision: 4
						}
					]);
					const restored = (yield* f.history()).filter(
						(row) => row.request === requestId && row.cause === 'restored'
					);
					assert.deepEqual(
						restored.map((row) => row.model),
						['branches', 'leaves', 'roots', 'watchers']
					);
				})
			)
	);
});
