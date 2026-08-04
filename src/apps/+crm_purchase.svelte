<script lang="ts">
	import { client } from '$pod/client';
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
					<p class="text-sm text-muted-foreground">Committed spend ({row.currency})</p>
					<p class="text-2xl font-semibold tabular-nums">{row.total.toLocaleString()}</p>
				</div>
			{/each}
		</Grid>

		{#if (dashboard.current?.top_suppliers ?? []).length > 0}
			<div class="divide-y rounded-lg border bg-card text-sm">
				<h3 class="border-b px-4 py-3 font-semibold">Top suppliers by committed spend</h3>
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
		title="Purchase orders"
		description="Buying documents from draft through to confirmed. A confirmed order is the state the system of record books."
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column name="status" card="badge" />
			<Column name="supplier_name" label="Supplier" minWidth={200} card="title" />
			<Column name="currency" card="badge" />
			<Column name="expected_date" label="Expected" />
			<Column name="gross" label="Gross amount" />
			<Column name="confirmed_at" label="Confirmed" />
			<Column
				name="owner_id"
				label="Owner"
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
		title="Purchase order lines"
		description="Line items across all purchase orders, with product snapshots and unit costs."
		query={{ orderBy: { purchase_order_id: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column
				name="purchase_order_id"
				label="Purchase order"
				minWidth={200}
				card="title"
				render={({ value }) =>
					value == null || value === '' ? '—' : (purchaseOrderLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="product_code" label="Code" minWidth={100} />
			<Column name="product_name" label="Product" minWidth={200} />
			<Column name="quantity" />
			<Column name="unit_cost" label="Unit cost" />
			<Column name="line_total" label="Total" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet suppliers()}
	<CollectionTable
		{client}
		collection="suppliers"
		title="Suppliers"
		description="Vendors the business buys from. Currency and payment terms flow into new purchase orders."
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={120} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="category" minWidth={160} />
			<Column name="currency" card="badge" />
			<Column name="payment_terms_days" label="Terms (days)" />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="CRM"
		title="Purchasing workspace"
		description="Manage purchase orders, suppliers, and the buy side of the catalogue."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'dashboard',
				label: 'Dashboard',
				icon: 'lucide:layout-dashboard',
				content: dashboardTab
			},
			{
				name: 'purchase-orders',
				label: 'Purchase orders',
				icon: 'lucide:shopping-cart',
				content: purchaseOrders
			},
			{
				name: 'po-lines',
				label: 'PO lines',
				icon: 'lucide:list-checks',
				content: purchaseOrderLines
			},
			{ name: 'suppliers', label: 'Suppliers', icon: 'lucide:truck', content: suppliers }
		] satisfies TabConfig[]}
	/>
</Cover>
