import type { Policy } from './$types.js';

/**
 * A sales representative: their own pipeline, and the reference data behind it.
 *
 * Declared here rather than seeded so the permission set ships with the workspace — a fresh database
 * has it, and changing it shows up in a diff.
 */
export default {
	name: 'Sales representative',
	description: 'Owns their own quotes and activities; reads shared accounts and product data.',
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
		{ collection: 'activities', action: 'read' },
		{ collection: 'activities', action: 'create' }
	]
} satisfies Policy;
