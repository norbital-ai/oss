import type { Policy } from './$types.js';

/**
 * A procurement officer: suppliers, buying documents, stock, and outgoing payments.
 *
 * Cost-bearing collections are granted here and withheld from the sales representative policy.
 * Pod policies are collection-scoped, so buy-side cost stays off the sales surface by absence
 * of grants rather than column-level masking.
 *
 * The same boundary runs the other way, which is why there is no invoice grant below. This role is
 * scoped to money leaving the business — `payment_records` is narrowed to `direction = 'outgoing'`
 * for exactly that reason — and an invoice is a receivable carrying the sell price of every deal.
 * Granting it would hand the buy side the customer pricing that the sales/procurement split exists
 * to keep apart. The omission is the boundary, not an oversight.
 */
export default {
	name: 'Procurement officer',
	description:
		'Manages suppliers, purchase orders, warehouses, stock, and outgoing payments. Does not access the sales pipeline app.',
	apps: ['crm_procurement'],
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
		{ collection: 'purchase_order_lines', action: 'delete' },

		{ collection: 'warehouses', action: 'read' },
		{ collection: 'warehouses', action: 'create' },
		{ collection: 'warehouses', action: 'update' },

		{ collection: 'stock_levels', action: 'read' },
		{ collection: 'stock_levels', action: 'create' },
		{ collection: 'stock_levels', action: 'update' },

		{ collection: 'stock_lots', action: 'read' },
		{ collection: 'stock_lots', action: 'create' },
		{ collection: 'stock_lots', action: 'update' },

		{ collection: 'pricing_settings', action: 'read' },
		{ collection: 'pricing_settings', action: 'update' },

		{
			collection: 'payment_records',
			action: 'read',
			where: { direction: { eq: 'outgoing' } }
		},
		{
			collection: 'payment_records',
			action: 'create',
			where: { direction: { eq: 'outgoing' } }
		},
		{
			collection: 'payment_records',
			action: 'update',
			where: { direction: { eq: 'outgoing' } }
		}
	]
} satisfies Policy;
