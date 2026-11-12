import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import type { Authority, EngineActor, Sql } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const recordId = '0199a000-0000-7000-8000-000000000001',
	requesterId = '0199a000-0000-7000-8000-000000000002',
	reviewerId = '0199a000-0000-7000-8000-000000000003';
const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Documents',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		documents: {
			outputs: { default: { documents: { fields: 'all' } } },
			update: { columns: { documents: ['title'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests changes',
			grants: { documents: { outputs: { default: {} }, update: { verdict: true } } }
		},
		reviewer: {
			description: 'Reviews and edits changes',
			grants: { documents: { outputs: { default: {} }, update: {} } }
		}
	},
	teams: { requesters: { policies: ['requester'] }, reviewers: { policies: ['reviewer'] } }
};
const guest = program(`export default { policy: { requester: { grants: { documents: {
	update: { verdict: function* (changes, ctx) { return ctx.approve({ steps: [{ name: 'Review', teams: ['reviewers'] }] }); } }
} } } } };`);
const member = (id: string, team: string): Extract<EngineActor, { kind: 'member' }> => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [team],
	team_path: [team],
	admin: false,
	party: null
});

it.live('rejection conflicts when the record or approval changes before the decision', () =>
	Effect.scoped(
		Effect.gen(function* () {
			let paused = yield* Deferred.make<void>(),
				resume = yield* Deferred.make<void>();
			const database = yield* Layer.build(PgliteDb.layer());
			const native = Context.get(database, TenantDb);
			let armed = false;
			// Pause after rollback planning, before the native adapter acquires the decision's locks.
			const beforeDecision = (statements: readonly Sql[]) =>
				Effect.suspend(() => {
					if (!armed || !statements.some((statement) => statement.text.includes('ap_authorize AS')))
						return Effect.void;
					armed = false;
					return Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)));
				});
			const db = TenantDb.typed({
				read: native.read,
				write: (statement, lock) =>
					beforeDecision([statement]).pipe(Effect.andThen(native.write(statement, lock))),
				transaction: (batch) =>
					beforeDecision(batch.statements).pipe(Effect.andThen(native.transaction(batch)))
			});
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					guest: yield* guest,
					db: Layer.succeed(TenantDb, db),
					seed: { documents: [{ id: recordId, title: 'A' }] }
				})
			);
			const t = Context.get(context, TestWorkspace),
				writes = Context.get(context, Writes),
				approvals = Context.get(context, Approvals);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, name, kind, team) VALUES
	($1, 'Requester', 'staff', 'requesters'), ($2, 'Reviewer', 'staff', 'reviewers')`,
				params: [requesterId, reviewerId]
			});
			const authority = (id: string, team: string, policy: string) =>
				compile_authority(
					manifest,
					{ actor: member(id, team), policies: [policy], admin: false },
					id
				);
			const requester = yield* authority(requesterId, 'requesters', 'requester'),
				reviewer = yield* authority(reviewerId, 'reviewers', 'reviewer');
			const update = (title: string, revision: number, as: Authority) => {
				const key = randomUUID(),
					now = t.clock.now();
				return writes.act({
					model: 'documents',
					verb: 'update',
					input: [{ target: recordId, set: { title } }],
					observed: { [recordId]: revision },
					authority: as,
					key,
					issuedAt: now,
					invocationId: key,
					mode: { _tag: 'Direct' },
					bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
				});
			};
			const row = () =>
				t.db.rows(Schema.Struct({ title: Schema.String, revision: Schema.Number }), {
					text: 'SELECT title, revision FROM documents WHERE id = $1::uuid',
					params: [recordId]
				});
			assert.deepEqual(yield* row(), [{ title: 'A', revision: 1 }]);
			const provisional = yield* update('B', 1, requester);
			assert.ok(provisional.outcome.kind === 'pending_approval');
			const request_id = provisional.outcome.request_id;
			assert.deepEqual(yield* row(), [{ title: 'B', revision: 2 }]);
			assert.equal((yield* update('A', 2, reviewer)).outcome.kind, 'committed');
			assert.deepEqual(yield* row(), [{ title: 'A', revision: 3 }]);
			const request = () =>
				t.db.rows(
					Schema.Struct({ state: Schema.String, step: Schema.Number, moves: Schema.Number }),
					{
						text: 'SELECT state, step, jsonb_array_length(log)::int AS moves FROM bolt_approvals WHERE id = $1::uuid',
						params: [request_id]
					}
				);
			const pending = yield* request();
			assert.deepEqual(pending, [{ state: 'Pending', step: 0, moves: 1 }]);
			const reject = () =>
				approvals.decide({
					request_id,
					decision: 'reject',
					reason: 'Restore the checkpoint',
					authority: reviewer,
					now: t.clock.now()
				});
			armed = true;
			const rejecting = yield* reject().pipe(Effect.forkScoped);
			yield* Deferred.await(paused);
			assert.equal((yield* update('C', 3, reviewer)).outcome.kind, 'committed');
			assert.deepEqual(yield* row(), [{ title: 'C', revision: 4 }]);
			assert.deepEqual(yield* request(), pending);
			yield* Deferred.succeed(resume, undefined);
			assert.equal((yield* Fiber.join(rejecting)).kind, 'conflict');
			assert.deepEqual(yield* request(), pending);
			assert.deepEqual(yield* row(), [{ title: 'C', revision: 4 }]);
			assert.deepEqual(yield* reject(), { kind: 'decided', request_id, status: 'Rejected' });
			assert.deepEqual(yield* row(), [{ title: 'A', revision: 5 }]);
			assert.deepEqual(yield* request(), [{ state: 'Rejected', step: 0, moves: 2 }]);

			const submitted = (yield* update('D', 5, requester)).outcome;
			assert.ok(submitted.kind === 'pending_approval');
			const decision = {
				request_id: submitted.request_id,
				authority: reviewer,
				now: t.clock.now()
			};
			const history = () =>
				t.db.rows(
					Schema.Struct({ revision: Schema.Number, op: Schema.String, cause: Schema.String }),
					{
						text: 'SELECT revision, op, cause FROM bolt_history WHERE collection = $1 AND record = $2::uuid ORDER BY revision',
						params: ['documents', recordId]
					}
				);
			const beforeRace = yield* history();
			paused = yield* Deferred.make<void>();
			resume = yield* Deferred.make<void>();
			armed = true;
			const rejected = yield* approvals
				.decide({
					...decision,
					decision: 'reject',
					reason: 'Restore the checkpoint'
				})
				.pipe(Effect.forkScoped);
			yield* Deferred.await(paused);
			assert.deepEqual(yield* approvals.decide({ ...decision, decision: 'approve' }), {
				kind: 'decided',
				request_id: submitted.request_id,
				status: 'Approved'
			});
			yield* Deferred.succeed(resume, undefined);
			assert.equal((yield* Fiber.join(rejected)).kind, 'conflict');
			assert.deepEqual(yield* row(), [{ title: 'D', revision: 6 }]);
			assert.deepEqual(yield* history(), beforeRace);
			assert.deepEqual(
				yield* t.db.rows(
					Schema.Struct({
						state: Schema.String,
						status: Schema.String,
						moves: Schema.Number,
						last_move: Schema.String,
						rejections: Schema.Number
					}),
					{
						text: `SELECT a.state, p.status, jsonb_array_length(a.log)::int AS moves,
							a.log -> -1 ->> 'move' AS last_move,
							(SELECT count(*)::int FROM jsonb_array_elements(a.log) entry WHERE entry->>'move' = 'reject') AS rejections
							FROM bolt_approvals a JOIN approval_request p ON p.id = a.id WHERE a.id = $1::uuid`,
						params: [submitted.request_id]
					}
				),
				[{ state: 'Approved', status: 'APPROVED', moves: 2, last_move: 'approve', rejections: 0 }]
			);
		})
	)
);
