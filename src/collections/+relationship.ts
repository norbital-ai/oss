import { cascade } from '@norbital-ai/pod/authoring';
import type { Relationships } from './$types.js';

export default ((r) => ({
	accounts: {
		account_contacts: r.many.contacts(),
		account_quotes: r.many.quotes()
	},
	contacts: {
		contact_account: r.one.accounts({
			from: r.contacts.account_id,
			to: r.accounts.norbital_id
		}),
		contact_quotes: r.many.quotes()
	},
	products: {
		product_quote_lines: r.many.quote_lines()
	},
	quotes: {
		quote_account: r.one.accounts({
			from: r.quotes.account_id,
			to: r.accounts.norbital_id
		}),
		quote_contact: r.one.contacts({
			from: r.quotes.contact_id,
			to: r.contacts.norbital_id
		}),
		quote_owner: r.one.user({
			from: r.quotes.owner_id,
			to: r.user.norbital_id
		}),
		quote_lines_rel: r.many.quote_lines(),
		quote_revision_of: r.one.quotes({
			from: r.quotes.revision_of,
			to: r.quotes.norbital_id
		})
	},
	quote_lines: {
		// A line has no meaning without its quote, so the database removes it with the quote rather
		// than leaving rows that only a cleanup script would ever find.
		quote_line_quote: cascade(
			r.one.quotes({
				from: r.quote_lines.quote_id,
				to: r.quotes.norbital_id
			})
		),
		quote_line_product: r.one.products({
			from: r.quote_lines.product_id,
			to: r.products.norbital_id
		})
	},
	activities: {
		activity_owner: r.one.user({
			from: r.activities.owner_id,
			to: r.user.norbital_id
		})
	},
	suppliers: {
		supplier_purchase_orders: r.many.purchase_orders()
	},
	purchase_orders: {
		purchase_order_supplier: r.one.suppliers({
			from: r.purchase_orders.supplier_id,
			to: r.suppliers.norbital_id
		}),
		purchase_order_owner: r.one.user({
			from: r.purchase_orders.owner_id,
			to: r.user.norbital_id
		}),
		purchase_order_lines_rel: r.many.purchase_order_lines()
	},
	purchase_order_lines: {
		// A line has no meaning without its order, so the database removes it with the order rather
		// than leaving rows that only a cleanup script would ever find.
		purchase_order_line_order: cascade(
			r.one.purchase_orders({
				from: r.purchase_order_lines.purchase_order_id,
				to: r.purchase_orders.norbital_id
			})
		),
		purchase_order_line_product: r.one.products({
			from: r.purchase_order_lines.product_id,
			to: r.products.norbital_id
		})
	}
})) satisfies Relationships;
