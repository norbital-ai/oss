import type { Policy } from './$types.js';

/**
 * A sales representative: their own pipeline, and the reference data behind it.
 *
 * Declared here rather than seeded so the permission set ships with the workspace — a fresh database
 * has it, and changing it shows up in a diff.
 *
 * Buy-side cost is withheld by omitting grants on cost-bearing collections entirely — Pod policies
 * are collection-scoped, not column-scoped. Sales reps therefore have no read path to suppliers,
 * purchase orders, purchase order lines, stock levels, pricing settings, or outgoing payments.
 * The product catalogue exposes sell prices only; stock lots deliberately carry no cost column.
 *
 * Invoices are read-only here rather than absent, because that rule does not reach them: every
 * invoice column is sell-side — the same net/tax/gross vocabulary already on the quotes a rep owns —
 * and margin needs a cost basis this policy has no grant for. Raising, issuing, and settling stay
 * with finance. The grant matters even though `crm_sales` surfaces no invoice table: the sales desk
 * channel answers under this policy, and "has my order been billed, and when is it due" is a
 * question that reaches the agent long before it reaches a screen.
 */
export default {
	name: 'Sales representative',
	description:
		'Owns their own quotes and activities; reads shared accounts, product data, and the invoices raised on their own deals.',
	apps: ['crm_sales'],
	grants: [
		{ collection: 'accounts', action: 'read' },
		{ collection: 'contacts', action: 'read' },
		{ collection: 'products', action: 'read' },
		{ collection: 'customer_prices', action: 'read' },

		// Scoped to the requestor. `${requestor.norbital_id}` is bound at evaluation time against the
		// request scope, so this reads *their* quotes rather than every quote that has an owner. The
		// column is typed against the collection's row, so renaming `owner_id` breaks this file rather
		// than silently matching nothing.
		{
			collection: 'quotes',
			action: 'read',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'quotes', action: 'create' },
		{
			collection: 'quotes',
			action: 'update',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'quote_lines', action: 'read' },
		{ collection: 'quote_lines', action: 'create' },
		{ collection: 'quote_lines', action: 'update' },
		{ collection: 'quote_lines', action: 'delete' },

		// Scoped the same way as quotes, against the invoice's own `owner_id`. Lines are unscoped
		// because they carry no owner of their own, which matches how `quote_lines` is already
		// granted: the document is what the requestor is narrowed to.
		{
			collection: 'invoices',
			action: 'read',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'invoice_lines', action: 'read' },

		{ collection: 'activities', action: 'read' },
		{ collection: 'activities', action: 'create' }
	]
} satisfies Policy;
