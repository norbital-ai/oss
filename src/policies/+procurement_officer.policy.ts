import type { Policy } from './$types.js';

/**
 * A procurement officer: suppliers, buying documents, and their lines.
 *
 * The buy side is granted here and withheld from the sales representative policy. Pod policies are
 * collection-scoped, so buy cost stays off the sales surface by absence of grants rather than by
 * column-level masking: `purchase_order_lines` carries the unit cost, and sales has no grant for it.
 *
 * The boundary runs the other way too: there is no quote grant here, so a procurement officer never
 * sees the sell prices or margin of the sales pipeline. The shared product catalogue grants read to
 * both roles — it carries sell prices only, never cost.
 */
export default {
	name: 'Procurement officer',
	description:
		'Manages suppliers, purchase orders, and their lines. Does not access the sales pipeline app.',
	apps: ['crm_purchase'],
	grants: [
		{ collection: 'products', action: 'read' },

		{ collection: 'suppliers', action: 'read' },
		{ collection: 'suppliers', action: 'create' },
		{ collection: 'suppliers', action: 'update' },

		{ collection: 'purchase_orders', action: 'read' },
		{ collection: 'purchase_orders', action: 'create' },
		{ collection: 'purchase_orders', action: 'update' },

		{ collection: 'purchase_order_lines', action: 'read' },
		{ collection: 'purchase_order_lines', action: 'create' },
		{ collection: 'purchase_order_lines', action: 'update' },
		{ collection: 'purchase_order_lines', action: 'delete' }
	]
} satisfies Policy;
