// A catalogue workspace: crm's ERP item import and a CSV export as pipelines over `products`, a `sales` writer and a
// `viewer` reader; a suite that needs a plain workspace with a few policies boots it.
import { Result } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';

export const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			products: {
				description: 'A product',
				label: 'name',
				key: ['external_code'],
				fields: {
					external_code: { kind: 'text' },
					name: { kind: 'text' },
					price: { kind: 'decimal', scale: 2, optional: true }
				}
			}
		},
		relationships: {},
		collections: {
			products: {
				read: { fields: 'all' },
				create: { input: { columns: ['external_code', 'name', 'price'] } },
				update: { input: { columns: ['name', 'price'] } }
			}
		},
		integrations: {},
		pipelines: {
			products: {
				import: {
					description: 'Mirrors the ERP item feed, skipping codes already on file.',
					known: true,
					onConflict: 'keep',
					input: {
						items: {
							kind: 'list',
							of: {
								kind: 'object',
								fields: {
									external_code: { kind: 'text' },
									name: { kind: 'text' },
									unit_price: { kind: 'decimal', optional: true }
								}
							}
						}
					}
				},
				export: {
					description: 'The catalogue as CSV.',
					select: ['external_code', 'name', 'price'],
					format: 'csv'
				}
			}
		},
		policies: {
			viewer: { description: 'Reads the catalogue', grants: { products: { read: true } } },
			integration: { description: 'Holds no catalogue grant', grants: {} },
			sales: {
				description: 'Sales',
				grants: { products: { read: true, create: true, update: true } }
			}
		},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

/** `guest.mjs` for crm's item import. */
export const guestSource = `
export default {
	pipeline: { products: { spec: { import: {
		records: (input) => input.items.map((i) => ({ ...i, external_code: i.external_code.trim(), name: i.name.trim() })),
		// ponytail: { in: codes } binds a list the PGlite adapter cannot pass (query/sql.ts 'in'); filtered here until it can
		known: function* (ctx, items) { return Object.fromEntries((yield* ctx.read('products', { all: true })).rows.filter((r) => items.some((i) => i.external_code === r.external_code)).map((r) => [r.external_code, r])); },
		map: (item, { known }) => known[item.external_code] ? null : { external_code: item.external_code, name: item.name, price: item.unit_price ?? null },
	} } } },
};`;
