import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { prune_history } from '../src/engine/query/history.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { Files } from '../src/engine/ports.ts';
import { storeFile } from '../src/engine/facilities.ts';
import { NativeReadRow, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import { label, label_expression } from '@norbital-ai/store/label';
import { inboxRequests, inboxSql } from '../src/engine/approvals/inbox.ts';

const required = <A>(value: A | undefined): A => {
 if (value === undefined) throw new Error('Missing approval fixture value.');
 return value;
};
const ApprovalSearch = Schema.Struct({
	approval_request: Schema.Struct({
		rows: Schema.Array(
			Schema.StructWithRest(
				Schema.Struct({ ...NativeReadRow.schema.fields, collection_name: Schema.String }),
				NativeReadRow.records
			)
		)
	})
});
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
				receipt: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true },
				// declared for create, granted to nobody below: a stored row carries it empty
				cost_centre: { kind: 'text', optional: true }
			},
			computed: { display_name: { kind: 'text', expr: { upper: { field: 'name' } } } }
		},
		lines: {
			description: 'Expense lines',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		}
	},
	relationships: {
		'lines.expense': { to: 'expenses', inverse: 'lines', owned: true },
		'expenses.manager': { to: 'sys_user' }
	},
	exposures: {
		expenses: {
			outputs: { default: { expenses: { fields: 'all' } } },
			create: {
				columns: {
					expenses: ['name', 'amount', 'manager', 'receipt', 'cost_centre'],
					'expenses.lines': ['name']
				},
				transform: true, effect: true
			},
			update: {
				columns: { expenses: ['name', 'amount', 'manager', 'receipt'], 'expenses.lines': ['name'] },
				transform: true, effect: true
			},
			delete: { effect: true }
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
				sys_user: { outputs: { default: {} } },
				expenses: {
					outputs: { default: {} },
					create: {
						columns: { expenses: ['name', 'amount', 'manager', 'receipt'], 'expenses.lines': ['name'] },
						verdict: true
					},
					update: { verdict: true }
				}
			}
		},
		reviewer: {
			description: 'Reviews',
			grants: {
				expenses: { outputs: { default: {} } },
				approval_request: { outputs: { default: {} } }
			}
		}
	},
	teams: { requesters: { policies: ['requester'] }, managers: { policies: ['reviewer'] }, finance: { policies: ['reviewer'] } }
};
const source = `const managerStep = (ids) => ({
	name: 'Manager',
	teams: [...new Set(ids.map((id) =>
		id === '${managerId}' ? 'managers' : id === '${financeId}' ? 'finance' : 'requesters'
	))]
});
const financeStep = { name: 'Finance', teams: ['finance'] };
export default { model: { expenses: { bodies: {
	create: function* (changes) { return changes.map(({set}) => ({...set,name:set.name.trim()})); },
	update: function* (changes) { return changes.map(({set,after}) => ({...set,name:after.name.trim()})); },
	effect: {
        create: function*(_changes,ctx){ yield* ctx.notify({title:ctx.event.kind+':'+(ctx.event.move ?? 'create'),to:[{user:'${managerId}'}]}); },
        update: function*(_changes,ctx){ yield* ctx.notify({title:ctx.event.kind+':'+(ctx.event.move ?? 'update'),to:[{user:'${managerId}'}]}); },
        delete: function*(_changes,ctx){ yield* ctx.notify({title:ctx.event.kind+':'+(ctx.event.move ?? 'delete'),to:[{user:'${managerId}'}]}); }
    }
} } }, policy: { requester: { grants: { expenses: {
	create: { verdict: function* (changes, ctx) {
        const rows = changes.map(({after}) => after);
		return ctx.approve({
			steps: [
				managerStep(rows.map((row) => row.manager)),
				...(rows.some((row) => Number(row.amount) >= 100) ? [financeStep] : [])
			],
			...(rows.some((row) => row.name === 'Override by team') ? { superseded_by: ['finance'] } : {})
		});
	} },
	update: { verdict: function* (changes, ctx) {
		if (!changes.every(({ before }) => typeof before.amount === 'string')) throw new Error('The stored amount must be decimal text');
        if (changes.some(({ before, after, set }) => before.name === 'Checkpoint tree' && (before.lines[0]?.name !== 'Original' || !['Proposed', 'Revised'].includes(after.lines[0]?.name) || !set.lines))) throw new Error('Resubmission must retain the original child checkpoint and final proposal.');
		const material = changes.filter(({ set }) => set.amount !== undefined || set.lines !== undefined || set.receipt !== undefined);
		return material.length === 0 ? ctx.allow() : ctx.approve({
			steps: [
				managerStep(material.map(({ after }) => after.manager)),
				...(material.some(({ after }) => Number(after.amount) >= 100)
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
	team_path: [team],
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
		approvals = yield* Approvals;
	yield* t.db.write({
		text: "INSERT INTO sys_user (id,name,kind,team) VALUES ($1,'Requester','staff','requesters'),($2,'Manager','staff','managers'),($3,'Finance','staff','finance') ON CONFLICT (id) DO NOTHING",
		params: [requesterId, managerId, financeId]
	});
	const as = (id: string, team: string, policies: readonly string[]) =>
		compile_authority(manifest, { actor: member(id, team), policies, admin: false }, id);
	const requester = yield* as(requesterId, 'requesters', ['requester']),
		manager = yield* as(managerId, 'managers', ['reviewer']),
		finance = yield* as(financeId, 'finance', ['reviewer']);
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
		request_id: string,
		decision: 'approve' | 'reject' | 'request_changes' | 'withdraw',
		authority = manager,
		reason?: string
	) =>
		approvals.decide({
			request_id,
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
		t.as(authority).pipe(
				Effect.flatMap((caller) =>
					caller.query(
						dynamic_read({
							approval_request: { search: query, fields: ['collection_name'], limit: 20 }
						})
					)
				),
				Effect.flatMap(Schema.decodeUnknownEffect(ApprovalSearch)),
				Effect.map((answer) => answer.approval_request.rows)
			);
	const notices = () =>
		Effect.gen(function* () {
			yield* t.run_due();
			return yield* t.db.rows(Schema.Struct({ title: Schema.String }), {
				text: "SELECT title FROM sys_notification WHERE title LIKE 'approval:%' OR title LIKE 'write:%' ORDER BY id",
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
			if (created.kind !== 'pending_approval') throw new Error(JSON.stringify(created));
			const id = created.records[0]?.id;
			if (id === undefined) throw new Error('Missing expense');
			expect(yield* f.decide(created.request_id, 'approve')).toMatchObject({ status: 'Approved' });
			const proposed = (yield* f.act('update', [{ target: id, set: { receipt: nextFile } }]))
				.outcome;
			if (proposed.kind !== 'pending_approval') throw new Error(JSON.stringify(proposed));
			const stored = () =>
				f.t.db.one(Schema.Struct({ id: Schema.String, key: Schema.String }), {
					text: "SELECT f.id,f.key FROM expenses e JOIN sys_file f ON f.id=e.receipt->>'id' WHERE e.id=$1",
					params: [id]
				});
			expect(Option.getOrThrow(yield* stored()).id).toBe(nextFile.id);
			expect(
				yield* f.decide(proposed.request_id, 'reject', f.manager, 'Restore original receipt')
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
			const previous = yield* compile_authority(
				manifest,
				{ actor: member(id, 'finance'), policies: ['reviewer'], admin: false },
				id
			);
			const submitted = (yield* f.act('create', [
				{ name: 'Team snapshot', amount: 150, manager: managerId }
			])).outcome;
			if (submitted.kind !== 'pending_approval') throw new Error('Missing approval');
			yield* f.decide(submitted.request_id, 'approve');
			const waiting = yield* f.request(submitted.request_id);
			yield* f.t.db.write({
				text: "UPDATE sys_user SET team = 'managers' WHERE id = $1",
				params: [id]
			});
			expect(yield* f.decide(submitted.request_id, 'approve', previous)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.request_id)).toEqual(waiting);
		})
	);
	it.effect('rejecting requested changes immediately restores the checkpoint', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const original = (yield* f.act(
				'create',
				[{ name: 'Original', amount: 25, manager: managerId }],
				(yield* f.t.as(f.t.admin)).authority
			)).outcome;
			const id = original.kind === 'committed' ? original.records[0]?.id : undefined;
			if (id === undefined) throw new Error('Missing original row');
			const submitted = (yield* f.act('update', [{ target: id, set: { amount: 50 } }])).outcome;
			if (submitted.kind !== 'pending_approval') throw new Error('Missing approval');
			expect(
				yield* f.decide(submitted.request_id, 'request_changes', f.manager, 'Please review')
			).toMatchObject({ kind: 'decided', status: 'ChangesRequested' });
			expect(
				yield* f.decide(submitted.request_id, 'reject', f.manager, 'Restore original')
			).toMatchObject({ kind: 'decided', status: 'Rejected' });
			expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(25);
		})
	);
	it.effect('administrators and named superseder teams can close a request with a reason', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const [name, actor] of [
				['Override by admin', (yield* f.t.as(f.t.admin)).authority],
				['Override by team', f.finance]
			] as const) {
				const submitted = (yield* f.act('create', [{ name, amount: 50, manager: managerId }]))
					.outcome;
				if (submitted.kind !== 'pending_approval') throw new Error('Missing approval');
				expect(yield* f.decide(submitted.request_id, 'approve', actor)).toMatchObject({
					kind: 'refused'
				});
				expect(
					yield* f.decide(submitted.request_id, 'approve', actor, 'Override authorised')
				).toMatchObject({ kind: 'decided', status: 'Superseded' });
				expect(yield* f.request(submitted.request_id)).toMatchObject({ state: 'Superseded' });
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
				const requester = yield* compile_authority(
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
				if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
				const request_id = submitted.request_id;
				expect(yield* f.decide(request_id, 'approve', requester)).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(
					(yield* f.act(
						'update',
						[
							{
								target: required(submitted.records[0]).id,
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
				const admin = yield* compile_authority(
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
					expect(yield* f.decide(request_id, 'approve', auth, 'Override')).toMatchObject({
						kind: 'refused',
						code: 'forbidden'
					});
					expect(
						Option.getOrThrow(yield* approvals.view(request_id, auth, () => Effect.succeed(true)))
							.moves
					).toEqual(moves);
				}
				const [open] = yield* f.t.db.read([inboxSql(admin)]);
				expect(inboxRequests(open?.rows ?? [], admin)).toContainEqual(
					expect.objectContaining({
						id: request_id,
						mine: true,
						canDecide: false,
						canSupersede: false,
						moves: [WITHDRAW]
					})
				);
				expect(yield* f.request(request_id)).toMatchObject({ state: 'Pending', step: 0 });
				for (const record of submitted.records)
					expect(Option.getOrThrow(yield* f.row(record.id)).amount).toBe(50);
				expect(yield* f.decide(request_id, 'approve')).toMatchObject({
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
				if (updated.kind !== 'pending_approval') throw new Error(JSON.stringify(updated));
				expect(yield* f.decide(updated.request_id, 'approve', admin, 'Self override')).toMatchObject(
					{
						kind: 'refused',
						code: 'forbidden'
					}
				);
				for (const record of updated.records)
					expect(Option.getOrThrow(yield* f.row(record.id)).amount).toBe(60);
				expect(yield* f.decide(updated.request_id, 'approve')).toMatchObject({
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
			const requester = yield* compile_authority(
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
			if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
			yield* f.decide(submitted.request_id, 'approve');
			yield* f.t.db.write({
				text: "UPDATE sys_user SET team='finance' WHERE id=$1",
				params: [id]
			});
			expect(yield* f.decide(submitted.request_id, 'approve', requester)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.request_id)).toMatchObject({ state: 'Pending', step: 1 });
			expect(yield* f.decide(submitted.request_id, 'approve', f.finance)).toMatchObject({
				kind: 'decided',
				status: 'Approved'
			});
		})
	);
	it.effect('prevents self-review by a member who submitted through a linked envoy', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const envoy = yield* compile_authority(
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
			if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
			expect(yield* f.decide(submitted.request_id, 'approve', f.manager)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.request(submitted.request_id)).toMatchObject({ state: 'Pending' });
			expect(yield* f.decide(submitted.request_id, 'approve', f.finance)).toMatchObject({
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
				if (proposed.kind !== 'pending_approval') throw new Error(JSON.stringify(proposed));
				const id = proposed.records[0]?.id;
				if (id === undefined) throw new Error('Missing expense');
				yield* f.decide(proposed.request_id, 'request_changes', f.manager, 'The receipt shows 60');
				// `cost_centre` is a create column the requester's policy does not hold; it is empty on the stored row
				const resubmitted = (yield* f.act('update', [{ target: id, set: { amount: 60 } }])).outcome;
				expect(resubmitted).toMatchObject({
					kind: 'pending_approval',
					request_id: proposed.request_id
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
				(yield* f.t.as(f.t.admin)).authority
			)).outcome;
			if (created.kind !== 'committed') throw new Error(JSON.stringify(created));
			const id = created.records[0]?.id;
			if (id === undefined) throw new Error('Missing expense');
			const proposed = (yield* f.act('update', [{ target: id, set: { amount: 150 } }])).outcome;
			if (proposed.kind !== 'pending_approval') throw new Error(JSON.stringify(proposed));
			yield* f.decide(
				proposed.request_id,
				'request_changes',
				f.manager,
				'Restore the original amount'
			);
			const resubmitted = (yield* f.act('update', [{ target: id, set: { amount: 50 } }])).outcome;
			if (resubmitted.kind !== 'pending_approval') throw new Error(JSON.stringify(resubmitted));
			expect(resubmitted).toMatchObject({
				kind: 'pending_approval',
				request_id: proposed.request_id
			});
			expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
			expect(yield* f.request(proposed.request_id)).toMatchObject({ state: 'Pending', step: 0 });
			expect(yield* f.decide(proposed.request_id, 'approve', f.requester)).toMatchObject({
				kind: 'refused',
				code: 'forbidden'
			});
			expect(yield* f.decide(proposed.request_id, 'approve')).toMatchObject({
				kind: 'decided',
				status: 'Pending'
			});
			expect(yield* f.decide(proposed.request_id, 'approve', f.finance)).toMatchObject({
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
				const program = label_expression(expression);
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
						(yield* f.t.as(f.t.admin)).authority
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
					if (proposed.kind !== 'pending_approval') throw new Error('Missing approval');
					yield* f.decide(proposed.request_id, 'request_changes', f.manager, 'Clarify');
					yield* prune_history(f.t.db, 1);
					expect(yield* checkpoint()).toBe(1);
					expect(
						(yield* f.act('update', [{ target: id, set: { amount: 151 } }])).outcome
					).toMatchObject({ kind: 'pending_approval', request_id: proposed.request_id });
					yield* prune_history(f.t.db, 1);
					expect(yield* checkpoint()).toBe(1);
					expect(
						yield* f.decide(proposed.request_id, 'reject', f.manager, 'Restore the checkpoint')
					).toMatchObject({ kind: 'decided', status: 'Rejected' });
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
					expect(yield* prune_history(f.t.db, 1)).toBeGreaterThan(0);
					expect(yield* checkpoint()).toBe(0);
					const again = (yield* f.act('update', [{ target: id, set: { amount: 160 } }])).outcome;
					if (again.kind !== 'pending_approval') throw new Error('Missing second approval');
					// Reproduce unavailable history without weakening the production pruning path.
					yield* f.t.db.write({
						text: "DELETE FROM bolt_history WHERE collection='expenses' AND record=$1::uuid",
						params: [id]
					});
					expect(yield* f.decide(again.request_id, 'reject', f.manager, 'Restore')).toMatchObject({
						kind: 'refused'
					});
					expect(yield* f.request(again.request_id)).toMatchObject({ state: 'Pending' });
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
					if (result.outcome.kind !== 'pending_approval')
						throw new Error(JSON.stringify(result.outcome));
					const id = result.outcome.records[0]?.id;
					if (id === undefined) throw new Error('Missing expense');
					expect(Option.getOrThrow(yield* f.row(id)).name).toBe('Travel');
					expect(yield* f.search('Travel Manager')).toContainEqual({
						id: result.outcome.request_id,
						collection_name: 'expenses',
						$label: 'TRAVEL · Manager'
					});
					expect(yield* f.search(id)).toEqual([]);
					expect(yield* f.search('150')).not.toContainEqual(
						expect.objectContaining({ id: result.outcome.request_id })
					);
					expect(yield* f.request(result.outcome.request_id)).toMatchObject({
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
					expect(yield* f.decide(result.outcome.request_id, 'reject')).toMatchObject({
						kind: 'refused'
					});
					expect(yield* f.decide(result.outcome.request_id, 'approve', f.finance)).toMatchObject({
						kind: 'refused',
						code: 'forbidden'
					});
					expect(yield* f.decide(result.outcome.request_id, 'approve')).toMatchObject({
						kind: 'decided',
						status: 'Pending'
					});
					expect(yield* f.decide(result.outcome.request_id, 'approve', f.finance)).toMatchObject({
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
					if (created.outcome.kind !== 'pending_approval')
						throw new Error(JSON.stringify(created.outcome));
					const id = created.outcome.records[0]?.id,
						request_id = created.outcome.request_id;
					if (id === undefined) throw new Error('Missing expense');
					yield* f.decide(request_id, 'approve');
					yield* f.decide(request_id, 'request_changes', f.finance, 'Clarify');
					expect(
						(yield* f.act('update', [{ target: id, set: { name: '  Clarified  ' } }])).outcome
					).toMatchObject({ kind: 'pending_approval', request_id });
					expect(Option.getOrThrow(yield* f.row(id)).name).toBe('Clarified');
					expect(yield* f.search('Clarified Manager')).toContainEqual({
						id: request_id,
						collection_name: 'expenses',
						$label: 'CLARIFIED · Manager'
					});
					expect(yield* f.request(request_id)).toMatchObject({ state: 'Pending', step: 1 });
					yield* f.decide(request_id, 'request_changes', f.finance, 'Reduce');
					yield* f.act('update', [{ target: id, set: { amount: 50 } }]);
					expect(yield* f.request(request_id)).toMatchObject({
						state: 'Pending',
						step: 0,
						route: { steps: [{ name: 'Manager', users: [], teams: ['managers'] }] }
					});
					expect((yield* f.notices()).map((n) => n.title)).toContain('approval:resubmit');
				})
			)
	);
	it.effect('resubmission compares nested final values with the original child checkpoint', () =>
  Effect.scoped(Effect.gen(function* () {
   const f = yield* fixture;
   const made = (yield* f.act('create', [{ name: 'Checkpoint tree', amount: 50, manager: managerId, lines: [{ name: 'Original' }] }], (yield* f.t.as(f.t.admin)).authority)).outcome;
   if (made.kind !== 'committed') throw new Error('The baseline must commit.');
   const root = made.records.find(({model}) => model === 'expenses'), child = made.records.find(({model}) => model === 'lines');
   if (root === undefined || child === undefined) throw new Error('Both baseline records are required.');
   const propose = (name: string) => f.act('update', [{ target: root.id, set: { lines: { update: [{ target: child.id, set: { name } }] } } }]);
   const pending = (yield* propose('Proposed')).outcome;
   if (pending.kind !== 'pending_approval') throw new Error('The nested edit must need review.');
   yield* f.decide(pending.request_id, 'request_changes', f.manager, 'Revise the line');
   expect((yield* propose('Revised')).outcome).toMatchObject({ kind: 'pending_approval', request_id: pending.request_id });
   expect(yield* f.t.db.value(Schema.String, {text:'SELECT name FROM lines WHERE id=$1',params:[child.id]})).toBe('Revised');
   expect(yield* f.decide(pending.request_id,'reject',f.manager,'Restore')).toMatchObject({status:'Rejected'});
   expect(yield* f.t.db.value(Schema.String, {text:'SELECT name FROM lines WHERE id=$1',params:[child.id]})).toBe('Original');
  }))
 );
 it.effect('a missing resubmission checkpoint conflicts while the proposal stays held', () =>
  Effect.scoped(Effect.gen(function* () {
   const f = yield* fixture;
   const made = (yield* f.act('create', [{name:'Missing tree checkpoint',amount:50,manager:managerId}], (yield* f.t.as(f.t.admin)).authority)).outcome;
   if(made.kind!=='committed')throw new Error('The baseline must commit.');
   const root=made.records.find(({model})=>model==='expenses');
   if(root===undefined)throw new Error('The baseline expense is required.');
   const pending=(yield* f.act('update',[{target:root.id,set:{amount:150}}])).outcome;
   if(pending.kind!=='pending_approval')throw new Error('The edit must need review.');
   yield* f.decide(pending.request_id,'request_changes',f.manager,'Clarify');
   yield* f.t.db.write({text:"DELETE FROM bolt_history WHERE collection='expenses' AND record=$1",params:[root.id]});
   expect((yield* f.act('update',[{target:root.id,set:{amount:151}}])).outcome).toMatchObject({kind:'conflict'});
   expect(yield* f.request(pending.request_id)).toMatchObject({state:'ChangesRequested'});
   expect(Option.getOrThrow(yield* f.row(root.id)).amount).toBe(150);
  }))
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
					(yield* f.t.as(f.t.admin)).authority
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
				if (proposed.kind !== 'pending_approval') throw new Error(JSON.stringify(proposed));
				const request_id = proposed.request_id;
				// relationship actions stay authored until this request resolves
				const set = { lines: { update: [{ target: line, set: { name: 'First' } }] } };
				expect(
					yield* f.decide(request_id, 'request_changes', f.manager, 'Clarify the line')
				).toMatchObject({ kind: 'decided', status: 'ChangesRequested' });
				expect((yield* f.act('update', [{ target: id, set }])).outcome).toMatchObject({
					kind: 'pending_approval',
					request_id
				});
				expect(yield* f.request(request_id)).toMatchObject({ state: 'Pending' });
				expect(
					yield* f.t.db.value(Schema.Int, {
						text: 'SELECT revision FROM expenses WHERE id=$1::uuid',
						params: [id]
					})
				).toBe(revision);
				yield* f.decide(request_id, 'reject', f.manager, 'Restore the line');
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
				if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
				const request_id = submitted.request_id,
					id = required(submitted.records[0]).id;
				const view = (authority: Authority) =>
					approvals
						.view(request_id, authority, () => Effect.succeed(true))
						.pipe(Effect.map(Option.getOrThrow));
				// the requester alone is offered it
				expect((yield* view(f.requester)).moves).toEqual([WITHDRAW]);
				expect((yield* view(f.manager)).moves.map((move) => move.decision)).not.toContain(
					'withdraw'
				);
				expect(yield* f.decide(request_id, 'withdraw', f.manager)).toMatchObject({
					kind: 'refused',
					code: 'forbidden',
					message: 'Only the requester may withdraw.'
				});
				expect(Option.isSome(yield* f.row(id))).toBe(true);
				expect(yield* f.decide(request_id, 'withdraw', f.requester)).toMatchObject({
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
					rolled_back: [{ model: 'expenses', id, action: 'removed' }]
				});
				expect(yield* f.face(request_id)).toEqual({
					status: 'WITHDRAWN',
					closed_by: `member:${requesterId}`
				});
				expect((yield* f.notices()).map((n) => n.title)).toContain('approval:withdraw');
				// closed: nobody decides it again, and withdrawing it again changes nothing
				expect(yield* f.decide(request_id, 'approve')).toMatchObject({ kind: 'refused' });
				expect(yield* f.decide(request_id, 'withdraw', f.requester)).toMatchObject({
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
				if (created.kind !== 'pending_approval') throw new Error(JSON.stringify(created));
				const id = required(created.records[0]).id;
				yield* f.decide(created.request_id, 'approve');
				for (const changes of [false, true]) {
					const updated = (yield* f.act('update', [{ target: id, set: { amount: 80 } }])).outcome;
					if (updated.kind !== 'pending_approval') throw new Error(JSON.stringify(updated));
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(80);
					if (changes) yield* f.decide(updated.request_id, 'request_changes', f.manager, 'Why?');
					expect(
						yield* f.decide(updated.request_id, 'withdraw', f.requester, 'No longer needed')
					).toMatchObject({ kind: 'decided', status: 'Withdrawn' });
					expect(Option.getOrThrow(yield* f.row(id)).amount).toBe(50);
					expect(yield* f.face(updated.request_id)).toMatchObject({ status: 'WITHDRAWN' });
				}
				// the record is free again: the next change opens a fresh request
				const again = (yield* f.act('update', [{ target: id, set: { amount: 90 } }])).outcome;
				expect(again).toMatchObject({ kind: 'pending_approval' });
			})
	);
	it.effect(
		'a rejected create keeps its label, stays in both inboxes and tells the requester why',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const submitted = (yield* f.act('create', [
					{ name: 'Taxi fare', amount: 50, manager: managerId }
				])).outcome;
				if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
				const pending = yield* f.t.db.read([inboxSql(f.manager)]);
				expect(inboxRequests(pending[0]?.rows ?? [], f.manager)).toContainEqual(
					expect.objectContaining({ id: submitted.request_id, label: 'TAXI FARE · Manager' })
				);
				expect(
					yield* f.decide(submitted.request_id, 'reject', f.manager, 'Duplicate claim')
				).toMatchObject({ kind: 'decided', status: 'Rejected' });
				for (const auth of [f.manager, f.requester]) {
					const [rows] = yield* f.t.db.read([inboxSql(auth)]);
					expect(inboxRequests(rows?.rows ?? [], auth)).toContainEqual(
						expect.objectContaining({
							id: submitted.request_id,
							status: 'Rejected',
							label: 'TAXI FARE · Manager',
							moves: []
						})
					);
				}
				const approvals = yield* Approvals;
				expect(
					Option.getOrThrow(
						yield* approvals.view(submitted.request_id, f.requester, () => Effect.succeed(false))
					).label
				).toBe('TAXI FARE · Manager');
				expect(
					yield* f.t.db.rows(Schema.Struct({ title: Schema.String, body: Schema.NullOr(Schema.String) }), {
						text: 'SELECT title, body FROM sys_notification WHERE member = $1',
						params: [requesterId]
					})
				).toContainEqual({ title: 'Rejected · TAXI FARE · Manager', body: 'Duplicate claim' });
			})
	);
	it.effect('the requester cannot withdraw a request that was already decided', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const decision of ['approve', 'reject'] as const) {
				const submitted = (yield* f.act('create', [
					{ name: `Decided ${decision}`, amount: 50, manager: managerId }
				])).outcome;
				if (submitted.kind !== 'pending_approval') throw new Error(JSON.stringify(submitted));
				const decided = yield* f.decide(submitted.request_id, decision, f.manager, 'Decided');
				if (decided.kind !== 'decided') throw new Error(JSON.stringify(decided));
				expect(yield* f.decide(submitted.request_id, 'withdraw', f.requester)).toMatchObject({
					kind: 'refused',
					code: 'invalid_input',
					message: `This request is ${decided.status}; it no longer changes.`
				});
				expect(Option.isSome(yield* f.row(required(submitted.records[0]).id))).toBe(decision === 'approve');
			}
		})
	);
	it.effect(
		'an automation decides nothing, not even withdrawing the request it raised',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const run = (automation: string, id = randomUUID()) =>
					compile_authority(
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
					yield* run('offboard')
				)).outcome;
				if (raised.kind !== 'pending_approval') throw new Error(JSON.stringify(raised));
				const id = required(raised.records[0]).id;
				for (const decision of ['approve', 'reject', 'request_changes', 'withdraw'] as const)
					expect(
						yield* f.decide(raised.request_id, decision, yield* run('offboard'), 'Automated')
					).toMatchObject({
						kind: 'refused',
						code: 'forbidden',
						message: 'Only a member may decide an approval.'
					});
				expect(Option.isSome(yield* f.row(id))).toBe(true);
				expect(yield* f.request(raised.request_id)).toMatchObject({ state: 'Pending' });
			})
	);
});

const { record_label: _recordLabel, ...unlabelledExpenses } = required(manifest.models.expenses);
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
			if (result.kind !== 'pending_approval') throw new Error(JSON.stringify(result));
			expect(yield* f.search('expenses')).toContainEqual({
				id: result.request_id,
				collection_name: 'expenses',
				$label: result.records[0]?.id
			});
			expect(yield* f.search('Travel')).toEqual([]);
		})
	);
});
