// A catalogue workspace: an ERP item file import and a CSV catalogue export as product syncs, a `sales` writer and a
// `viewer` reader; a suite that needs a plain workspace with a few policies boots it.
import { Result } from 'effect';
import { decode_projected_manifest } from '../src/engine/manifest.ts';

export const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			products: {
				description: 'A product',
				record_label: 'record.name',
				key: ['external_code'],
				unique: [{ fields: ['external_code'], name: 'one_external_code', import_key: true }],
				fields: {
					external_code: { kind: 'text' },
					name: { kind: 'text' },
					price: { kind: 'decimal', scale: 2, optional: true }
				}
			}
		},
		relationships: {},
		exposures: {
			products: {
				outputs: { default: { products: { fields: 'all' } } },
				create: { columns: { products: ['external_code', 'name', 'price'] } },
				update: { columns: { products: ['name', 'price'] } },
				syncs: {
					erp: {
						with: 'file',
						parser: ['json'],
						schema: {
							external_code: { kind: 'text' },
							name: { kind: 'text' },
							unit_price: { kind: 'decimal', scale: 2, optional: true }
						},
						read: true
					},
					catalogue: {
						with: 'file',
						parser: ['csv'],
						schema: {
							external_code: { kind: 'text' },
							name: { kind: 'text' },
							price: { kind: 'decimal', scale: 2, optional: true }
						}
					}
				}
			}
		},
		integrations: {},
		policies: {
			viewer: {
				description: 'Reads the catalogue',
				grants: { products: { outputs: { default: {} } } }
			},
			integration: { description: 'Holds no catalogue grant', grants: {} },
			sales: {
				description: 'Sales',
				grants: { products: { outputs: { default: {} }, create: {}, update: {} } }
			}
		},
		teams: {},
		automations: {},
		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);

/** `guest.mjs` for ERP items, skipping product codes already on file. */
export const guest_source = `
export default {
	model: { products: { bodies: { syncs: { erp: {
		read: function* ({ records }, ctx) {
			if (records.length === 0) return { rows: [] };
			const items = records.map((item) => ({ ...item, external_code: item.external_code.trim(), name: item.name.trim() }));
			const page = yield* ctx.query({ products: { where: { external_code: { in: items.map((item) => item.external_code) } } } });
			const known = new Set(page.products.rows.map((row) => row.external_code));
			return { rows: items.flatMap((item) => known.has(item.external_code) ? [] : [{ external_code: item.external_code, name: item.name, price: item.unit_price ?? null }]) };
		}
	} } } } },
};`;
