import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Predicate } from 'effect';
import { TestWorkspace } from '../src/test/index.ts';
import { json, routeFixture } from './support/route-fixture.ts';
import type { Authority, RowData } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { toPred } from '../src/engine/access/pred.ts';
import { act, recordCapabilities, type WriteEngine } from '../src/engine/write/act.ts';
import { admin, arm, authority, grants, manifest, NOW, TODAY } from './write-fixture.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import type { RecordParentContext } from '../src/protocol/record-contracts.ts';

const bindings = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const setup = () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW }));
		const db = Context.get(context, TestWorkspace).db;
		let n = 0;
		const write = (
			collection: string,
			verb: 'create' | 'update',
			input: RowData,
			source: EngineManifest = manifest
		) =>
			Effect.gen(function* () {
				const result = yield* act(
					{ manifest: source, db },
					{
						collection,
						verb,
						input,
						mode: { _tag: 'Direct' },
						authority: admin,
						bindings,
						key: `cap-${n}`,
						invocationId: `cap-${n++}`,
						issuedAt: NOW
					}
				);
				if (result.outcome.kind !== 'committed') throw new Error(JSON.stringify(result.outcome));
				return result.outcome.records;
			});
		const create = () =>
			Effect.gen(function* () {
				const rows = yield* write('orders', 'create', {
					title: 'Desk',
					lines: { create: [{ label: 'Line', amount: '1' }] }
				});
				const parent = rows.find((row) => row.collection === 'orders'),
					child = rows.find((row) => row.collection === 'lines');
				if (parent === undefined || child === undefined) throw new Error('fixture records missing');
				return { parent: parent.id, child: child.id };
			});
		const capabilities = (
			collection: string,
			id: string,
			auth: Authority = admin,
			options: Partial<WriteEngine> = {},
			parent?: RecordParentContext
		) => {
			const engine: WriteEngine = { manifest, db, ...options };
			const reads = readEngine({ manifest: engine.manifest, db });
			return recordCapabilities(
				engine,
				collection,
				id,
				auth,
				bindings,
				(collection, id) =>
					Effect.gen(function* () {
						const [row] = yield* reads.run(
							[{ kind: 'get', collection, id, select: { fields: null, relations: {} } }],
							{ as: 'caller', authority: auth },
							bindings
						);
						return Predicate.isObject(row) ? row : null;
					}),
				parent
			);
		};
		return { context, db, write, create, capabilities };
	});

it.live(
	'nested-only child edits use the actual parent contract, scope, masks, locks and revision',
	() =>
		Effect.gen(function* () {
			const { db, write, create, capabilities } = yield* setup();
			const { parent, child } = yield* create();
			const source: EngineManifest = {
				...manifest,
				collections: { ...manifest.collections, lines: { read: { fields: 'all' } } }
			};
			const readOnly = grants({ create: [], update: [], delete: [] });
			const auth = authority({
				orders: grants({ update: [arm(undefined, ['lines'])] }),
				lines: readOnly
			});
			const context = { collection: 'orders', id: parent, relation: 'lines', revision: 1 };
			expect(
				(yield* capabilities('lines', child, auth, { manifest: source }))?.update.allowed
			).toBe(false);
			const nested = yield* capabilities('lines', child, auth, { manifest: source }, context);
			expect(nested?.fields['amount']).toEqual({ writable: true, proposal: false, reasons: [] });
			expect(nested?.delete.allowed).toBe(true);
			expect(exposure(source, auth)['orders']?.update?.with?.['lines']).toMatchObject({
				update: { columns: ['label', 'amount'] },
				delete: true
			});
			const denied = authority({
				orders: grants({ update: [arm(undefined, ['note'])] }),
				lines: readOnly
			});
			expect(
				(yield* capabilities('lines', child, denied, { manifest: source }, context))?.update.allowed
			).toBe(false);
			const restrictedChild = authority({
				orders: grants({ update: [arm(undefined, ['lines'])] }),
				lines: grants({ update: [arm(undefined, ['label'])] })
			});
			expect(
				(yield* capabilities('lines', child, restrictedChild, { manifest: source }, context))
					?.fields['amount']?.writable
			).toBe(false);
			const proposer = authority({
				orders: grants({
					update: [{ ...arm(undefined, ['lines']), approval: true }]
				}),
				lines: readOnly
			});
			expect(
				(yield* capabilities('lines', child, proposer, { manifest: source }, context))?.fields[
					'amount'
				]
			).toEqual({ writable: false, proposal: true, reasons: ['noGrant'] });
			const masked = authority({
				orders: grants({
					update: [arm(undefined, ['lines'])],
					masks: { lines: { t: 'const', value: false } }
				}),
				lines: readOnly
			});
			expect(yield* capabilities('lines', child, masked, { manifest: source }, context)).toBeNull();
			const other = yield* write('orders', 'create', { title: 'Other' });
			const otherParent = other.find((row) => row.collection === 'orders');
			if (otherParent === undefined) throw new Error('missing parent');
			expect(
				yield* capabilities(
					'lines',
					child,
					auth,
					{ manifest: source },
					{ ...context, id: otherParent.id }
				)
			).toBeNull();
			expect(
				yield* capabilities('lines', child, auth, { manifest: source }, { ...context, revision: 2 })
			).toBeNull();
			const result = yield* act(
				{ manifest: source, db },
				{
					collection: 'orders',
					verb: 'update',
					input: {
						target: parent,
						set: { lines: { update: [{ target: child, set: { amount: '2' } }] } }
					},
					mode: { _tag: 'Direct' },
					authority: auth,
					bindings,
					observed: { [parent]: 1, [child]: 1 },
					key: 'nested-cap',
					invocationId: 'nested-cap',
					issuedAt: NOW
				}
			);
			expect(result.outcome.kind).toBe('committed');
			yield* write('orders', 'update', { target: parent, set: { status: 'submitted' } });
			const current = yield* capabilities('orders', parent, auth, { manifest: source });
			if (current === null) throw new Error('missing current parent');
			expect(
				(yield* capabilities(
					'lines',
					child,
					auth,
					{ manifest: source },
					{ ...context, revision: current.revision }
				))?.fields['amount']?.reasons
			).toContain('ownedParentLocked');
		})
);

it.live('free links and declared unlinks gain only their nested foreign-key capability', () =>
	Effect.gen(function* () {
		const { write, create, capabilities } = yield* setup();
		const { parent } = yield* create();
		const source: EngineManifest = {
			...manifest,
			collections: {
				...manifest.collections,
				tags: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } }
			}
		};
		const records = yield* write('tags', 'create', { name: 'Free' }, source);
		const tag = records.find((row) => row.collection === 'tags');
		if (tag === undefined) throw new Error('missing tag');
		const auth = authority({
			orders: grants({ update: [arm(undefined, ['tags'])] }),
			tags: grants({ create: [], update: [], delete: [] })
		});
		const context = { collection: 'orders', id: parent, relation: 'tags', revision: 1 };
		const linking = yield* capabilities('tags', tag.id, auth, { manifest: source }, context);
		expect(linking?.fields['order']?.writable).toBe(true);
		expect(linking?.fields['name']?.writable).toBe(false);
		expect(linking?.delete.allowed).toBe(false);
		yield* write('orders', 'update', { target: parent, set: { tags: { link: [tag.id] } } });
		const caps = yield* capabilities('orders', parent, auth, { manifest: source });
		if (caps === null) throw new Error('missing parent');
		expect(
			(yield* capabilities(
				'tags',
				tag.id,
				auth,
				{ manifest: source },
				{ ...context, revision: caps.revision }
			))?.fields['order']?.writable
		).toBe(true);
	})
);

it.live('publishes scoped ordinary grants while omitting unreadable and masked field names', () =>
	Effect.gen(function* () {
		const { create, capabilities } = yield* setup();
		const { parent } = yield* create();
		const auth = authority({
			orders: grants({
				read: [arm(undefined, ['title', 'note', 'status'])],
				update: [arm(undefined, ['note'])],
				masks: { title: { t: 'const', value: false } }
			})
		});
		const caps = yield* capabilities('orders', parent, auth);
		expect(caps?.fields).toEqual({
			note: { writable: true, proposal: false, reasons: [] },
			status: { writable: false, proposal: false, reasons: ['noGrant'] }
		});
		expect(caps?.update.allowed).toBe(true);
		expect(JSON.stringify(caps)).not.toContain('number');
		expect(JSON.stringify(caps)).not.toContain('title');
		const unreadable = authority({ orders: grants({ read: [arm({ t: 'const', value: false })] }) });
		expect(yield* capabilities('orders', parent, unreadable)).toBeNull();
	})
);

it.live('checks one-relation policy hops rather than guessing permission from the catalog', () =>
	Effect.gen(function* () {
		const { write, create, capabilities } = yield* setup();
		const { parent, child } = yield* create();
		const scoped = toPred(manifest, 'lines', { order: { is: { note: { eq: 'editable' } } } });
		const auth = authority({ lines: grants({ update: [arm(scoped, ['amount'])] }) });
		expect((yield* capabilities('lines', child, auth))?.fields['amount']).toEqual({
			writable: false,
			proposal: false,
			reasons: ['noGrant']
		});
		yield* write('orders', 'update', { target: parent, set: { note: 'editable' } });
		expect((yield* capabilities('lines', child, auth))?.fields['amount']).toEqual({
			writable: true,
			proposal: false,
			reasons: []
		});
	})
);

it.live(
	'rechecks readability when the row moves outside the caller scope during the capability read',
	() =>
		Effect.gen(function* () {
			const { db, write, create } = yield* setup();
			const { parent } = yield* create();
			const auth = authority({
				orders: grants({ read: [arm(toPred(manifest, 'orders', { title: { eq: 'Desk' } }))] })
			});
			const reads = readEngine({ manifest, db });
			const result = yield* recordCapabilities(
				{ manifest, db },
				'orders',
				parent,
				auth,
				bindings,
				(collection, id) =>
					Effect.gen(function* () {
						const [row] = yield* reads.run(
							[{ kind: 'get', collection, id, select: { fields: null, relations: {} } }],
							{ as: 'caller', authority: auth },
							bindings
						);
						yield* write('orders', 'update', { target: parent, set: { title: 'Private' } });
						return Predicate.isObject(row) ? row : null;
					})
			);
			expect(result).toBeNull();
		})
);

it.live('rechecks a many-relation read scope before exposing record capabilities', () =>
	Effect.gen(function* () {
		const { db, write, create, capabilities } = yield* setup();
		const { parent, child } = yield* create();
		const predicate = toPred(manifest, 'orders', { lines: { some: { amount: { gte: 1 } } } });
		const auth = authority({
			orders: grants({ read: [arm(predicate)], update: [arm(undefined, ['note'])] })
		});
		expect((yield* capabilities('orders', parent, auth))?.fields['note']?.writable).toBe(true);
		const reads = readEngine({ manifest, db });
		const result = yield* recordCapabilities(
			{ manifest, db },
			'orders',
			parent,
			auth,
			bindings,
			(collection, id) =>
				Effect.gen(function* () {
					const [row] = yield* reads.run(
						[{ kind: 'get', collection, id, select: { fields: null, relations: {} } }],
						{ as: 'caller', authority: auth },
						bindings
					);
					yield* write('lines', 'update', { target: child, set: { amount: '0' } });
					return Predicate.isObject(row) ? row : null;
				})
		);
		expect(result).toBeNull();
	})
);

it.live(
	'distinguishes state restrictions, immutable owned parents and independent relationships',
	() =>
		Effect.gen(function* () {
			const { write, create, capabilities } = yield* setup();
			const { parent, child } = yield* create();
			const source: EngineManifest = {
				...manifest,
				collections: {
					...manifest.collections,
					tags: {
						read: { fields: 'all' },
						create: { input: { columns: ['name'] } },
						update: { input: { columns: ['name'] } }
					}
				}
			};
			const tags = yield* write('tags', 'create', { name: 'Independent' }, source);
			const tag = tags.find((row) => row.collection === 'tags');
			if (tag === undefined) throw new Error('fixture tag missing');
			yield* write('orders', 'update', {
				target: parent,
				set: { tags: { link: [tag.id] }, status: 'submitted' }
			});
			const parentCaps = yield* capabilities('orders', parent);
			expect(parentCaps?.fields['title']?.reasons).toContain('stateLocked');
			expect(parentCaps?.fields['note']?.writable).toBe(true);
			const childCaps = yield* capabilities('lines', child);
			expect(childCaps?.fields['order']?.reasons).toContain('ownedParent');
			expect(childCaps?.fields['amount']?.reasons).toContain('ownedParentLocked');
			expect(childCaps?.update.allowed).toBe(false);
			expect(
				(yield* capabilities('tags', tag.id, admin, { manifest: source }))?.fields['name']?.writable
			).toBe(true);
		})
);

it.live('ordinary writable masks remain precise without provisional approval stamps', () =>
	Effect.gen(function* () {
		const { create, capabilities } = yield* setup();
		const { parent } = yield* create();
		const auth = authority({ orders: grants({ update: [arm(undefined, ['note'])] }) });
		const caps = yield* capabilities('orders', parent, auth);
		expect(caps?.fields['note']?.writable).toBe(true);
		expect(caps?.fields['title']?.writable).toBe(false);
	})
);

it.live('sync-owned fields stay readable and local fields remain writable', () =>
	Effect.gen(function* () {
		const { create, capabilities } = yield* setup();
		const { parent } = yield* create();
		// A read-only ERP sync owns every field outside the local update columns.
		const orders = required(manifest.collections['orders']);
		const source: EngineManifest = {
			...manifest,
			collections: {
				...manifest.collections,
				orders: {
					...orders,
					update: { input: { ...required(orders.update).input, columns: ['note', 'status'] } },
					syncs: { erp: { with: 'erp', read: true } }
				}
			},
			integrations: {
				erp: {
					description: 'An ERP',
					driver: 'sqlserver'
				}
			}
		};
		const caps = yield* capabilities('orders', parent, admin, { manifest: source });
		expect(caps?.fields['title']).toEqual({
			writable: false,
			proposal: false,
			reasons: ['noGrant', 'syncOwned']
		});
		expect(caps?.fields['note']).toEqual({ writable: true, proposal: false, reasons: [] });
		expect(exposure(source, admin)['orders']).toMatchObject({
			readonlyFields: { title: 'syncOwned' },
			syncs: { erp: { kind: 'remote', with: 'erp' } }
		});
		const reader = authority({ orders: grants() });
		expect(exposure(source, reader)['orders']?.syncs).toBeUndefined();
		expect(
			exposure(source, { ...reader, automations: ['orders.sync.erp'] })['orders']?.syncs
		).toEqual({ erp: { kind: 'remote', with: 'erp' } });
	})
);

it.live(
	'the native HTTP endpoint authenticates, uses the caller read scope and returns capabilities',
	() =>
		Effect.gen(function* () {
			const { context, create } = yield* setup();
			const { parent } = yield* create();
			let session: Authority | null = admin;
			const http = yield* routeFixture(context);
			const request = () =>
				http.handle(
					session,
					new Request(`http://tenant/__bolt/record-capabilities?collection=orders&id=${parent}`)
				);
			const response = yield* request();
			expect(response.status).toBe(200);
			const body = yield* json(response);
			expect(body).toMatchObject({
				value: {
					collection: 'orders',
					id: parent,
					revision: 1,
					fields: { title: { writable: true, proposal: false, reasons: [] } }
				}
			});
			session = authority({ orders: grants({ read: [arm({ t: 'const', value: false })] }) });
			expect((yield* request()).status).toBe(404);
			session = null;
			expect((yield* request()).status).toBe(401);
		})
);
