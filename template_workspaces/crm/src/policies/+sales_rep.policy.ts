import type { Policy } from './$types.js';

/**
 * A sales representative: their own pipeline, and the shared reference data behind it.
 *
 * Declared here rather than seeded so the permission set ships with the workspace — a fresh database
 * has it, and changing it shows up in a diff.
 *
 * Quote reads and edits are scoped to the requestor. `${requestor.norbital_id}` is bound at
 * evaluation time against the request scope, so a rep reads *their* quotes rather than every quote
 * that has an owner. The column is typed against the collection's row, so renaming `owner_id` breaks
 * this file rather than silently matching nothing.
 */
export default {
	name: 'Sales representative',
	description:
		'Owns their own quotes and activities; reads shared accounts, contacts, and the product catalogue.',
	apps: ['crm'],
	grants: [
		{ collection: 'accounts', action: 'read' },
		{ collection: 'contacts', action: 'read' },
		{ collection: 'products', action: 'read' },

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

		// Lines carry no owner of their own, so they are granted unscoped, matching how the
		// document — the thing the requestor is narrowed to — is the unit of ownership.
		{ collection: 'quote_lines', action: 'read' },
		{ collection: 'quote_lines', action: 'create' },
		{ collection: 'quote_lines', action: 'update' },
		{ collection: 'quote_lines', action: 'delete' },

		{ collection: 'activities', action: 'read' },
		{ collection: 'activities', action: 'create' },

		{
			collection: 'sales_invoices',
			action: 'read',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'sales_invoices', action: 'create' },
		{
			collection: 'sales_invoices',
			action: 'update',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},

		// Invoice lines carry no owner of their own, so they are granted unscoped, matching how
		// the document — the thing the requestor is narrowed to — is the unit of ownership.
		{ collection: 'sales_invoice_lines', action: 'read' },
		{ collection: 'sales_invoice_lines', action: 'create' },
		{ collection: 'sales_invoice_lines', action: 'update' },
		{ collection: 'sales_invoice_lines', action: 'delete' },

		{
			collection: 'contract_signings',
			action: 'read',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'contract_signings', action: 'create' },
		{
			collection: 'contract_signings',
			action: 'update',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},

		{ collection: 'settlements', action: 'read' },
		{ collection: 'settlements', action: 'create' }
	]
} satisfies Policy;
