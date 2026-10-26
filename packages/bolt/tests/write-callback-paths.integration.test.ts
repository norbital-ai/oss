// These are real guest callbacks reached through each write entry, observed in committed data or a refusal.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Approvals, Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { routeFixture } from './support/route-fixture.ts';
import { manifest as base } from './write-fixture.ts';

const NOW = '2026-10-24T08:00:00.000Z';
const REQUESTER = '0199a000-0000-7000-8000-000000000001';
const REVIEWER = '0199a000-0000-7000-8000-000000000002';
const childColumns = { columns: ['name', 'trace'] };
const children = {
	create: childColumns,
	update: childColumns,
	delete: {},
	link: {},
	unlink: {}
};
const operation = {
	op: { kind: 'enum', values: ['create', 'update', 'delete'] },
	code: { kind: 'text', optional: true },
	name: { kind: 'text', optional: true },
	target: { kind: 'id', of: 'parents', optional: true }
} satisfies NonNullable<EngineManifest['automations'][string]['input']>;
const manifest: EngineManifest = {
	...base,
	models: {
		parents: {
			description: 'A parent',
			label: 'name',
			key: ['code'],
			fields: {
				code: { kind: 'text' },
				name: { kind: 'text' },
				trace: { kind: 'text', optional: true }
			}
		},
		children: {
			description: 'A child',
			label: 'name',
			fields: { name: { kind: 'text' }, trace: { kind: 'text', optional: true } }
		}
	},
	relationships: { 'children.parent': { to: 'parents', inverse: 'children', optional: true } },
	collections: {
		parents: {
			read: { fields: 'all' },
			create: {
				input: { columns: ['code', 'name', 'trace'], with: { children } },
				transform: true
			},
			update: {
				input: { columns: ['code', 'name', 'trace'], with: { children } },
				transform: true
			},
			delete: { check: true }
		},
		children: {
			read: { fields: 'all' },
			create: { input: { columns: ['name', 'trace', 'parent'] }, transform: true },
			update: { input: { columns: ['name', 'trace', 'parent'] }, transform: true },
			delete: { check: true }
		}
	},
	policies: {
		requester: {
			description: 'Requests a parent write',
			grants: { parents: { read: true, create: { approval: true }, update: { approval: true } } }
		},
		reviewer: { description: 'Reviews parents', grants: { parents: { read: true } } }
	},
	teams: { requesters: ['requester'], reviewers: ['reviewer'] },
	automations: {
		mutate: { description: 'Write through an automation', input: operation, runAs: 'trigger' }
	}
};
const source = `function* mutate(input, ctx) {
	const payload = input.op === 'create' ? { code: input.code, name: input.name }
		: input.op === 'update' ? { target: input.target, set: { name: input.name } }
		: { target: input.target };
	yield* ctx.act('parents.' + input.op, payload);
}
const create = (rows) => rows.map((row) => ({ ...row, name: row.name.trim(), trace: 'C' }));
const update = (changes) => changes.map(({ before, set }) => ({ ...set,
	...(set.name === undefined ? {} : { name: set.name.trim() }), trace: (before.trace ?? '') + 'U' }));
export default {
	collection: {
		parents: { bodies: {
			create: function* (rows) { return create(rows); },
			update: function* (changes) { return update(changes); },
			delete: function* (rows, ctx) { if (rows.length) yield* ctx.refuse('parent delete callback'); }
		} },
		children: { bodies: {
			create: function* (rows) { return create(rows); },
			update: function* (changes) { return update(changes); },
			delete: function* (rows, ctx) { if (rows.length) yield* ctx.refuse('child delete callback'); }
		} }
	},
	automation: { mutate: { body: function* (input, ctx) { yield* mutate(input, ctx); } } },
	policy: { requester: { grants: { parents: {
		create: { approval: (write, flow) => flow.step('Review', { users: ['${REVIEWER}'] }) },
		update: { approval: (write, flow) => flow.step('Review', { users: ['${REVIEWER}'] }) }
	} } } }
};`;
const guest = program(source);
const Parent = Schema.Struct({
	id: Schema.String,
	code: Schema.String,
	name: Schema.String,
	trace: Schema.String,
	revision: Schema.Number
});
const Child = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	trace: Schema.String,
	parent: Schema.NullOr(Schema.String)
});
const committed = (outcome: Outcome) => {
	if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
	return outcome;
};
const idOf = (outcome: Outcome, model = 'parents'): string => {
	const row = committed(outcome).records.find((record) => record.collection === model);
	if (row === undefined) throw new Error(`The write returned no ${model} record`);
	return row.id;
};
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({ manifest, guest: yield* guest, now: NOW })
	);
	const t = Context.get(context, TestWorkspace);
	const route = yield* routeFixture(context);
	const admin = t.as(t.admin).authority;
	const act = (
		callable: string,
		input: Parameters<typeof route.dispatch>[0]['input'],
		authority: Authority = admin,
		options: { onConflict?: 'keep' | 'update' } = {}
	) =>
		route.dispatch(
			{
				callable,
				input,
				key: randomUUID(),
				issuedAt: t.clock.now(),
				...options
			},
			authority
		);
	const parent = (id: string) =>
		t.db
			.one(Parent, {
				text: 'select id::text, code, name, trace, revision from parents where id=$1::uuid',
				params: [id]
			})
			.pipe(Effect.map(Option.getOrThrow));
	const child = (id: string) =>
		t.db
			.one(Child, {
				text: 'select id::text, name, trace, parent::text from children where id=$1::uuid',
				params: [id]
			})
			.pipe(Effect.map(Option.getOrThrow));
	return { context, t, admin, act, parent, child };
});

describe('write callbacks through real entry paths', () => {
	it.live('an automation runs create/update callbacks and its delete guard under its starter', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const callables = Context.get(f.context, Callables);
				const start = (input: Parameters<typeof f.act>[1]) =>
					Effect.gen(function* () {
						const id = randomUUID();
						committed(
							yield* callables.start({
								automation: 'mutate',
								runs: [{ id, input }],
								authority: f.admin,
								bindings: { now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} }
							})
						);
						yield* f.t.runDue();
						return Option.getOrThrow(
							yield* f.t.db.one(
								Schema.Struct({ state: Schema.String, error: Schema.NullOr(Schema.Json) }),
								{
									text: 'select state,error from sys_run where id=$1',
									params: [id]
								}
							)
						);
					});
				expect(
					yield* start({ op: 'create', code: 'AUTOMATION', name: '  Created  ' })
				).toMatchObject({ state: 'succeeded' });
				const row = Option.getOrThrow(
					yield* f.t.db.one(Parent, {
						text: "select id::text,code,name,trace,revision from parents where code='AUTOMATION'",
						params: []
					})
				);
				expect(row).toMatchObject({ name: 'Created', trace: 'C' });
				expect(yield* start({ op: 'update', target: row.id, name: '  Changed  ' })).toMatchObject({
					state: 'succeeded'
				});
				expect(yield* f.parent(row.id)).toMatchObject({ name: 'Changed', trace: 'CU' });
				const refused = yield* start({ op: 'delete', target: row.id });
				expect(refused.state).toBe('failed');
				expect(JSON.stringify(refused.error)).toContain('parent delete callback');
				expect(yield* f.parent(row.id)).toMatchObject({ name: 'Changed', trace: 'CU' });
			})
		)
	);

	it.live('a per-record restore runs update against the live before image', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const id = idOf(
					(yield* f.act('parents.create', { code: 'RESTORE', name: 'First' })).outcome
				);
				committed(
					(yield* f.act('parents.update', { target: id, set: { name: 'Second' } })).outcome
				);
				committed(
					(yield* f.act('history.restore', { collection: 'parents', record: id, revision: 1 }))
						.outcome
				);
				expect(yield* f.parent(id)).toMatchObject({ name: 'First', trace: 'CUU', revision: 3 });
				expect(
					Option.getOrThrow(
						yield* f.t.db.one(Schema.Struct({ cause: Schema.String }), {
							text: "select cause from bolt_history where collection='parents' and record=$1::uuid order by revision desc limit 1",
							params: [id]
						})
					)
				).toEqual({ cause: 'restored' });
			})
		)
	);

	it.live('a requester save runs update before resubmitting an approval request', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				yield* f.t.db.write({
					text: "insert into sys_user (id,name,kind,team) values ($1,'Requester','staff','requesters'),($2,'Reviewer','staff','reviewers')",
					params: [REQUESTER, REVIEWER]
				});
				const requester = f.t.as(
					f.t.member(['requester'], {
						id: REQUESTER,
						teams: ['requesters'],
						teamPath: ['requesters']
					})
				).authority;
				const reviewer = f.t.as(
					f.t.member(['reviewer'], { id: REVIEWER, teams: ['reviewers'], teamPath: ['reviewers'] })
				).authority;
				const created = (yield* f.act(
					'parents.create',
					{ code: 'REVIEW', name: '  Draft  ' },
					requester
				)).outcome;
				if (created.kind !== 'pendingApproval') throw new Error(JSON.stringify(created));
				const record = created.records.find((record) => record.collection === 'parents');
				if (record === undefined) throw new Error('The approval create returned no parent');
				expect(yield* f.parent(record.id)).toMatchObject({ name: 'Draft', trace: 'C' });
				expect(
					yield* Context.get(f.context, Approvals).decide({
						requestId: created.requestId,
						decision: 'requestChanges',
						reason: 'Clarify',
						authority: reviewer,
						now: NOW
					})
				).toMatchObject({ kind: 'decided', status: 'ChangesRequested' });
				expect(
					(yield* f.act(
						'parents.update',
						{ target: record.id, set: { name: '  Clarified  ' } },
						requester
					)).outcome
				).toMatchObject({ kind: 'pendingApproval', requestId: created.requestId });
				expect(yield* f.parent(record.id)).toMatchObject({ name: 'Clarified', trace: 'CU' });
				expect(
					Option.getOrThrow(
						yield* f.t.db.one(Schema.Struct({ state: Schema.String, step: Schema.Number }), {
							text: 'select state,step from bolt_approvals where id=$1::uuid',
							params: [created.requestId]
						})
					)
				).toEqual({ state: 'Pending', step: 0 });
			})
		)
	);

	it.live(
		'nested child update, link and unlink run update; its delete check refuses the whole parent write',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const created = committed(
						(yield* f.act('parents.create', {
							code: 'NESTED',
							name: 'Parent',
							children: { create: [{ name: 'Child' }] }
						})).outcome
					);
					const id = idOf(created);
					const childId = idOf(created, 'children');
					committed(
						(yield* f.act('parents.update', {
							target: id,
							set: { children: { update: [{ target: childId, set: { name: '  Edited  ' } }] } }
						})).outcome
					);
					expect(yield* f.child(childId)).toMatchObject({
						name: 'Edited',
						trace: 'CU',
						parent: id
					});
					const detached = idOf(
						(yield* f.act('children.create', { name: 'Detached' })).outcome,
						'children'
					);
					committed(
						(yield* f.act('parents.update', {
							target: id,
							set: { children: { link: [detached] } }
						})).outcome
					);
					expect(yield* f.child(detached)).toMatchObject({ trace: 'CU', parent: id });
					committed(
						(yield* f.act('parents.update', {
							target: id,
							set: { children: { unlink: [detached] } }
						})).outcome
					);
					expect(yield* f.child(detached)).toMatchObject({ trace: 'CUU', parent: null });
					const before = yield* f.parent(id);
					expect(
						(yield* f.act('parents.update', {
							target: id,
							set: { name: 'Uncommitted', children: { delete: [childId] } }
						})).outcome
					).toMatchObject({ kind: 'refused', message: 'child delete callback' });
					expect(yield* f.parent(id)).toEqual(before);
					expect(yield* f.child(childId)).toMatchObject({ name: 'Edited', trace: 'CU' });
				})
			)
	);

	it.live(
		'upserts resolve a natural key or id before choosing the create/update callback; keep runs neither',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture;
					const id = idOf(
						(yield* f.act('parents.create', { code: 'NATURAL', name: 'Original' })).outcome
					);
					committed(
						(yield* f.act('parents.upsert', { code: 'NATURAL', name: 'By key' }, f.admin, {
							onConflict: 'update'
						})).outcome
					);
					expect(yield* f.parent(id)).toMatchObject({ name: 'By key', trace: 'CU' });
					committed(
						(yield* f.act('parents.upsert', { id, name: 'By id' }, f.admin, {
							onConflict: 'update'
						})).outcome
					);
					expect(yield* f.parent(id)).toMatchObject({ name: 'By id', trace: 'CUU' });
					committed(
						(yield* f.act('parents.upsert', { code: 'NATURAL', name: 'Ignored' }, f.admin, {
							onConflict: 'keep'
						})).outcome
					);
					expect(yield* f.parent(id)).toMatchObject({ name: 'By id', trace: 'CUU' });
					const added = idOf(
						(yield* f.act('parents.upsert', { code: 'NEW', name: 'New' }, f.admin, {
							onConflict: 'update'
						})).outcome
					);
					expect(yield* f.parent(added)).toMatchObject({ name: 'New', trace: 'C' });
				})
			)
	);
});
