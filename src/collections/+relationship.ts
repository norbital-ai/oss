import type { Relationships } from './$types.js';

export default ((r) => ({
	accounts: {
		account_contacts: r.many.contacts(),
		account_quotes: r.many.quotes(),
		account_projects: r.many.projects(),
		account_customer_prices: r.many.customer_prices()
	},
	contacts: {
		contact_account: r.one.accounts({
			from: r.contacts.account_id,
			to: r.accounts.norbital_id
		}),
		contact_quotes: r.many.quotes()
	},
	products: {
		product_quote_lines: r.many.quote_lines(),
		product_customer_prices: r.many.customer_prices()
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
		quote_payments: r.many.payment_records(),
		quote_project: r.one.projects({
			from: r.quotes.project_id,
			to: r.projects.norbital_id
		}),
		quote_revision_of: r.one.quotes({
			from: r.quotes.revision_of,
			to: r.quotes.norbital_id
		})
	},
	quote_lines: {
		quote_line_quote: r.one.quotes({
			from: r.quote_lines.quote_id,
			to: r.quotes.norbital_id
		}),
		quote_line_product: r.one.products({
			from: r.quote_lines.product_id,
			to: r.products.norbital_id
		})
	},
	payment_records: {
		payment_quote: r.one.quotes({
			from: r.payment_records.quote_id,
			to: r.quotes.norbital_id
		})
	},
	projects: {
		project_account: r.one.accounts({
			from: r.projects.account_id,
			to: r.accounts.norbital_id
		}),
		project_owner: r.one.user({
			from: r.projects.owner_id,
			to: r.user.norbital_id
		}),
		project_quotes: r.many.quotes()
	},
	customer_prices: {
		customer_price_account: r.one.accounts({
			from: r.customer_prices.account_id,
			to: r.accounts.norbital_id
		}),
		customer_price_product: r.one.products({
			from: r.customer_prices.product_id,
			to: r.products.norbital_id
		})
	},
	activities: {
		activity_owner: r.one.user({
			from: r.activities.owner_id,
			to: r.user.norbital_id
		})
	}
})) satisfies Relationships;
