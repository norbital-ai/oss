import { cascade } from '@norbital-ai/pod/authoring';
import type { Relationships } from './$types.js';

export default ((r) => ({
	accounts: {
		account_contacts: r.many.contacts(),
		account_quotes: r.many.quotes(),
		account_projects: r.many.projects(),
		account_customer_prices: r.many.customer_prices(),
		account_invoices: r.many.invoices()
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
		product_customer_prices: r.many.customer_prices(),
		product_purchase_order_lines: r.many.purchase_order_lines(),
		product_invoice_lines: r.many.invoice_lines(),
		product_stock_levels: r.many.stock_levels(),
		product_stock_lots: r.many.stock_lots()
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
		quote_invoices: r.many.invoices(),
		quote_project: r.one.projects({
			from: r.quotes.project_id,
			to: r.projects.norbital_id
		}),
		quote_revision_of: r.one.quotes({
			from: r.quotes.revision_of,
			to: r.quotes.norbital_id
		}),
		quote_warehouse: r.one.warehouses({
			from: r.quotes.warehouse_id,
			to: r.warehouses.norbital_id
		}),
		quote_logistics_owner: r.one.user({
			from: r.quotes.logistics_owner_id,
			to: r.user.norbital_id
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
		}),
		quote_line_invoice_lines: r.many.invoice_lines()
	},
	payment_records: {
		payment_quote: r.one.quotes({
			from: r.payment_records.quote_id,
			to: r.quotes.norbital_id
		}),
		payment_purchase_order: r.one.purchase_orders({
			from: r.payment_records.purchase_order_id,
			to: r.purchase_orders.norbital_id
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
	},
	suppliers: {
		supplier_purchase_orders: r.many.purchase_orders()
	},
	warehouses: {
		warehouse_quotes: r.many.quotes(),
		warehouse_purchase_orders: r.many.purchase_orders(),
		warehouse_stock_lots: r.many.stock_lots()
	},
	purchase_orders: {
		purchase_order_supplier: r.one.suppliers({
			from: r.purchase_orders.supplier_id,
			to: r.suppliers.norbital_id
		}),
		purchase_order_warehouse: r.one.warehouses({
			from: r.purchase_orders.warehouse_id,
			to: r.warehouses.norbital_id
		}),
		purchase_order_owner: r.one.user({
			from: r.purchase_orders.owner_id,
			to: r.user.norbital_id
		}),
		purchase_order_lines_rel: r.many.purchase_order_lines(),
		purchase_order_payments: r.many.payment_records()
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
	},
	invoices: {
		invoice_quote: r.one.quotes({
			from: r.invoices.quote_id,
			to: r.quotes.norbital_id
		}),
		invoice_account: r.one.accounts({
			from: r.invoices.account_id,
			to: r.accounts.norbital_id
		}),
		invoice_owner: r.one.user({
			from: r.invoices.owner_id,
			to: r.user.norbital_id
		}),
		invoice_lines_rel: r.many.invoice_lines()
	},
	invoice_lines: {
		invoice_line_invoice: cascade(
			r.one.invoices({
				from: r.invoice_lines.invoice_id,
				to: r.invoices.norbital_id
			})
		),
		invoice_line_quote_line: r.one.quote_lines({
			from: r.invoice_lines.quote_line_id,
			to: r.quote_lines.norbital_id
		}),
		invoice_line_product: r.one.products({
			from: r.invoice_lines.product_id,
			to: r.products.norbital_id
		})
	},
	stock_levels: {
		stock_level_product: r.one.products({
			from: r.stock_levels.product_id,
			to: r.products.norbital_id
		})
	},
	stock_lots: {
		stock_lot_product: r.one.products({
			from: r.stock_lots.product_id,
			to: r.products.norbital_id
		}),
		stock_lot_warehouse: r.one.warehouses({
			from: r.stock_lots.warehouse_id,
			to: r.warehouses.norbital_id
		})
	}
})) satisfies Relationships;
