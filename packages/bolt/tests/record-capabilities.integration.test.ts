import { expect, it } from '@effect/vitest';
import { Effect, Predicate } from 'effect';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Invocation } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { toPred } from '../src/engine/access/pred.ts';
import { act, recordCapabilities, type WriteEngine } from '../src/engine/write/act.ts';
import { admin, arm, authority, grants, manifest, NOW, TODAY, writeArm } from './write-fixture.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import type { RecordParentContext } from '../src/protocol/record-contracts.ts';

const bindings = { now: NOW, today: TODAY, tz: 'UTC' };
const FALSE = { t: 'const', value: false } as const;
/** A guest answering every policy `check` with `verdict`'s data (the dry run at record open), recording each call. */
const checks = (verdict: () => Json, calls: Invocation[] = []): Partial<WriteEngine> => ({
	guest: {
		invokeProgram: () =>
			Effect.die(new Error('This fixture does not execute supplied guest programs.')),
		invoke: (inv) =>
			Effect.sync(() => {
				calls.push(inv);
				return { kind: 'ok' as const, output: inv.kind === 'policy' ? verdict() : null };
			})
	}
});
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
/** A pooled database for the capability reads. */
const setup = () => Effect.flatMap(TestDb.open(manifest), (pg) => withDb(PgliteDb.make(pg)));
const withDb = (db: TenantDbShape) =>
	Effect.gen(function* () {
		let n = 0;
		const write = (
			model: string,
			verb: 'create' | 'update',
			input: Json,
			source: EngineManifest = manifest
		) =>
			Effect.gen(function* () {
				const result = yield* act(
					{ manifest: source, db },
					{
						model,
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
				const rows = yield* write('orders', 'create', [
					{
						title: 'Desk',
						lines: [{ label: 'Line', amount: '1' }]
					}
				]);
				const parent = rows.find((row) => row.model === 'orders'),
					child = rows.find((row) => row.model === 'lines');
				if (parent === undefined || child === undefined) throw new Error('fixture records missing');
				return { parent: parent.id, child: child.id };
			});
		const capabilities = (
			model: string,
			id: string,
			auth: Authority = admin,
			options: Partial<WriteEngine> = {},
			parent?: RecordParentContext,
			output?: string
		) => {
			const engine: WriteEngine = { manifest, db, ...options };
			const reads = readEngine({ manifest: engine.manifest, db });
			return recordCapabilities(
				engine,
				model,
				id,
				auth,
				bindings,
				(model, id) =>
					Effect.gen(function* () {
						const [row] = yield* reads.run(
							[
								{
									kind: 'get',
									model,
									id,
									select: { fields: null, relations: {} },
									...(output === undefined ? {} : { output })
								}
							],
							{ as: 'caller', authority: auth },
							bindings
						);
						return Predicate.isObject(row) ? row : null;
					}),
				parent
			);
		};
		return { db, write, create, capabilities };
	});

it.live(
	"nested-only child edits use the root's layer columns, layer scope, locks and revision, never the child's own grant",
	() =>
		Effect.gen(function* () {
			const { db, write, create, capabilities } = yield* setup();
			const { parent, child } = yield* create();
			const source: EngineManifest = {
				...manifest,
				exposures: { ...manifest.exposures, lines: { read: { lines: { fields: 'all' } } } }
			};
			const readOnly = grants('lines', { create: [], update: [], delete: [] });
			const layer = { 'orders.lines': ['label', 'amount'] };
			const auth = authority({
				orders: grants('orders', { update: [writeArm(layer)] }),
				lines: readOnly
			});
			const context = { model: 'orders', id: parent, relation: 'lines', revision: 1 };
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
				orders: grants('orders', { update: [writeArm({ orders: ['note'] })] }),
				lines: readOnly
			});
			expect(
				(yield* capabilities('lines', child, denied, { manifest: source }, context))?.update.allowed
			).toBe(false);
			// the root's layer narrows the child; the child's own update grant (every column) is never consulted
			const restrictedChild = authority({
				orders: grants('orders', { update: [writeArm({ 'orders.lines': ['label'] })] }),
				lines: grants('lines')
			});
			expect(
				(yield* capabilities('lines', child, restrictedChild, { manifest: source }, context))
					?.fields['amount']?.writable
			).toBe(false);
			// the update check's dry run approves: the child's columns are proposals
			const proposer = authority({
				orders: grants('orders', { update: [writeArm(layer, true)] }),
				lines: readOnly
			});
			const approving = checks(() => ({
				kind: 'approve',
				flow: {
					kind: 'steps',
					steps: [{ name: 'Review', teams: ['t'], users: [] }],
					superseded_by: []
				}
			}));
			expect(
				(yield* capabilities('lines', child, proposer, { manifest: source, ...approving }, context))
					?.fields['amount']
			).toMatchObject({ writable: false, proposal: true });
			// the root's `orders.lines` layer scope hides the child: no capability through that parent
			const hidden = authority({
				orders: grants('orders', {
					read: { default: { orders: [arm()], 'orders.lines': [arm(FALSE)] } },
					update: [writeArm(layer)]
				}),
				lines: readOnly
			});
			expect(yield* capabilities('lines', child, hidden, { manifest: source }, context)).toBeNull();
			const other = yield* write('orders', 'create', [{ title: 'Other' }]);
			const otherParent = other.find((row) => row.model === 'orders');
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
					model: 'orders',
					verb: 'update',
					input: [
						{
							target: parent,
							set: { lines: { update: [{ target: child, set: { amount: '2' } }] } }
						}
					],
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
			yield* write('orders', 'update', [{ target: parent, set: { status: 'submitted' } }]);
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
			exposures: {
				...manifest.exposures,
				tags: { read: { tags: { fields: 'all' } }, create: { columns: { tags: ['name'] } } }
			}
		};
		const records = yield* write('tags', 'create', [{ name: 'Free' }], source);
		const tag = records.find((row) => row.model === 'tags');
		if (tag === undefined) throw new Error('missing tag');
		const auth = authority({
			orders: grants('orders', { update: [writeArm({ 'orders.tags': [] })] }),
			tags: grants('tags', { create: [], update: [], delete: [] })
		});
		const context = { model: 'orders', id: parent, relation: 'tags', revision: 1 };
		const linking = yield* capabilities('tags', tag.id, auth, { manifest: source }, context);
		expect(linking?.fields['order']?.writable).toBe(true);
		expect(linking?.fields['name']?.writable).toBe(false);
		expect(linking?.delete.allowed).toBe(false);
		yield* write('orders', 'update', [{ target: parent, set: { tags: { link: [tag.id] } } }]);
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

it.live('publishes the fields of the output the caller reads; an output it lacks hides them', () =>
	Effect.gen(function* () {
		const { create, capabilities } = yield* setup();
		const { parent } = yield* create();
		const orders = required(manifest.exposures['orders']);
		const source: EngineManifest = {
			...manifest,
			exposures: {
				...manifest.exposures,
				orders: { ...orders, outputs: { brief: { orders: { fields: ['note', 'status'] } } } }
			}
		};
		const auth = authority({
			orders: grants('orders', {
				read: { brief: { orders: [arm()] } },
				update: [writeArm({ orders: ['note'] })]
			})
		});
		const caps = yield* capabilities(
			'orders',
			parent,
			auth,
			{ manifest: source },
			undefined,
			'brief'
		);
		expect(caps?.fields).toEqual({
			note: { writable: true, proposal: false, reasons: [] },
			status: { writable: false, proposal: false, reasons: ['noGrant'] },
			// the declared update layers: the arm names neither
			lines: { writable: false, proposal: false, reasons: ['noGrant'] },
			tags: { writable: false, proposal: false, reasons: ['noGrant'] }
		});
		expect(caps?.update.allowed).toBe(true);
		expect(JSON.stringify(caps)).not.toContain('number');
		expect(JSON.stringify(caps)).not.toContain('title');
		// the default output is not granted: reading it is refused
		expect(
			yield* Effect.flip(capabilities('orders', parent, auth, { manifest: source }))
		).toMatchObject({ code: 'forbidden' });
		const unreadable = authority({
			orders: grants('orders', { read: { default: { orders: [arm(FALSE)] } } })
		});
		expect(yield* capabilities('orders', parent, unreadable)).toBeNull();
	})
);

it.live(
	"edit-ability is the update check's dry run on the stored record, one call per open, no write",
	() =>
		Effect.gen(function* () {
			const { db, create, capabilities } = yield* setup();
			const { child } = yield* create();
			const auth = authority({
				lines: grants('lines', { update: [writeArm({ lines: ['amount'] }, true)] })
			});
			// the check stands in for a read of the parent's note
			let editable = false;
			const calls: Invocation[] = [];
			const engine = checks(
				() => (editable ? { kind: 'allow' } : { kind: 'deny', message: 'Not editable yet.' }),
				calls
			);
			expect((yield* capabilities('lines', child, auth, engine))?.fields['amount']).toMatchObject({
				writable: false,
				proposal: false
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				kind: 'policy',
				target: 'p.lines.update',
				input: [{ before: { id: child }, set: {} }]
			});
			editable = true;
			expect((yield* capabilities('lines', child, auth, engine))?.fields['amount']).toEqual({
				writable: true,
				proposal: false,
				reasons: []
			});
			expect(calls).toHaveLength(2);
			const [line] = yield* db.read([
				{ text: `select revision from lines where id = $1`, params: [child] }
			]);
			expect(line?.rows).toEqual([{ revision: 1 }]);
		})
);

it.live(
	'rechecks readability when the row moves outside the caller scope during the capability read',
	() =>
		Effect.gen(function* () {
			const { db, write, create } = yield* setup();
			const { parent } = yield* create();
			const auth = authority({
				orders: grants('orders', {
					read: {
						default: { orders: [arm(toPred(manifest, 'orders', { title: { eq: 'Desk' } }))] }
					}
				})
			});
			const reads = readEngine({ manifest, db });
			const result = yield* recordCapabilities(
				{ manifest, db },
				'orders',
				parent,
				auth,
				bindings,
				(model, id) =>
					Effect.gen(function* () {
						const [row] = yield* reads.run(
							[{ kind: 'get', model, id, select: { fields: null, relations: {} } }],
							{ as: 'caller', authority: auth },
							bindings
						);
						yield* write('orders', 'update', [{ target: parent, set: { title: 'Private' } }]);
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
			orders: grants('orders', {
				read: { default: { orders: [arm(predicate)] } },
				update: [writeArm({ orders: ['note'] })]
			})
		});
		expect((yield* capabilities('orders', parent, auth))?.fields['note']?.writable).toBe(true);
		const reads = readEngine({ manifest, db });
		const result = yield* recordCapabilities(
			{ manifest, db },
			'orders',
			parent,
			auth,
			bindings,
			(model, id) =>
				Effect.gen(function* () {
					const [row] = yield* reads.run(
						[{ kind: 'get', model, id, select: { fields: null, relations: {} } }],
						{ as: 'caller', authority: auth },
						bindings
					);
					yield* write('lines', 'update', [{ target: child, set: { amount: '0' } }]);
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
				exposures: {
					...manifest.exposures,
					tags: {
						read: { tags: { fields: 'all' } },
						create: { columns: { tags: ['name'] } },
						update: { columns: { tags: ['name'] } }
					}
				}
			};
			const tags = yield* write('tags', 'create', [{ name: 'Independent' }], source);
			const tag = tags.find((row) => row.model === 'tags');
			if (tag === undefined) throw new Error('fixture tag missing');
			yield* write('orders', 'update', [
				{
					target: parent,
					set: { tags: { link: [tag.id] }, status: 'submitted' }
				}
			]);
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
		const auth = authority({
			orders: grants('orders', { update: [writeArm({ orders: ['note'] })] })
		});
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
		const orders = required(manifest.exposures['orders']);
		const source: EngineManifest = {
			...manifest,
			exposures: {
				...manifest.exposures,
				orders: {
					...orders,
					update: { columns: { ...required(orders.update).columns, orders: ['note', 'status'] } },
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
		const reader = authority({ orders: grants('orders') });
		expect(exposure(source, reader)['orders']?.syncs).toBeUndefined();
		expect(
			exposure(source, { ...reader, automations: ['orders.sync.erp'] })['orders']?.syncs
		).toEqual({ erp: { kind: 'remote', with: 'erp' } });
	})
);
