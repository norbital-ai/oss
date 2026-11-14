import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Approvals, Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { one_act } from './support/act-one.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		roots: {
			description: 'A root',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		archives: {
			description: 'An archive',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		branches: {
			description: 'A branch',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		leaves: {
			description: 'A leaf',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		watchers: {
			description: 'A watcher',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		}
	},
	relationships: {
		'branches.root': { to: 'roots', on_delete: 'cascade' },
		'leaves.branch': { to: 'branches', on_delete: 'cascade' },
		'watchers.first': { to: ['roots', 'archives'], optional: true, on_delete: 'set_null' },
		'watchers.second': { to: ['roots', 'archives'], optional: true, on_delete: 'set_null' }
	},
	exposures: {
		roots: {
			outputs: { default: { roots: { fields: 'all' } } },
			create: { columns: { roots: ['name'] } },
			delete: {}
		},
		archives: {
			outputs: { default: { archives: { fields: 'all' } } },
			create: { columns: { archives: ['name'] } }
		},
		branches: {
			outputs: { default: { branches: { fields: 'all' } } },
			create: { columns: { branches: ['name', 'root'] } }
		},
		leaves: {
			outputs: { default: { leaves: { fields: 'all' } } },
			create: { columns: { leaves: ['name', 'branch'] } }
		},
		watchers: {
			outputs: { default: { watchers: { fields: 'all' } } },
			create: { columns: { watchers: ['name', 'first', 'second'] } },
			update: { columns: { watchers: ['name'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests changes',
			grants: {
				roots: { outputs: { default: { history: true } }, delete: { verdict: true } },
				watchers: { outputs: { default: { history: true } }, update: { verdict: true } }
			}
		},
		reviewer: {
			description: 'Reviews changes',
			grants: { roots: { outputs: { default: {} } }, watchers: { outputs: { default: {} } } }
		}
	},
	teams: { requesters: { policies: ['requester'] }, reviewers: { policies: ['reviewer'] } }
};
const guest = program(`export default { policy: { requester: { grants: {
	roots: { delete: { verdict: function* (rows, ctx) { return ctx.approve({ steps: [{ name: 'Review deletion', teams: ['reviewers'] }] }); } } },
	watchers: { update: { verdict: function* (changes, ctx) { return ctx.approve({ steps: [{ name: 'Review watcher', teams: ['reviewers'] }] }); } } }
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
		writes = Context.get(context, Callables),
		approvals = Context.get(context, Approvals),
		admin = (yield* t.as(t.admin)).authority,
		requester = (yield* t.as(
			t.member(['requester'], { teams: ['requesters'], team_path: ['requesters'] })
		)).authority,
		reviewer = (yield* t.as(
			t.member(['reviewer'], { teams: ['reviewers'], team_path: ['reviewers'] })
		)).authority;
	const act = (
		model: Model,
		verb: 'create' | 'update' | 'delete',
		input: Json,
		authority = admin,
		key = randomUUID(),
		retry = false
	) => {
		const now = t.clock.now();
		return writes.acts(one_act({
			model,
			verb,
			input,
			authority,
			key,
			retry,
			issuedAt: now,
			invocationId: key,
			bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
		}));
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
	// a write keeps no session buffer: its row images are its own statement's
	const cleanJournal = Effect.gen(function* () {
		const buffers = yield* t.db.value(Schema.Number, {
			text: "SELECT count(*)::int FROM pg_class WHERE relpersistence = 't' AND relname IN ('bolt_write_context','bolt_write_targets','bolt_changes','bolt_erased','bolt_origins')",
			params: []
		});
		assert.equal(buffers, 0, 'a write must not leave session buffers');
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
					assert.ok(held.outcome.kind === 'pending_approval');
					const holding = yield* f.snapshot();
					const refused = yield* Effect.result(f.t.db.write(f.rawDelete));
					assert.ok(Result.isFailure(refused));
					assert.equal(refused.failure.sqlstate, 'BA001');
					assert.match(refused.failure.message, /^under_approval(?: |$)/);
					assert.deepEqual(yield* f.snapshot(), holding);
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 1, branches: 1, leaves: 1, archives: 1 }]);
					yield* f.approvals.decide({
						request_id: held.outcome.request_id,
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
		'a held delete changes nothing until approved, then unlinks both SET NULL references in one revision of its request',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const key = randomUUID(),
						input = [{ target: f.root }];
					const before = yield* f.history();
					const first = yield* f.act('roots', 'delete', input, f.requester, key);
					assert.ok(first.outcome.kind === 'pending_approval');
					const request_id = first.outcome.request_id;
					yield* f.cleanJournal;
					assert.deepEqual(yield* f.counts(), [{ roots: 1, branches: 1, leaves: 1, archives: 1 }]);
					assert.equal((yield* f.watcherRows())[0]?.revision, 1);
					assert.deepEqual(
						yield* f.t.db.value(Schema.Array(Checkpoint), {
							text: 'SELECT records FROM bolt_approvals WHERE id=$1',
							params: [request_id]
						}),
						[{ model: 'roots', id: f.root, op: 'delete', before: 1 }]
					);
					assert.deepEqual(yield* f.history(), before);
					assert.deepEqual(
						(yield* f.act('roots', 'delete', input, f.requester, key, true)).outcome,
						first.outcome
					);
					assert.deepEqual(yield* f.history(), before);
					yield* f.cleanJournal;
					assert.deepEqual(
						yield* f.approvals.decide({
							request_id,
							decision: 'approve',
							authority: f.reviewer,
							now: f.t.clock.now()
						}),
						{ kind: 'decided', request_id, status: 'Approved' }
					);
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
							revision: 2
						}
					]);
					assert.deepEqual(
						(yield* f.history())
							.filter((row) => row.request === request_id)
							.map((row) => `${row.model}:${row.op}`),
						['branches:delete', 'leaves:delete', 'roots:delete', 'watchers:update']
					);
				})
			)
	);
});
