import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { pruneHistory } from '../src/engine/query/history.ts';
import { Approvals, RunHandlers, Writes } from '../src/engine/services.ts';
import { Files } from '../src/engine/ports.ts';
import { storeFile } from '../src/engine/facilities.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { label, labelExpression } from '@norbital-ai/std/label';
import { inboxRequests, openRequests } from '../src/engine/approvals/inbox.ts';

const requesterId = '0199a000-0000-7000-8000-000000000001',
	managerId = '0199a000-0000-7000-8000-000000000002',
	financeId = '0199a000-0000-7000-8000-000000000003';
const manifest: EngineManifest = {
	...base,
	models: {
		expenses: {
			description: 'Expenses',
			record_label: "record.display_name + ' · ' + record.manager_name",
			search: { text: ['amount'] },
			fields: {
				name: { kind: 'text' },
				amount: { kind: 'money' },
				manager: { kind: 'text' },
				manager_name: { kind: 'text', default: 'Manager' },
				receipt: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true }
			},
			computed: { display_name: { kind: 'text', expr: { upper: { field: 'name' } } } }
		},
		lines: { description: 'Expense lines', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {
		'lines.expense': { to: 'expenses', inverse: 'lines', owned: true },
		'expenses.manager': { to: 'sys_user' }
	},
	exposures: {
		expenses: {
			outputs: { default: { expenses: { fields: 'all' } } },
			create: {
				columns: { expenses: ['name', 'amount', 'manager', 'receipt'], 'expenses.lines': ['name'] },
				transform: true
			},
			update: {
				columns: { expenses: ['name', 'amount', 'manager', 'receipt'], 'expenses.lines': ['name'] },
				transform: true
			},
			delete: {},
			notify: true
		},
		lines: {
			outputs: { default: { lines: { fields: 'all' } } },
			create: { columns: { lines: ['name', 'expense'] } },
			update: { columns: { lines: ['name'] } },
			delete: {}
		}
	},
	policies: {
		requester: {
			description: 'Requests',
			grants: {
				sys_user: { outputs: { default: true } },
				expenses: {
					outputs: { default: true },
					create: { verdict: true },
					update: { verdict: true }
				}
			}
		},
		reviewer: {
			description: 'Reviews',
			grants: {
				expenses: { outputs: { default: true } },
				approval_request: { outputs: { default: true } }
			}
		}
	},
	teams: { requesters: ['requester'], managers: ['reviewer'], finance: ['reviewer'] }
};
const source = `import { Decimal } from '@norbital-ai/std/decimal';
const managerStep = (ids) => ({
	name: 'Manager',
	teams: [...new Set(ids.map((id) =>
		id === '${managerId}' ? 'managers' : id === '${financeId}' ? 'finance' : 'requesters'
	))]
});
const financeStep = { name: 'Finance', teams: ['finance'] };
export default { model: { expenses: { bodies: {
	create: function* (rows) { return rows.map((row) => ({...row,name:row.name.trim()})); },
	update: function* (changes) { return changes.map(({before,set}) => ({...set,name:(set.name ?? before.name).trim()})); },
	notify: function* (event) { return [{title:event.kind+':'+(event.move ?? event.action),to:[{user:'${managerId}'}]}]; }
} } }, policy: { requester: { grants: { expenses: {
	create: { verdict: function* (rows, ctx) {
		return ctx.approve({
			steps: [
				managerStep(rows.map((row) => row.manager)),
				...(rows.some((row) => Decimal.of(String(row.amount)).gte(Decimal.of(100))) ? [financeStep] : [])
			],
			...(rows.some((row) => row.name === 'Override by team') ? { superseded_by: ['finance'] } : {})
		});
	} },
	update: { verdict: function* (changes, ctx) {
		if (!changes.every(({ before }) => before.amount instanceof Decimal)) throw new Error('The stored amount must be a Decimal');
		const material = changes.filter(({ set }) => set.amount !== undefined || set.lines !== undefined || set.receipt !== undefined);
		return material.length === 0 ? ctx.allow() : ctx.approve({
			steps: [
				managerStep(material.map(({ before, set }) => set.manager ?? before.manager)),
				...(material.some(({ before, set }) => Decimal.of(String(set.amount ?? before.amount)).gte(Decimal.of(100)))
					? [financeStep] : [])
			]
		});
	} }
} } } } };`;
const WITHDRAW = { decision: 'withdraw', reason: 'optional' };
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
		decision: 'approve' | 'reject' | 'requestChanges' | 'withdraw',
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
	/** The readable face (`approval_request`) of a request. */
	const face = (id: string) =>
		t.db.value(Schema.Json, {
			text: "SELECT jsonb_build_object('status',status,'closed_by',closed_by) FROM approval_request WHERE id=$1::uuid",
			params: [id]
		});
	const search = (query: string, authority = manager) =>
		t
			.as(authority)
			.query(
				dynamicRead({
					approval_request: { search: query, fields: ['collection_name'], limit: 20 }
				})
			)
			.pipe(Effect.map((answer) => answer.approval_request?.rows ?? []));
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
	return { t, requester, manager, finance, act, decide, row, request, face, search, notices };
});

layer(workspace, { excludeTestServices: true })('approval snapshots and saves', (it) => {
	it.effect('rejecting a file replacement restores the previous reference and its bytes', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const files = yield* Files;
			const save = storeFile({ db: f.t.db, files, manifest });
			const prior = new TextEncoder().encode('original receipt');
			const meta = { mime: 'text/plain', for: 'expenses.receipt', by: requesterId };
			const oldFile = yield* save(prior, { ...meta, name: 'original.txt' }, 'test');
			const nextFile = yield* save(
				new TextEncoder().encode('replacement'),
				{ ...meta, name: 'new.txt' },
				'test'
			);
			const created = (yield* f.act('create', [
				{ name: 'Replace receipt', amount: 50, manager: managerId, receipt: oldFile }
			])).outcome;
			if (created.kind !== 'pendingApproval') throw new Error(JSON.stringify(created));
			const id = created.records[0]?.id;
			if (id === undefined) throw new Error('Missing expense');
			expect(yield* f.decide(created.requestId, 'approve')).toMatchObject({ status: 'Approved' });
			const proposed = (yield* f.act('update', [{ target: id, set: { receipt: nextFile } }]))
				.outcome;
			if (proposed.kind !== 'pendingApproval') throw new Error(JSON.stringify(proposed));
			const stored = () =>
				f.t.db.one(Schema.Struct({ id: Schema.String, key: Schema.String }), {
					text: "SELECT f.id,f.key FROM expenses e JOIN sys_file f ON f.id=e.receipt->>'id' WHERE e.id=$1",
					params: [id]
				});
			expect(Option.getOrThrow(yield* stored()).id).toBe(nextFile.id);
			expect(
				yield* f.decide(proposed.requestId, 'reject', f.manager, 'Restore original receipt')
			).toMatchObject({ status: 'Rejected' });
			const restored = Option.getOrThrow(yield* stored());
			expect(restored.id).toBe(oldFile.id);
			expect(yield* files.get(restored.key, 1024)).toEqual(prior);
		})
	);

	it.effect('a removed reviewer cannot decide a request that still names their team', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const id = randomUUID();
			yield* f.t.db.write({
				text: "INSERT INTO sys_user (id, name, kind, team) VALUES ($1, 'Former reviewer', 'staff', 'finance')",
				params: [id]
			});
			const previous = compileAuthority(
				manifest,
				{ actor: member(id, 'finance'), policies: ['reviewer'], admin: false },
				id
			);
			const submitted = (yield* f.act('create', [
				{ name: 'Team snapshot', amount: 150, manager: managerId }
			])).outcome;
			if (submitted.kind !== 'pendingApproval') throw new Error('Missing approval');
			yield* f.decide(submitted.requestId, 'approve');
			const waiting = yield* f.request(submitted.requestId);
			yield* f.t.db.write({
				text: "UPDATE sys_user SET team = 'managers' WHERE id = $1",
				params: [id]
			});
			expect(yield* f.decide(submitted.requestId, 'approve', previous)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.requestId)).toEqual(waiting);
		})
	);
	it.effect('rejecting requested changes immediately restores the checkpoint', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const original = (yield* f.act(
				'create',
				[{ name: 'Original', amount: 25, manager: managerId }],
				f.t.as(f.t.admin).authority
			)).outcome;
			const id = original.kind === 'committed' ? original.records[0]?.id : undefined;
			if (id === undefined) throw new Error('Missing original row');
			const submitted = (yield* f.act('update', [{ target: id, set: { amount: 50 } }])).outcome;
			if (submitted.kind !== 'pendingApproval') throw new Error('Missing approval');
			expect(
				yield* f.decide(submitted.requestId, 'requestChanges', f.manager, 'Please review')
			).toMatchObject({ kind: 'decided', status: 'ChangesRequested' });
			expect(
				yield* f.decide(submitted.requestId, 'reject', f.manager, 'Restore original')
			).toMatchObject({ kind: 'decided', status: 'Rejected' });
			expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(25);
		})
	);
	it.effect('administrators and named superseder teams can close a request with a reason', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const [name, actor] of [
				['Override by admin', f.t.as(f.t.admin).authority],
				['Override by team', f.finance]
			] as const) {
				const submitted = (yield* f.act('create', [{ name, amount: 50, manager: managerId }]))
					.outcome;
				if (submitted.kind !== 'pendingApproval') throw new Error('Missing approval');
				expect(yield* f.decide(submitted.requestId, 'approve', actor)).toMatchObject({
					kind: 'refused'
				});
				expect(
					yield* f.decide(submitted.requestId, 'approve', actor, 'Override authorised')
				).toMatchObject({ kind: 'decided', status: 'Superseded' });
				expect(yield* f.request(submitted.requestId)).toMatchObject({ state: 'Superseded' });
			}
		})
	);
	it.effect(
		'prevents self-review through a named user, administrator override, or member preview',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const id = randomUUID();
				yield* f.t.db.write({
					text: "INSERT INTO sys_user (id,name,kind,team) VALUES ($1,'Self review requester','staff','requesters')",
					params: [id]
				});
				const requester = compileAuthority(
					manifest,
					{
						actor: member(id, 'requesters'),
						policies: ['requester'],
						admin: false
					},
					id
				);
				const submitted = (yield* f.act(
					'create',
					[
						{ name: 'Self review', amount: 50, manager: id },
						{ name: 'Peer review', amount: 50, manager: managerId }
					],
					requester
				)).outcome;
				if (submitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(submitted));
				const requestId = submitted.requestId;
				expect(yield* f.decide(requestId, 'approve', requester)).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(
					(yield* f.act(
						'update',
						[
							{
								target: submitted.records[0]!.id,
								set: { name: 'Self edit while pending' }
							}
						],
						requester
					)).outcome
				).toMatchObject({ kind: 'refused', code: 'locked' });
				yield* f.t.db.write({
					text: 'UPDATE sys_user SET admin=true WHERE id=$1',
					params: [id]
				});
				const admin = compileAuthority(
					manifest,
					{
						actor: { ...member(id, 'requesters'), admin: true },
						policies: ['requester'],
						admin: true
					},
					`${id}:admin`
				);
				const preview = { ...f.manager, preview: { by: id, team: null } };
				const approvals = yield* Approvals;
				// the requester's own identity is offered withdraw alone; a previewer nothing
				for (const [auth, moves] of [
					[admin, [WITHDRAW]],
					[preview, []]
				] as const) {
					expect(yield* f.decide(requestId, 'approve', auth, 'Override')).toMatchObject({
						kind: 'refused',
						code: 'forbidden'
					});
					expect(
						Option.getOrThrow(yield* approvals.view(requestId, auth, () => Effect.succeed(true)))
							.moves
					).toEqual(moves);
				}
				const [open] = yield* f.t.db.read([openRequests]);
				expect(inboxRequests(open?.rows ?? [], admin)).toContainEqual(
					expect.objectContaining({
						id: requestId,
						mine: true,
						canDecide: false,
						canSupersede: false,
						moves: [WITHDRAW]
					})
				);
				expect(yield* f.request(requestId)).toMatchObject({ state: 'Pending', step: 0 });
				for (const record of submitted.records)
					expect(Option.getOrThrow(yield* f.row(record.id)).amount).toBe(50);
				expect(yield* f.decide(requestId, 'approve')).toMatchObject({
					kind: 'decided',
					status: 'Approved'
				});
				const updated = (yield* f.act(
					'update',
					submitted.records.map((record) => ({
						target: record.id,
						set: { amount: 60 }
					})),
					requester
				)).outcome;
				if (updated.kind !== 'pendingApproval') throw new Error(JSON.stringify(updated));
				expect(yield* f.decide(updated.requestId, 'approve', admin, 'Self override')).toMatchObject(
					{
						kind: 'refused',
						code: 'forbidden'
					}
				);
				for (const record of updated.records)
					expect(Option.getOrThrow(yield* f.row(record.id)).amount).toBe(60);
				expect(yield* f.decide(updated.requestId, 'approve')).toMatchObject({
					kind: 'decided',
					status: 'Approved'
				});
			})
	);
	it.effect('prevents self-review after the requester joins a later reviewing team', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const id = randomUUID();
			yield* f.t.db.write({
				text: "INSERT INTO sys_user (id,name,kind,team) VALUES ($1,'Team requester','staff','requesters')",
				params: [id]
			});
			const requester = compileAuthority(
				manifest,
				{
					actor: member(id, 'requesters'),
					policies: ['requester'],
					admin: false
				},
				id
			);
			const submitted = (yield* f.act(
				'create',
				[{ name: 'Team review', amount: 150, manager: managerId }],
				requester
			)).outcome;
			if (submitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(submitted));
			yield* f.decide(submitted.requestId, 'approve');
			yield* f.t.db.write({
				text: "UPDATE sys_user SET team='finance' WHERE id=$1",
				params: [id]
			});
			expect(yield* f.decide(submitted.requestId, 'approve', requester)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.requestId)).toMatchObject({ state: 'Pending', step: 1 });
			expect(yield* f.decide(submitted.requestId, 'approve', f.finance)).toMatchObject({
				kind: 'decided',
				status: 'Approved'
			});
		})
	);
	it.effect('prevents self-review by a member who submitted through a linked envoy', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const envoy = compileAuthority(
				manifest,
				{
					actor: {
						kind: 'envoy',
						envoy: 'desk',
						instance: 'chat',
						sender: randomUUID(),
						member: managerId
					},
					policies: ['requester'],
					admin: false
				},
				randomUUID()
			);
			const submitted = (yield* f.act(
				'create',
				[
					{ name: 'Envoy review', amount: 50, manager: managerId },
					{ name: 'Other reviewer', amount: 50, manager: financeId }
				],
				envoy
			)).outcome;
			if (submitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(submitted));
			expect(yield* f.decide(submitted.requestId, 'approve', f.manager)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.requestId)).toMatchObject({ state: 'Pending' });
			expect(yield* f.decide(submitted.requestId, 'approve', f.finance)).toMatchObject({
				kind: 'decided',
				status: 'Approved'
			});
		})
	);
	it.effect(
		'a created record resubmits though its row holds columns the requester was never granted',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const proposed = (yield* f.act('create', [
					{ name: 'New expense', amount: 80, manager: managerId }
				])).outcome;
				if (proposed.kind !== 'pendingApproval') throw new Error(JSON.stringify(proposed));
				const id = proposed.records[0]?.id;
				if (id === undefined) throw new Error('Missing expense');
				yield* f.decide(proposed.requestId, 'requestChanges', f.manager, 'The receipt shows 60');
				// `cost_centre` is a create column the requester's policy does not hold; it is empty on the stored row
				const resubmitted = (yield* f.act('update', [{ target: id, set: { amount: 60 } }])).outcome;
				expect(resubmitted).toMatchObject({
					kind: 'pendingApproval',
					requestId: proposed.requestId
				});
				expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(60);
			})
	);
	it.effect('keeps resubmission pending even when the requester now has direct permission', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const created = (yield* f.act(
				'create',
				[{ name: 'Revised expense', amount: 50, manager: managerId }],
				f.t.as(f.t.admin).authority
			)).outcome;
			if (created.kind !== 'committed') throw new Error(JSON.stringify(created));
			const id = created.records[0]?.id;
			if (id === undefined) throw new Error('Missing expense');
			const proposed = (yield* f.act('update', [{ target: id, set: { amount: 150 } }])).outcome;
			if (proposed.kind !== 'pendingApproval') throw new Error(JSON.stringify(proposed));
			yield* f.decide(
				proposed.requestId,
				'requestChanges',
				f.manager,
				'Restore the original amount'
			);
			const resubmitted = (yield* f.act('update', [{ target: id, set: { amount: 50 } }])).outcome;
			if (resubmitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(resubmitted));
			expect(resubmitted).toMatchObject({ kind: 'pendingApproval', requestId: proposed.requestId });
			expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
			expect(yield* f.request(proposed.requestId)).toMatchObject({ state: 'Pending', step: 0 });
			expect(yield* f.decide(proposed.requestId, 'approve', f.requester)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.decide(proposed.requestId, 'approve')).toMatchObject({
				kind: 'decided',
				status: 'Pending'
			});
			expect(yield* f.decide(proposed.requestId, 'approve', f.finance)).toMatchObject({
				kind: 'decided',
				status: 'Approved'
			});
		})
	);
	it.effect('CEL labels agree between the client and native approval snapshot expressions', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const row = { code: 'Q7', name: 'Acme', missing: null, count: 3 };
			for (const expression of [
				"record.code + ' · ' + record.name",
				'record.missing != null ? record.missing : record.name',
				"has(record.missing) ? 'present' : 'absent'",
				"has(record.absent) ? 'present' : 'absent'",
				"has(record.missing.child) ? 'present' : 'absent'",
				"record.missing ? 'Yes' : 'No'",
				"[record.code, record.missing, record.name].filter(x, x != null).map(x, x.upperAscii()).join(' · ')",
				"{'Q7': 'Quote seven'}[record.code]",
				"record.code in ['Q7', 'Q8'] ? 'Quote' : 'Other'",
				'string(3 / 2)',
				'string((3 + 1) / 3)',
				'string([record.code, record.name].size())',
				'string(1 / 0)'
			]) {
				const program = labelExpression(expression);
				if ('error' in program) throw new Error(program.error);
				const sql = program.sql(
					(path) =>
						`($1::jsonb #> ARRAY[${path
							.split('.')
							.map((part) => `'${part.replaceAll("'", "''")}'`)
							.join(', ')}])`
				);
				const snapshot = yield* f.t.db.value(Schema.NullOr(Schema.String), {
					text: `SELECT (${sql} #>> '{}')`,
					params: program.paths.length === 0 ? [] : [JSON.stringify(row)]
				});
				expect(snapshot, expression).toBe(label(row, expression));
			}
		})
	);
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
					expect(yield* f.search('Travel Manager')).toContainEqual({
						id: result.outcome.requestId,
						collection_name: 'expenses',
						$label: 'TRAVEL · Manager'
					});
					expect(yield* f.search(id)).toEqual([]);
					expect(yield* f.search('150')).not.toContainEqual(
						expect.objectContaining({ id: result.outcome.requestId })
					);
					expect(yield* f.request(result.outcome.requestId)).toMatchObject({
						state: 'Pending',
						step: 0,
						route: {
							steps: [
								{ name: 'Manager', users: [], teams: ['managers'] },
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
					expect(yield* f.search('Clarified Manager')).toContainEqual({
						id: requestId,
						collection_name: 'expenses',
						$label: 'CLARIFIED · Manager'
					});
					expect(yield* f.request(requestId)).toMatchObject({ state: 'Pending', step: 1 });
					yield* f.decide(requestId, 'requestChanges', f.finance, 'Reduce');
					yield* f.act('update', [{ target: id, set: { amount: 50 } }]);
					expect(yield* f.request(requestId)).toMatchObject({
						state: 'Pending',
						step: 0,
						route: { steps: [{ name: 'Manager', users: [], teams: ['managers'] }] }
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
	it.effect(
		'the requester withdraws a pending create: the record is removed and the request closes as withdrawn',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture,
					approvals = yield* Approvals;
				const submitted = (yield* f.act('create', [
					{ name: 'Withdrawn trip', amount: 50, manager: managerId }
				])).outcome;
				if (submitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(submitted));
				const requestId = submitted.requestId,
					id = submitted.records[0]!.id;
				const view = (authority: Authority) =>
					approvals
						.view(requestId, authority, () => Effect.succeed(true))
						.pipe(Effect.map(Option.getOrThrow));
				// the requester alone is offered it
				expect((yield* view(f.requester)).moves).toEqual([WITHDRAW]);
				expect((yield* view(f.manager)).moves.map((move) => move.decision)).not.toContain(
					'withdraw'
				);
				expect(yield* f.decide(requestId, 'withdraw', f.manager)).toMatchObject({
					kind: 'refused',
					code: 'forbidden',
					message: 'Only the requester may withdraw.'
				});
				expect(Option.isSome(yield* f.row(id))).toBe(true);
				expect(yield* f.decide(requestId, 'withdraw', f.requester)).toMatchObject({
					kind: 'decided',
					status: 'Withdrawn'
				});
				expect(Option.isNone(yield* f.row(id))).toBe(true);
				const closed = yield* view(f.requester);
				expect(closed).toMatchObject({ status: 'Withdrawn', moves: [] });
				expect(closed.log.at(-1)).toMatchObject({
					move: 'withdraw',
					by: { ref: `member:${requesterId}`, name: 'Requester' },
					from: 'Pending',
					to: 'Withdrawn',
					reason: null,
					rolledBack: [{ model: 'expenses', id, action: 'removed' }]
				});
				expect(yield* f.face(requestId)).toEqual({
					status: 'WITHDRAWN',
					closed_by: `member:${requesterId}`
				});
				expect((yield* f.notices()).map((n) => n.title)).toContain('approval:withdraw');
				// closed: nobody decides it again, and withdrawing it again changes nothing
				expect(yield* f.decide(requestId, 'approve')).toMatchObject({ kind: 'refused' });
				expect(yield* f.decide(requestId, 'withdraw', f.requester)).toMatchObject({
					kind: 'decided',
					status: 'Withdrawn'
				});
				expect((yield* view(f.requester)).log.filter((e) => e.move === 'withdraw')).toHaveLength(1);
			})
	);
	it.effect(
		'the requester withdraws a pending update back to its checkpoint, also after changes were requested',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const created = (yield* f.act('create', [
					{ name: 'Standing', amount: 50, manager: managerId }
				])).outcome;
				if (created.kind !== 'pendingApproval') throw new Error(JSON.stringify(created));
				const id = created.records[0]!.id;
				yield* f.decide(created.requestId, 'approve');
				for (const changes of [false, true]) {
					const updated = (yield* f.act('update', [{ target: id, set: { amount: 80 } }])).outcome;
					if (updated.kind !== 'pendingApproval') throw new Error(JSON.stringify(updated));
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(80);
					if (changes) yield* f.decide(updated.requestId, 'requestChanges', f.manager, 'Why?');
					expect(
						yield* f.decide(updated.requestId, 'withdraw', f.requester, 'No longer needed')
					).toMatchObject({ kind: 'decided', status: 'Withdrawn' });
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
					expect(yield* f.face(updated.requestId)).toMatchObject({ status: 'WITHDRAWN' });
				}
				// the record is free again: the next change opens a fresh request
				const again = (yield* f.act('update', [{ target: id, set: { amount: 90 } }])).outcome;
				expect(again).toMatchObject({ kind: 'pendingApproval' });
			})
	);
	it.effect('the requester cannot withdraw a request that was already decided', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const decision of ['approve', 'reject'] as const) {
				const submitted = (yield* f.act('create', [
					{ name: `Decided ${decision}`, amount: 50, manager: managerId }
				])).outcome;
				if (submitted.kind !== 'pendingApproval') throw new Error(JSON.stringify(submitted));
				const decided = yield* f.decide(submitted.requestId, decision, f.manager, 'Decided');
				if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
				expect(yield* f.decide(submitted.requestId, 'withdraw', f.requester)).toMatchObject({
					kind: 'refused',
					code: 'invalidInput',
					message: `This request is ${decided.status}; it no longer changes.`
				});
				expect(Option.isSome(yield* f.row(submitted.records[0]!.id))).toBe(decision === 'approve');
			}
		})
	);
	it.effect(
		'any run of the automation that asked withdraws its request; an automation decides nothing else',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const run = (automation: string, id = randomUUID()): Authority =>
					compileAuthority(
						manifest,
						{
							actor: { kind: 'system', run: id, by: { automation } },
							policies: ['requester'],
							admin: false
						},
						id
					);
				const raised = (yield* f.act(
					'create',
					[{ name: 'Cash out', amount: 50, manager: managerId }],
					run('offboard')
				)).outcome;
				if (raised.kind !== 'pendingApproval') throw new Error(JSON.stringify(raised));
				const id = raised.records[0]!.id;
				expect(yield* f.decide(raised.requestId, 'withdraw', run('payroll'))).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				for (const decision of ['approve', 'reject', 'requestChanges'] as const)
					expect(
						yield* f.decide(raised.requestId, decision, run('offboard'), 'Automated')
					).toMatchObject({
						kind: 'refused',
						code: 'forbidden',
						message: 'Only a member may decide an approval.'
					});
				expect(Option.isSome(yield* f.row(id))).toBe(true);
				// a later run of the same automation: the cause disappeared
				const later = run('offboard');
				expect(
					yield* f.decide(raised.requestId, 'withdraw', later, 'The employee stays')
				).toMatchObject({ kind: 'decided', status: 'Withdrawn' });
				expect(Option.isNone(yield* f.row(id))).toBe(true);
				expect(yield* f.face(raised.requestId)).toMatchObject({ status: 'WITHDRAWN' });

				// a person's request is never an automation's to withdraw
				const personal = (yield* f.act('create', [
					{ name: 'Personal', amount: 50, manager: managerId }
				])).outcome;
				if (personal.kind !== 'pendingApproval') throw new Error(JSON.stringify(personal));
				expect(yield* f.decide(personal.requestId, 'withdraw', later)).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* f.request(personal.requestId)).toMatchObject({ state: 'Pending' });
			})
	);
});

const { record_label: _recordLabel, ...unlabelledExpenses } = manifest.models.expenses!;
const unlabelled = { ...manifest, models: { ...manifest.models, expenses: unlabelledExpenses } };
layer(
	Layer.unwrap(
		program(source).pipe(
			Effect.map((guest) => TestWorkspace.layer({ manifest: unlabelled, guest }))
		)
	),
	{ excludeTestServices: true }
)('approvals without a record label', (it) => {
	it.effect('uses model-name search without creating a copied label field', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const result = (yield* f.act('create', [{ name: 'Travel', amount: 150, manager: managerId }]))
				.outcome;
			if (result.kind !== 'pendingApproval') throw new Error(JSON.stringify(result));
			expect(yield* f.search('expenses')).toContainEqual({
				id: result.requestId,
				collection_name: 'expenses',
				$label: result.records[0]?.id
			});
			expect(yield* f.search('Travel')).toEqual([]);
		})
	);
});
