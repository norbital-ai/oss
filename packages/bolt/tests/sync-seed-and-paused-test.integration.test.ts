import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Syncs } from '../src/engine/sync/index.ts';
import { load_pack, memory_source } from '../src/engine/write/pack.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		orders: {
			description: 'Orders',
			record_label: 'record.code',
			fields: {
				code: { kind: 'text' },
				total: { kind: 'sum', of: 'lines.amount' },
				line_count: { kind: 'count', of: 'lines' }
			}
		},
		order_lines: {
			description: 'Order lines',
			record_label: 'record.order',
			fields: {
				order: { kind: 'ref', to: 'orders', inverse: 'lines', owned: true },
				amount: { kind: 'decimal', scale: 2 }
			}
		}
	},
	relationships: {
		'order_lines.order': {
			to: 'orders',
			inverse: 'lines',
			owned: true
		}
	},
	exposures: {
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['code'] } },
			update: { columns: { orders: ['code'] } },
			delete: {},
			syncs: { erp: { with: 'erp', policies: ['erp_sync'], read: true, write: true } }
		},
		order_lines: {
			outputs: { default: { order_lines: { fields: 'all' } } },
			create: { columns: { order_lines: ['order', 'amount'] } },
			update: { columns: { order_lines: ['amount'] } },
			delete: {}
		}
	},
	integrations: {
		erp: {
			description: 'ERP',
			driver: 'http',
			http: { base_url: 'https://erp.example' },
			test: true
		}
	},
	policies: {
		erp_sync: {
			description: 'ERP sync',
			grants: {
				orders: { outputs: { default: {} }, create: {}, update: {}, delete: {} },
				order_lines: { outputs: { default: {} }, create: {}, update: {}, delete: {} }
			}
		}
	},
	teams: {
		ops: { policies: ['erp_sync'] }
	}
};

const guestSource = `export default {
	integration_definition: {
		erp: {
			bodies: {
				test: function* (ctx) {
					return yield* ctx.request({ method: 'GET', path: '/ping' });
				}
			}
		}
	}
};`;

const orderId = '0195b000-0000-7000-8000-000000000001';
const lineId = '0195b000-0000-7000-8000-000000000002';
const syncId = '0195b000-0000-7000-8000-000000000003';
const syncRowId = '0195b000-0000-7000-8000-000000000004';
const userId = '0195b000-0000-7000-8000-000000000005';

describe('cutover SYNC_SEED and paused Syncs.test', () => {
	it.live(
		'loads sys_sync and sys_sync_row via load_pack, aligns acked_revision after rollups, and allows Syncs.test while paused',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
					const source = memory_source(
						'cutover',
						{
							sys_user: [
								{
									id: userId,
									name: 'Ops',
									email: 'ops@example.invalid',
									kind: 'staff',
									active: true,
									admin: true,
									team: 'ops'
								}
							],
							sys_integration: [
								{ id: 'erp', integration: 'erp', name: 'ERP', owner: null, active: false, configuration: {} }
							],
							orders: [{ id: orderId, code: 'SO-1', total: '125.50', line_count: 1 }],
							order_lines: [{ id: lineId, order: orderId, amount: '125.50' }],
							sys_sync: [
								{
									id: syncId,
									sync: 'orders.sync.erp',
									instance: 'erp',
									partition: '',
									cursor: { page: 1 },
									cycle: 1,
									phase: 'read',
									health: { state: 'ready' },
									digest: 'abc',
									version: 1,
									started_at: '2026-11-22T00:00:00Z'
								}
							],
							sys_sync_row: [
								{
									id: syncRowId,
									sync: 'orders.sync.erp',
									instance: 'erp',
									partition: '',
									remote_id: 'R-1',
									record: orderId,
									remote_version: 'v1',
									cycle: 1,
									acked_revision: 1
								}
							]
						},
						[],
						[],
						() => Effect.succeed(new Uint8Array())
					);

					const loaded = yield* load_pack(db, manifest, source, '2026-11-23T00:00:00Z');
					expect(loaded).toBe(true);

					const [ord] = yield* db.read([
						{ text: 'SELECT revision, total, line_count FROM orders WHERE id = $1', params: [orderId] }
					]);
					const [sr] = yield* db.read([
						{ text: 'SELECT acked_revision FROM sys_sync_row WHERE id = $1', params: [syncRowId] }
					]);
					const rev = Number(ord?.rows[0]?.['revision']);
					const acked = Number(sr?.rows[0]?.['acked_revision']);
					expect(ord?.rows[0]?.['total']).toBe('125.50');
					expect(Number(ord?.rows[0]?.['line_count'])).toBe(1);
					expect(rev).toBeGreaterThanOrEqual(2);
					expect(acked).toBe(rev);

					// Syncs.test must succeed even though sys_integration.active is false (paused)
					let pinged = 0;
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							guest: yield* program(guestSource),
							db: Layer.succeed(TenantDb, db),
							now: '2026-11-23T00:00:00.000Z'
						})
					);
					const t = Context.get(context, TestWorkspace);
					t.fakes.links.answer = () => {
						pinged++;
						return Effect.succeed({ status: 200, body: { ok: true } });
					};
					const syncs = Context.get(context, Syncs);
					yield* syncs.test('erp');
					expect(pinged).toBe(1);
				})
			)
	);
});
