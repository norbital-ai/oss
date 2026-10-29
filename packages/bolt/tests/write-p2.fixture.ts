// The second write workspace shares the native tenant-db and transform bridge.
import { Effect, Result } from 'effect';
import type { Bindings, Invocation } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { decodeManifest, type EngineManifest } from '../src/engine/manifest.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import type { Bridge } from '../src/engine/services.ts';
import type { Fingerprint } from '../src/engine/write/sql.ts';
import { fingerprinting } from '../src/engine/write/sql.ts';
import { manifest as base } from './write-fixture.ts';

const orders = base.exposures.orders;
if (orders === undefined) throw new Error('the base write fixture has no orders model');
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
		exposures: {
			...base.exposures,
			orders: {
				...orders,
				update: {
					columns: {
						orders: ['title', 'note', 'status'],
						'orders.lines': ['label', 'amount'],
						'orders.tags': ['name']
					}
				}
			},
			tags: {
				read: { tags: { fields: 'all' } },
				create: { columns: { tags: ['name'] } },
				delete: {}
			},
			receipts: {
				read: { receipts: { fields: 'all' } },
				create: { columns: { receipts: ['memo', 'order'] } },
				update: { columns: { receipts: ['memo', 'order'] } }
			},
			people: {
				read: { people: { fields: 'all' } },
				create: { columns: { people: ['code', 'name', 'email'] } },
				update: { columns: { people: ['name', 'email', 'status'] } },
				delete: {}
			}
		}
	})
);

export const open = (m: EngineManifest = manifest) =>
	Effect.gen(function* () {
		const pg = yield* TestDb.open(m),
			db = PgliteDb.make(pg);
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
			tz: inv.ctx.tz
		};
		return {
			tables: () => [...tables],
			fingerprints: fp.fingerprints,
			cross: (calls) =>
				Effect.gen(function* () {
					const batch = calls.flatMap((call) => (call._tag === 'read' ? [call.read] : []));
					for (const read of batch)
						for (const name of read.kind === 'request'
							? read.roots.map((r) => r.root)
							: 'model' in read
								? [read.model]
								: [])
							tables.add(name);
					return (yield* reads.run(batch, { as: 'workspace' }, bindings)).map((value) => ({
						ok: true as const,
						value
					}));
				}).pipe(Effect.orDie)
		};
	};
}
