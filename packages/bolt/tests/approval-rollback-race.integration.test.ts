import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import type { Authority, EngineActor, Sql } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { manifest as base } from './write-fixture.ts';

const recordId = '0199a000-0000-7000-8000-000000000001',
	requesterId = '0199a000-0000-7000-8000-000000000002',
	reviewerId = '0199a000-0000-7000-8000-000000000003';
const manifest: EngineManifest = {
	...base,
	models: {
		documents: {
			description: 'Documents',
			label: 'title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		documents: {
			read: { documents: { fields: 'all' } },
			update: { columns: { documents: ['title'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests changes',
			grants: { documents: { read: true, update: { check: true } } }
		},
		reviewer: {
			description: 'Reviews and edits changes',
			grants: { documents: { read: true, update: true } }
		}
	},
	teams: { requesters: ['requester'], reviewers: ['reviewer'] }
};
const guest = program(`export default { policy: { requester: { grants: { documents: {
	update: { check: function* (changes, ctx) { return ctx.approve((flow) => flow.step('Review', { teams: ['reviewers'] })); } }
} } } } };`);
const member = (id: string, team: string): Extract<EngineActor, { kind: 'member' }> => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [team],
	teamPath: [team],
	admin: false,
	party: null
});

it.live('rejection conflicts when an observed no-op rollback row changes before the decision', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const paused = yield* Deferred.make<void>(),
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
					beforeDecision(batch.statements).pipe(Effect.andThen(native.transaction(batch))),
				session: native.session
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
				compileAuthority(
					manifest,
					{ actor: member(id, team), policies: [policy], admin: false },
					id
				);
			const requester = authority(requesterId, 'requesters', 'requester'),
				reviewer = authority(reviewerId, 'reviewers', 'reviewer');
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
			assert.ok(provisional.outcome.kind === 'pendingApproval');
			const requestId = provisional.outcome.requestId;
			assert.deepEqual(yield* row(), [{ title: 'B', revision: 2 }]);
			assert.equal((yield* update('A', 2, reviewer)).outcome.kind, 'committed');
			assert.deepEqual(yield* row(), [{ title: 'A', revision: 3 }]);
			const request = () =>
				t.db.rows(
					Schema.Struct({ state: Schema.String, step: Schema.Number, moves: Schema.Number }),
					{
						text: 'SELECT state, step, jsonb_array_length(log)::int AS moves FROM bolt_approvals WHERE id = $1::uuid',
						params: [requestId]
					}
				);
			const pending = yield* request();
			assert.deepEqual(pending, [{ state: 'Pending', step: 0, moves: 1 }]);
			const reject = () =>
				approvals.decide({
					requestId,
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
			assert.deepEqual(yield* reject(), { kind: 'decided', requestId, status: 'Rejected' });
			assert.deepEqual(yield* row(), [{ title: 'A', revision: 5 }]);
			assert.deepEqual(yield* request(), [{ state: 'Rejected', step: 0, moves: 2 }]);
		})
	)
);
