<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	const dashboard = client.invoke.procurement_dashboard({});

	const usersQuery = client.db.user.findMany({
		columns: { norbital_id: true, name: true },
		orderBy: { name: 'asc' }
	});
	const userLabelsById = $derived(
		new Map((usersQuery.current ?? []).map((user) => [user.norbital_id, user.name]))
	);
	const purchaseOrdersQuery = client.db.purchase_orders.findMany({
		columns: { norbital_id: true, doc_no: true },
		orderBy: { doc_no: 'desc' },
		limit: 5000
	});
	const purchaseOrderLabelsById = $derived(
		new Map((purchaseOrdersQuery.current ?? []).map((order) => [order.norbital_id, order.doc_no]))
	);

	const receiptsQuery = client.db.goods_receipts.findMany({
		columns: { norbital_id: true, doc_no: true },
		orderBy: { doc_no: 'desc' },
		limit: 5000
	});
	const receiptLabelsById = $derived(
		new Map((receiptsQuery.current ?? []).map((receipt) => [receipt.norbital_id, receipt.doc_no]))
	);
	const receiptIds = $derived((receiptsQuery.current ?? []).map((receipt) => receipt.norbital_id));

	const purchaseInvoicesQuery = client.db.purchase_invoices.findMany({
		columns: { norbital_id: true, doc_no: true },
		orderBy: { doc_no: 'desc' },
		limit: 5000
	});
	const purchaseInvoiceLabelsById = $derived(
		new Map(
			(purchaseInvoicesQuery.current ?? []).map((invoice) => [invoice.norbital_id, invoice.doc_no])
		)
	);
	const purchaseInvoiceIds = $derived(
		(purchaseInvoicesQuery.current ?? []).map((invoice) => invoice.norbital_id)
	);

	const orderLinesQuery = client.db.purchase_order_lines.findMany({
		columns: { norbital_id: true, product_name: true, quantity: true },
		orderBy: { product_name: 'asc' },
		limit: 5000
	});
	const orderLineLabelsById = $derived(
		new Map(
			(orderLinesQuery.current ?? []).map((line) => [
				line.norbital_id,
				line.quantity != null
					? `${line.product_name} × ${line.quantity}`
					: String(line.product_name)
			])
		)
	);

	const { t } = useI18n<TenantI18nKeys>();
</script>

<svelte:head>
	<title>Purchasing workspace</title>
	<meta
		name="description"
		content="Purchase orders, suppliers, and the buying side of the product catalogue"
	/>
	<meta name="pod:icon" content="lucide:shopping-cart" />
</svelte:head>

{#snippet dashboardTab()}
	<Stack gap="lg">
		<Grid minimum="card">
			{#each Object.entries(dashboard.current?.status_counts ?? {}) as [status, count] (status)}
				<div class="rounded-lg border bg-card p-4">
					<p class="text-sm text-muted-foreground capitalize">{status.replace('_', ' ')}</p>
					<p class="text-2xl font-semibold tabular-nums">{count}</p>
				</div>
			{/each}
		</Grid>

		<Grid minimum="card">
			{#each dashboard.current?.committed_by_currency ?? [] as row (row.currency)}
				<div class="rounded-lg border bg-card p-4">
					<p class="text-sm text-muted-foreground">
						{t('app.crm_purchase.committed_spend', { currency: row.currency })}
					</p>
					<p class="text-2xl font-semibold tabular-nums">{row.total.toLocaleString()}</p>
				</div>
			{/each}
		</Grid>

		{#if (dashboard.current?.top_suppliers ?? []).length > 0}
			<div class="divide-y rounded-lg border bg-card text-sm">
				<h3 class="border-b px-4 py-3 font-semibold">
					{t('app.crm_purchase.top_suppliers')}
				</h3>
				{#each dashboard.current?.top_suppliers ?? [] as supplier (supplier.supplier_id)}
					<Inline align="start" justify="between" gap="sm" class="px-4 py-2.5">
						<p class="min-w-0 truncate font-medium">{supplier.supplier_name}</p>
						<p class="shrink-0 tabular-nums text-muted-foreground">
							{supplier.gross.toLocaleString()}
						</p>
					</Inline>
				{/each}
			</div>
		{/if}
	</Stack>
{/snippet}

{#snippet purchaseOrders()}
	<CollectionTable
		{client}
		collection="purchase_orders"
		title={t('app.crm_purchase.tab_purchase_orders')}
		description={t('app.crm_purchase.purchase_orders_description')}
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label={t('component.doc_no')} minWidth={140} card="badge" />
			<Column name="status" card="badge" />
			<Column name="supplier_name" label={t('component.supplier')} minWidth={200} card="title" />
			<Column name="currency" card="badge" />
			<Column name="expected_date" label={t('component.expected')} />
			<Column name="gross" label={t('component.gross_amount')} />
			<Column name="confirmed_at" label={t('component.confirmed')} />
			<Column
				name="owner_id"
				label={t('component.owner')}
				render={({ value }) =>
					value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
			/>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet purchaseOrderLines()}
	<CollectionTable
		{client}
		collection="purchase_order_lines"
		title={t('app.crm_purchase.tab_po_lines')}
		description={t('app.crm_purchase.po_lines_description')}
		query={{ orderBy: { purchase_order_id: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="purchase_order_id"
				label={t('component.purchase_order')}
				minWidth={200}
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (purchaseOrderLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="product_code" label={t('component.code')} minWidth={100} />
			<Column name="product_name" label={t('component.product')} minWidth={200} />
			<Column name="quantity" />
			<Column name="unit_cost" label={t('component.unit_cost')} />
			<Column name="line_total" label={t('component.total')} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet suppliers()}
	<CollectionTable
		{client}
		collection="suppliers"
		title={t('app.crm_purchase.tab_suppliers')}
		description={t('app.crm_purchase.suppliers_description')}
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={120} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="contact" minWidth={140} />
			<Column name="category" minWidth={160} />
			<Column name="currency" card="badge" />
			<Column name="payment_terms_days" label={t('component.terms_days')} />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet goodsReceipts()}
	<CollectionTable
		{client}
		collection="goods_receipts"
		title="Goods receipts"
		description="What arrived against confirmed purchase orders. Remaining-to-receive is derived, never stored."
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column
				name="purchase_order_id"
				label="Purchase order"
				minWidth={200}
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (purchaseOrderLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="received_date" label="Received" />
			<Column
				name="owner_id"
				label="Receiver"
				render={({ value }) =>
					value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
			/>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet goodsReceiptLines()}
	{#if receiptIds.length === 0}
		<p class="text-sm text-muted-foreground">No goods receipts exist yet.</p>
	{:else}
		<CollectionTable
			{client}
			collection="goods_receipt_lines"
			title="Receipt lines"
			description="Received quantities per purchase order line."
			query={{ where: { goods_receipt_id: { in: receiptIds } } }}
		>
			{#snippet columns({ Column })}
				<Column
					name="goods_receipt_id"
					label="Receipt"
					minWidth={140}
					card="badge"
					render={({ value }) =>
						value == null || value === '' ? '—' : (receiptLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="purchase_order_line_id"
					label="Order line"
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (orderLineLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="quantity_received" label="Received" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet purchaseInvoices()}
	<CollectionTable
		{client}
		collection="purchase_invoices"
		title="Purchase invoices"
		description="Supplier invoices booked against confirmed purchase orders — the three-way match checkpoint."
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column
				name="purchase_order_id"
				label="Purchase order"
				minWidth={200}
				render={({ value }) =>
					value == null || value === '' ? '—' : (purchaseOrderLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="supplier_name" label="Supplier" minWidth={200} card="title" />
			<Column name="invoice_reference" label="Supplier #" minWidth={140} />
			<Column name="status" card="badge" />
			<Column name="gross" label="Gross amount" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet purchaseInvoiceLines()}
	{#if purchaseInvoiceIds.length === 0}
		<p class="text-sm text-muted-foreground">No purchase invoices exist yet.</p>
	{:else}
		<CollectionTable
			{client}
			collection="purchase_invoice_lines"
			title="Invoice lines"
			description="Invoiced quantities and costs per purchase order line."
			query={{ where: { purchase_invoice_id: { in: purchaseInvoiceIds } } }}
		>
			{#snippet columns({ Column })}
				<Column
					name="purchase_invoice_id"
					label="Invoice"
					minWidth={140}
					card="badge"
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (purchaseInvoiceLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="product_code" label="Code" minWidth={100} />
				<Column name="product_name" label="Product" minWidth={200} card="title" />
				<Column name="quantity" />
				<Column name="unit_cost" label="Unit cost" />
				<Column name="line_total" label="Total" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet payments()}
	<CollectionTable
		{client}
		collection="settlements"
		view="crm_purchase:payments"
		title="Payments"
		description="Settlements made against confirmed purchase orders and invoices."
		query={{
			where: {
				OR: [
					{ regarding_type: { eq: 'purchase_orders' } },
					{ regarding_type: { eq: 'purchase_invoices' } }
				]
			}
		}}
	>
		{#snippet columns({ Column })}
			<Column name="regarding_type" label="Document type" card="badge" />
			<Column
				name="regarding_id"
				label="Document"
				minWidth={200}
				card="title"
				render={({ row, value }) => {
					if (value == null || value === '') return '—';
					const map =
						row.regarding_type === 'purchase_orders'
							? purchaseOrderLabelsById
							: purchaseInvoiceLabelsById;
					return map.get(String(value)) ?? '—';
				}}
			/>
			<Column name="amount" card="badge" />
			<Column name="currency" card="badge" />
			<Column name="settled_on" label="Settled on" />
			<Column name="reference" minWidth={160} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.crm_purchase.eyebrow')}
		title={t('app.crm_purchase.title')}
		description={t('app.crm_purchase.header_description')}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'dashboard',
				label: t('app.crm_purchase.tab_dashboard'),
				icon: 'lucide:layout-dashboard',
				content: dashboardTab
			},
			{
				name: 'purchase-orders',
				label: t('app.crm_purchase.tab_purchase_orders'),
				icon: 'lucide:shopping-cart',
				content: purchaseOrders
			},
			{
				name: 'po-lines',
				label: t('app.crm_purchase.tab_po_lines'),
				icon: 'lucide:list-checks',
				content: purchaseOrderLines
			},
			{
				name: 'suppliers',
				label: t('app.crm_purchase.tab_suppliers'),
				icon: 'lucide:truck',
				content: suppliers
			},
			{
				name: 'goods-receipts',
				label: 'Goods receipts',
				icon: 'lucide:package-check',
				content: goodsReceipts
			},
			{
				name: 'receipt-lines',
				label: 'Receipt lines',
				icon: 'lucide:list-checks',
				content: goodsReceiptLines
			},
			{
				name: 'purchase-invoices',
				label: 'Purchase invoices',
				icon: 'lucide:receipt',
				content: purchaseInvoices
			},
			{
				name: 'pi-lines',
				label: 'Invoice lines',
				icon: 'lucide:list-checks',
				content: purchaseInvoiceLines
			},
			{ name: 'payments', label: 'Payments', icon: 'lucide:banknote', content: payments }
		] satisfies TabConfig[]}
	/>
</Cover>
