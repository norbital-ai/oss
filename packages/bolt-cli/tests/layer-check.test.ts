// P2 compile gates (`bolt check` rules `model/layer`, `access/layer`): a layer map's paths resolve through declared
// relations, at most `LAYER_MAX_DEPTH` deep, each with its parent; write layers are many-relations; a policy names only
// the outputs, paths and columns its model declares. A mistyped `check` argument is the type corpus's gate
// (`tests/types/policy-layers.ts`).
import { describe, expect, it } from 'vitest';
import { checkRules } from '../src/compiler/check/rules.ts';
import { LAYER_MAX_DEPTH } from '../../bolt/src/decl/model.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';

const base: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		nodes: {
			description: 'A tree node',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		orders: {
			description: 'An order',
			record_label: 'record.number',
			fields: { number: { kind: 'text' }, total: { kind: 'sum', of: 'lines.amount' } }
		},
		order_lines: {
			description: 'A line',
			record_label: 'record.product',
			fields: { product: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		parties: {
			description: 'A party',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, credit_limit: { kind: 'decimal', scale: 2 } }
		},
		notes: {
			description: 'A note',
			record_label: 'record.body',
			fields: { body: { kind: 'text' } }
		}
	},
	relationships: {
		'nodes.parent': { to: 'nodes', inverse: 'children', optional: true },
		'orders.party': { to: 'parties', inverse: 'orders' },
		'order_lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'notes.about': { to: ['orders', 'parties'], inverse: 'notes' }
	},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const findings = (over: Partial<EngineManifest>) =>
	checkRules({ ...base, ...over }, { automations: [] }, (_role, name) => name)
		.filter((f) => f.code === 'model/layer' || f.code === 'access/layer')
		.map((f) => `${f.code} ${f.message}`);
const present = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing fixture part');
	return value;
};
const orders: EngineManifest['exposures'][string] = {
	outputs: {
		default: {
			orders: { fields: ['number', 'total', 'party'] },
			'orders.party': { fields: ['name', 'credit_limit'] },
			'orders.lines': { fields: 'all' }
		},
		logistics: { orders: { fields: ['number'] }, 'orders.lines': { fields: ['product'] } }
	},
	create: { columns: { orders: ['number', 'party'], 'orders.lines': ['product', 'amount'] } },
	update: { columns: { orders: ['number'], 'orders.lines': ['amount'] } }
};

describe('layer maps at compile time (bolt check)', () => {
	it('accepts a declared tree and a policy that filters its outputs; a model without read is a layer, never a root', () => {
		expect(
			findings({
				exposures: { orders },
				policies: {
					rep: {
						description: 'Rep',
						grants: {
							orders: {
								outputs: {
									default: {
										scopes: {
											orders: { number: { ne: '' } },
											'orders.lines': { amount: { gt: 0 } }
										}
									},
									logistics: { scopes: { 'orders.lines': { product: { ne: '' } } } }
								},
								create: {
									columns: { orders: ['number'], 'orders.lines': ['product'] },
									verdict: true
								},
								update: { verdict: true }
							}
						}
					}
				}
			})
		).toEqual([]);
	});

	it(`refuses a ${LAYER_MAX_DEPTH + 1}th level and a path without its parent`, () => {
		const deep = Array.from({ length: LAYER_MAX_DEPTH + 1 }, (_, i) =>
			['nodes', ...Array.from({ length: i }, () => 'parent')].join('.')
		);
		const sixth = present(deep.at(-1));
		expect(sixth.split('.')).toHaveLength(LAYER_MAX_DEPTH + 1);
		expect(
			findings({
				exposures: {
					nodes: {
						outputs: { default: Object.fromEntries(deep.map((path) => [path, { fields: 'all' }])) }
					}
				}
			})
		).toEqual([
			`model/layer nodes: outputs.default: '${sixth}' is deeper than ${LAYER_MAX_DEPTH} levels`
		]);
		// the fifth level is the deepest a map may declare
		expect(
			findings({
				exposures: {
					nodes: {
						outputs: {
							default: Object.fromEntries(
								deep.slice(0, -1).map((path) => [path, { fields: 'all' }])
							)
						}
					}
				}
			})
		).toEqual([]);
		expect(
			findings({
				exposures: {
					nodes: {
						outputs: {
							default: { nodes: { fields: 'all' }, 'nodes.parent.parent': { fields: 'all' } }
						}
					}
				}
			})
		).toEqual([
			`model/layer nodes: outputs.default: 'nodes.parent.parent' needs its parent layer 'nodes.parent'`
		]);
	});

	it('refuses an undeclared relation, an arc, a ref as a write layer, the parent FK and an unknown field', () => {
		const found = findings({
			exposures: {
				orders: {
					outputs: {
						default: {
							orders: { fields: ['number', 'nope'] },
							'orders.customer': { fields: 'all' },
							'orders.notes': { fields: 'all' },
							'orders.notes.about': { fields: 'all' }
						}
					},
					create: {
						columns: {
							orders: ['number', 'total'],
							'orders.party': ['name'],
							'orders.lines': ['order', 'product']
						}
					}
				}
			}
		});
		expect(found).toEqual(
			expect.arrayContaining([
				"model/layer orders: outputs.default: orders.customer: 'customer' is no relation of orders",
				"model/layer orders: outputs.default: orders.notes.about: 'about' is an arc (a ref to several models) and cannot be a layer",
				"model/layer orders: create: 'orders.party' is a ref; a write layer is a many-relation (its child rows)",
				"model/layer orders: outputs.default: 'nope' is no field of orders (orders)",
				"model/layer orders: create: 'total' is no writable column of orders (orders)",
				"model/layer orders: create: orders.lines lists 'order', the key the engine sets from its parent row"
			])
		);
	});

	it('refuses a named output field the model lacks', () => {
		expect(
			findings({
				exposures: {
					orders: {
						...orders,
						outputs: {
							default: { orders: { fields: ['number'] } },
							narrow: { orders: { fields: ['nope'] } }
						}
					}
				}
			})
		).toEqual(["model/layer orders: outputs.narrow: 'nope' is no field of orders (orders)"]);
	});

	it('refuses a policy output, path or column the model does not declare, and a verb the model lacks', () => {
		expect(
			findings({
				exposures: {
					orders: { outputs: orders.outputs, create: present(orders.create) }
				},
				policies: {
					rep: {
						description: 'Rep',
						grants: {
							orders: {
								outputs: {
									default: { scopes: { orders: {}, 'orders.party.orders': {} } },
									logistics: { scopes: { 'orders.party': {} } },
									wholesale: {}
								},
								create: { columns: { orders: ['number', 'total'], 'orders.notes': ['body'] } },
								update: {}
							}
						}
					}
				}
			})
		).toEqual([
			"access/layer rep: orders: outputs.default names 'orders.party.orders', which that output does not declare as a read layer",
			"access/layer rep: orders: outputs.logistics names 'orders.party', which that output does not declare as a read layer",
			"access/layer rep: orders: grants output 'wholesale', which orders does not declare",
			"access/layer rep: orders: create orders admits 'total', which orders's create does not declare there",
			"access/layer rep: orders: create names 'orders.notes', which orders's create does not declare",
			'access/layer rep: orders: an update grant, but orders declares no update'
		]);
	});
});
