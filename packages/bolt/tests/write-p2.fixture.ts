// The second write workspace shares the native tenant-db and transform bridge.
import { Effect, Result } from 'effect';
import type { Invocation } from '../src/engine/contracts.ts';
import { PgliteDb } from '@norbital-ai/host-api/node';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { decode_manifest, type EngineManifest } from '../src/engine/manifest.ts';
import { transformBridge } from '../src/engine/write/act.ts';
import { manifest as base } from './write-fixture.ts';

const orders = base.exposures.orders;
if (orders === undefined) throw new Error('the base write fixture has no orders model');
export const manifest = Result.getOrThrow(
	decode_manifest({
		...base,
		models: {
			...base.models,
			// a ref names its order by the import key's values
			orders: { ...base.models.orders, key: ['title'], unique: [{ fields: ['title'], import_key: true }] },
			tags: {
				description: 'A tag',
				record_label: 'record.name',
				unique: [{ fields: ['name'] }],
				fields: { name: { kind: 'text' } }
			},
			receipts: {
				description: 'A receipt',
				record_label: 'record.memo',
				// an import matches its rows by a declared import key
				key: ['memo'],
				unique: [{ fields: ['memo'], name: 'one_memo', import_key: true }],
				fields: { memo: { kind: 'text' } }
			},
			people: {
				description: 'A person',
				record_label: 'record.name',
				key: ['code'],
				unique: [{ fields: ['code'], name: 'one_code', import_key: true }],
				locks: { archived: { where: { status: { eq: 'archived' } } } },
				search: { text: ['name'] },
				fields: {
					code: { kind: 'text' },
					name: { kind: 'text' },
					email: { kind: 'text', optional: true },
					status: {
						kind: 'state',
						initial: 'active',
						states: { active: { to: ['archived'] }, archived: {} }
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
				outputs: { default: { tags: { fields: 'all' } } },
				create: { columns: { tags: ['name'] } },
				delete: {}
			},
			receipts: {
				outputs: { default: { receipts: { fields: 'all' } } },
				create: { columns: { receipts: ['memo', 'order'] } },
				update: { columns: { receipts: ['memo', 'order'] } }
			},
			people: {
				outputs: { default: { people: { fields: 'all' } } },
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
			db = TenantDb.typed(PgliteDb.make(pg));
		return { pg, db };
	});

/** The same workspace bridge, dependencies and fingerprints as a native transform. */
export const bridge_on = (db: TenantDbShape, m: EngineManifest = manifest) =>
	(inv: Invocation) => transformBridge(m, db, inv);
