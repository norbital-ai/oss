import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { pruneHistory } from '../src/engine/query/history.ts';
import { Approvals, RunHandlers, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const requesterId = '0199a000-0000-7000-8000-000000000001',
	managerId = '0199a000-0000-7000-8000-000000000002',
	financeId = '0199a000-0000-7000-8000-000000000003';
const manifest: EngineManifest = {
	...base,
	models: {
		expenses: {
			description: 'Expenses',
			label: 'name',
			fields: { name: { kind: 'text' }, amount: { kind: 'money' }, manager: { kind: 'text' } }
		},
		lines: { description: 'Expense lines', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: { 'lines.expense': { to: 'expenses', inverse: 'lines', owned: true } },
	exposures: {
		expenses: {
			read: { expenses: { fields: 'all' } },
			create: {
				columns: { expenses: ['name', 'amount', 'manager'], 'expenses.lines': ['name'] },
				transform: true
			},
			update: {
				columns: { expenses: ['name', 'amount', 'manager'], 'expenses.lines': ['name'] },
				transform: true
			},
			delete: {},
			notify: true
		},
		lines: {
			read: { lines: { fields: 'all' } },
			create: { columns: { lines: ['name', 'expense'] } },
			update: { columns: { lines: ['name'] } },
			delete: {}
		}
	},
	policies: {
		requester: {
			description: 'Requests',
			grants: { expenses: { read: true, create: { check: true }, update: { check: true } } }
		},
		reviewer: { description: 'Reviews', grants: { expenses: { read: true } } }
	},
	teams: { requesters: ['requester'], managers: ['reviewer'], finance: ['reviewer'] }
};
const source = `import { Decimal } from '@norbital-ai/std/decimal';
export default { model: { expenses: { bodies: {
	create: function* (rows) { return rows.map((row) => ({...row,name:row.name.trim()})); },
	update: function* (changes) { return changes.map(({before,set}) => ({...set,name:(set.name ?? before.name).trim()})); },
	notify: function* (event) { return [{title:event.kind+':'+(event.move ?? event.action),to:[{user:'${managerId}'}]}]; }
} } }, policy: { requester: { grants: { expenses: {
	create: { check: function* (rows, ctx) {
		return ctx.approve((flow) => flow.step('Manager',{users:[...new Set(rows.map((r) => r.manager))]}).if(rows.some((r) => Decimal.of(String(r.amount)).gte(Decimal.of(100))),(f) => f.step('Finance',{teams:['finance']})));
	} },
	update: { check: function* (changes, ctx) {
		if (!changes.every(({ before }) => before.amount instanceof Decimal)) throw new Error('The stored amount must be a Decimal');
		const material = changes.filter(({ set }) => set.amount !== undefined || set.lines !== undefined);
		return material.length === 0 ? ctx.allow() : ctx.approve((flow) => flow.step('Manager',{users:[...new Set(material.map(({ before, set }) => set.manager ?? before.manager))]}).if(material.some(({ before, set }) => Decimal.of(String(set.amount ?? before.amount)).gte(Decimal.of(100))),(f) => f.step('Finance',{teams:['finance']})));
	} }
} } } } };`;
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
// one workspace per file: each test writes its own expense
const workspace = Layer.unwrap(
	program(source).pipe(
		Effect.map((guest) => TestWorkspace.layer({ manifest, guest, now: '2026-10-24T08:00:00.000Z' }))
	)
);
const fixture = Effect.gen(function* () {
	const t = yield* TestWorkspace,
		writes = yield* Writes,
		approvals = yield* Approvals,
		handlers = yield* RunHandlers;
	yield* t.db.write({
		text: "INSERT INTO sys_user (id,name,kind,team) VALUES ($1,'Requester','staff','requesters'),($2,'Manager','staff','managers'),($3,'Finance','staff','finance') ON CONFLICT (id) DO NOTHING",
		params: [requesterId, managerId, financeId]
	});
	const as = (id: string, team: string, policies: readonly string[]): Authority =>
		compileAuthority(manifest, { actor: member(id, team), policies, admin: false }, id);
	const requester = as(requesterId, 'requesters', ['requester']),
		manager = as(managerId, 'managers', ['reviewer']),
		finance = as(financeId, 'finance', ['reviewer']);
	const act = (verb: 'create' | 'update', input: Json, authority = requester) => {
		const key = randomUUID(),
			now = t.clock.now();
		return writes.act({
			model: 'expenses',
			verb,
			input,
			authority,
			key,
			issuedAt: now,
			invocationId: key,
			mode: { _tag: 'Direct' },
			bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
		});
	};
	const decide = (
		requestId: string,
		decision: 'approve' | 'reject' | 'requestChanges',
		authority = manager,
		reason?: string
	) =>
		approvals.decide({
			requestId,
			decision,
			authority,
			now: t.clock.now(),
			...(reason === undefined ? {} : { reason })
		});
	const row = (id: string) =>
		t.db.one(Schema.Struct({ name: Schema.String, amount: Schema.Number }), {
			text: 'SELECT name,amount::float8 AS amount FROM expenses WHERE id=$1::uuid',
			params: [id]
		});
	const request = (id: string) =>
		t.db.value(Schema.Json, {
			text: "SELECT jsonb_build_object('state',state,'step',step,'route',route,'log',log) FROM bolt_approvals WHERE id=$1::uuid",
			params: [id]
		});
	const notices = () =>
		Effect.gen(function* () {
			const run = yield* handlers.handler('bolt.notify');
			if (Option.isNone(run)) throw new Error('Missing notify handler');
			const pending = yield* t.db.rows(Schema.Struct({ id: Schema.String, input: Schema.Json }), {
				text: "SELECT id,input FROM sys_run WHERE automation='bolt.notify' AND state='queued'",
				params: []
			});
			for (const current of pending) {
				yield* run.value(current.input, { id: current.id, starter: null });
				yield* t.db.write({
					text: "UPDATE sys_run SET state='completed' WHERE id=$1",
					params: [current.id]
				});
			}
			return yield* t.db.rows(Schema.Struct({ title: Schema.String }), {
				text: 'SELECT title FROM sys_notification ORDER BY id',
				params: []
			});
		});
	return { t, requester, manager, finance, act, decide, row, request, notices };
});

layer(workspace, { excludeTestServices: true })('approval snapshots and saves', (it) => {
	it.effect(
		'preserves open checkpoints during history pruning and refuses rollback without its checkpoint',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const original = (yield* f.act(
						'create',
						[{ name: 'Travel', amount: 50, manager: managerId }],
						f.t.as(f.t.admin).authority
					)).outcome;
					if (original.kind !== 'committed') throw new Error('Missing committed expense');
					const record = original.records.find((row) => row.model === 'expenses');
					if (record === undefined) throw new Error('Missing expense');
					const { id, revision } = record;
					const checkpoint = () =>
						f.t.db.value(Schema.Int, {
							text: "SELECT count(*)::int FROM bolt_history WHERE collection='expenses' AND record=$1::uuid AND revision=$2",
							params: [id, revision]
						});
					const proposed = (yield* f.act('update', [{ target: id, set: { amount: 150 } }])).outcome;
					if (proposed.kind !== 'pendingApproval') throw new Error('Missing approval');
					yield* f.decide(proposed.requestId, 'requestChanges', f.manager, 'Clarify');
					yield* pruneHistory(f.t.db, 1);
					expect(yield* checkpoint()).toBe(1);
					expect(
						(yield* f.act('update', [{ target: id, set: { amount: 151 } }])).outcome
					).toMatchObject({ kind: 'pendingApproval', requestId: proposed.requestId });
					yield* pruneHistory(f.t.db, 1);
					expect(yield* checkpoint()).toBe(1);
					expect(
						yield* f.decide(proposed.requestId, 'reject', f.manager, 'Restore the checkpoint')
					).toMatchObject({ kind: 'decided', status: 'Rejected' });
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
					expect(yield* pruneHistory(f.t.db, 1)).toBeGreaterThan(0);
					expect(yield* checkpoint()).toBe(0);
					const again = (yield* f.act('update', [{ target: id, set: { amount: 160 } }])).outcome;
					if (again.kind !== 'pendingApproval') throw new Error('Missing second approval');
					// Reproduce unavailable history without weakening the production pruning path.
					yield* f.t.db.write({
						text: "DELETE FROM bolt_history WHERE collection='expenses' AND record=$1::uuid",
						params: [id]
					});
					expect(yield* f.decide(again.requestId, 'reject', f.manager, 'Restore')).toMatchObject({
						kind: 'refused'
					});
					expect(yield* f.request(again.requestId)).toMatchObject({ state: 'Pending' });
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(160);
				})
			)
	);
	it.effect(
		'stores named user/team steps, runs callbacks, locks the held record, and only the current user may approve',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture,
						result = yield* f.act('create', [
							{
								name: '  Travel  ',
								amount: 150,
								manager: managerId
							}
						]);
					if (result.outcome.kind !== 'pendingApproval')
						throw new Error(JSON.stringify(result.outcome));
					const id = result.outcome.records[0]?.id;
					if (id === undefined) throw new Error('Missing expense');
					expect(Option.getOrThrow(yield* f.row(id)).name).toBe('Travel');
					expect(yield* f.request(result.outcome.requestId)).toMatchObject({
						state: 'Pending',
						step: 0,
						route: {
							steps: [
								{ name: 'Manager', users: [managerId], teams: [] },
								{ name: 'Finance', teams: ['finance'], users: [] }
							]
						}
					});
					expect(
						(yield* f.act('update', [{ target: id, set: { name: 'Not allowed' } }])).outcome.kind
					).toBe('refused');
					// a rejection needs its reason
					expect(yield* f.decide(result.outcome.requestId, 'reject')).toMatchObject({
						kind: 'refused'
					});
					expect(yield* f.decide(result.outcome.requestId, 'approve', f.finance)).toMatchObject({
						kind: 'refused',
						code: 'forbidden'
					});
					expect(yield* f.decide(result.outcome.requestId, 'approve')).toMatchObject({
						kind: 'decided',
						status: 'Pending'
					});
					expect(yield* f.decide(result.outcome.requestId, 'approve', f.finance)).toMatchObject({
						kind: 'decided',
						status: 'Approved'
					});
					expect((yield* f.notices()).map((n) => n.title)).toContain('approval:approve');
				})
			)
	);
	it.effect(
		'requester saving resubmits through update.transform, retaining a matching step or restarting a changed flow',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture,
						created = yield* f.act('create', [{ name: 'Travel', amount: 150, manager: managerId }]);
					if (created.outcome.kind !== 'pendingApproval')
						throw new Error(JSON.stringify(created.outcome));
					const id = created.outcome.records[0]?.id,
						requestId = created.outcome.requestId;
					if (id === undefined) throw new Error('Missing expense');
					yield* f.decide(requestId, 'approve');
					yield* f.decide(requestId, 'requestChanges', f.finance, 'Clarify');
					expect(
						(yield* f.act('update', [{ target: id, set: { name: '  Clarified  ' } }])).outcome
					).toMatchObject({ kind: 'pendingApproval', requestId });
					expect(Option.getOrThrow(yield* f.row(id)).name).toBe('Clarified');
					expect(yield* f.request(requestId)).toMatchObject({ state: 'Pending', step: 1 });
					yield* f.decide(requestId, 'requestChanges', f.finance, 'Reduce');
					yield* f.act('update', [{ target: id, set: { amount: 50 } }]);
					expect(yield* f.request(requestId)).toMatchObject({
						state: 'Pending',
						step: 0,
						route: { steps: [{ name: 'Manager', users: [managerId], teams: [] }] }
					});
					expect((yield* f.notices()).map((n) => n.title)).toContain('approval:resubmit');
				})
			)
	);
	it.effect('held owned relation actions still require review on a same-value parent Save', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const created = (yield* f.act(
					'create',
					[
						{
							name: 'Travel',
							amount: 50,
							manager: managerId,
							lines: [{ name: 'First' }]
						}
					],
					f.t.as(f.t.admin).authority
				)).outcome;
				if (created.kind !== 'committed') throw new Error(JSON.stringify(created));
				const id = created.records.find((row) => row.model === 'expenses')?.id;
				const line = created.records.find((row) => row.model === 'lines')?.id;
				if (id === undefined || line === undefined) throw new Error('Missing expense or line');
				const revision = yield* f.t.db.value(Schema.Int, {
					text: 'SELECT revision FROM expenses WHERE id=$1::uuid',
					params: [id]
				});
				const proposed = (yield* f.act('update', [
					{
						target: id,
						set: { lines: { update: [{ target: line, set: { name: 'Second' } }] } }
					}
				])).outcome;
				if (proposed.kind !== 'pendingApproval') throw new Error(JSON.stringify(proposed));
				const requestId = proposed.requestId;
				// relationship actions stay authored until this request resolves
				const set = { lines: { update: [{ target: line, set: { name: 'First' } }] } };
				expect(
					yield* f.decide(requestId, 'requestChanges', f.manager, 'Clarify the line')
				).toMatchObject({ kind: 'decided', status: 'ChangesRequested' });
				expect((yield* f.act('update', [{ target: id, set }])).outcome).toMatchObject({
					kind: 'pendingApproval',
					requestId
				});
				expect(yield* f.request(requestId)).toMatchObject({ state: 'Pending' });
				expect(
					yield* f.t.db.value(Schema.Int, {
						text: 'SELECT revision FROM expenses WHERE id=$1::uuid',
						params: [id]
					})
				).toBe(revision);
				yield* f.decide(requestId, 'reject', f.manager, 'Restore the line');
				expect(
					yield* f.t.db.value(Schema.String, {
						text: 'SELECT name FROM lines WHERE id=$1::uuid',
						params: [line]
					})
				).toBe('First');
			})
		)
	);
});
