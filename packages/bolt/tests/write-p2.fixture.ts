// The second write workspace shares the native tenant-db and transform bridge.
import { Effect, Result } from 'effect';
import type { Bindings, Invocation } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { decodeManifest, type EngineManifest } from '../src/engine/manifest.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import type { Bridge } from '../src/engine/services.ts';
import type { Fingerprint } from '../src/engine/write/sql.ts';
import { fingerprinting } from '../src/engine/write/sql.ts';
import { manifest as base } from './write-fixture.ts';

const orders = base.collections.orders;
if (orders === undefined) throw new Error('the base write fixture has no orders collection');
export const manifest = Result.getOrThrow(
	decodeManifest({
		...base,
		models: {
			...base.models,
			tags: {
				description: 'A tag',
				label: 'name',
				unique: [{ fields: ['name'] }],
				fields: { name: { kind: 'text' } }
			},
			receipts: { description: 'A receipt', label: 'memo', fields: { memo: { kind: 'text' } } },
			people: {
				description: 'A person',
				label: 'name',
				key: ['code'],
				search: { text: ['name'] },
				fields: {
					code: { kind: 'text' },
					name: { kind: 'text' },
					email: { kind: 'text', optional: true },
					status: {
						kind: 'state',
						initial: 'active',
						states: { active: { to: ['archived'] }, archived: { edit: 'none' } }
					}
				},
				computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } }
			}
		},
		relationships: {
			...base.relationships,
			'receipts.order': { to: 'orders', inverse: 'receipts' }
		},
		collections: {
			...base.collections,
			orders: {
				...orders,
				update: {
					input: {
						columns: ['title', 'note', 'status'],
						with: {
							lines: {
								create: { columns: ['label', 'amount'] },
								update: { columns: ['label', 'amount'] },
								delete: {}
							},
							tags: { link: {}, unlink: {}, upsert: { columns: ['name'] } }
						}
					}
				}
			},
			tags: {
				read: { fields: 'all' },
				create: { input: { columns: ['name'] } },
				delete: { transform: true }
			},
			receipts: {
				read: { fields: 'all' },
				create: { input: { columns: ['memo', 'order'] } },
				update: { input: { columns: ['memo', 'order'] } }
			},
			people: {
				read: { fields: 'all' },
				create: { input: { columns: ['code', 'name', 'email'] } },
				update: { input: { columns: ['name', 'email', 'status'] } },
				delete: {}
			}
		}
	})
);

/** A manifest's schema on an explicit native tenant database. */
export const migrate = (db: TenantDbShape, m: EngineManifest = manifest) =>
	applyPlan(db, plan(null, m), { accept: true });
export const open = (m: EngineManifest = manifest) =>
	Effect.gen(function* () {
		const pg = yield* PgliteDb.open(),
			db = PgliteDb.make(pg);
		yield* migrate(db, m);
		return { pg, db };
	});

/** Workspace reads, fingerprinted, retain one database round trip per crossing. */
export function bridgeOn(db: TenantDbShape, m: EngineManifest = manifest) {
	return (
		inv: Invocation
	): Bridge & { tables(): readonly string[]; fingerprints(): readonly Fingerprint[] } => {
		const fp = fingerprinting(db),
			reads = readEngine({ db: fp.db, manifest: m });
		const tables = new Set<string>();
		const bindings: Bindings = {
			now: inv.ctx.now,
			today: inv.ctx.today,
			tz: inv.ctx.tz,
			params: {}
		};
		return {
			tables: () => [...tables],
			fingerprints: fp.fingerprints,
			cross: (calls) =>
				Effect.gen(function* () {
					const batch = calls.flatMap((call) => (call._tag === 'read' ? [call.read] : []));
					for (const read of batch) tables.add(read.collection);
					return (yield* reads.run(batch, { as: 'workspace' }, bindings)).map((value) => ({
						ok: true as const,
						value
					}));
				}).pipe(Effect.orDie)
		};
	};
}
