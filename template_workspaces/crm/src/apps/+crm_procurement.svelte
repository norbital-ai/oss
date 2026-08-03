<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const dashboard = client.invoke.procurement_dashboard({});

	function payableStatusBadge(status: string): string {
		const map: Record<string, string> = {
			paid: 'bg-green-100 text-green-700',
			partial: 'bg-amber-100 text-amber-700',
			unpaid: 'bg-red-100 text-red-700',
			empty: 'bg-gray-100 text-gray-600'
		};
		return map[status] ?? 'bg-gray-100 text-gray-600';
	}
</script>

<svelte:head>
	<title>Procurement</title>
	<meta
		name="description"
		content="Purchase orders, suppliers, warehouses, stock, and outgoing payments"
	/>
	<meta name="pod:icon" content="lucide:shopping-cart" />
</svelte:head>

{#snippet purchaseOrders()}
	<CollectionTable
		{client}
		collection="purchase_orders"
		title="Purchase orders"
		description="Buying documents from draft through receipt. Track supplier, currency, and expected delivery."
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column name="status" card="badge" />
			<Column name="supplier_name" label="Supplier" minWidth={200} card="title" />
			<Column name="currency" card="badge" />
			<Column name="expected_date" label="Expected" />
			<Column name="gross" label="Gross amount" />
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
			<Column name="purchase_order_id" label="Purchase order" minWidth={200} card="title" />
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
		description="Vendors you buy from. Currency and payment terms flow into new purchase orders."
		query={{ orderBy: { name: 'asc' } }}
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

{#snippet warehouses()}
	<CollectionTable
		{client}
		collection="warehouses"
		title="Warehouses"
		description="Physical stock locations that purchase orders and fulfilment can route to."
		query={{ orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={120} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="address" minWidth={200} />
			<Column name="phone" />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet stockLevels()}
	<CollectionTable
		{client}
		collection="stock_levels"
		title="Stock levels"
		description="Company-wide quantity and cost per product. Costs are visible only to procurement roles."
		query={{ orderBy: { product_id: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="product_id" label="Product" minWidth={240} card="title" />
			<Column name="qty_on_hand" label="On hand" />
			<Column name="stock_unit" label="Unit" />
			<Column name="unit_cost" label="Unit cost" />
			<Column name="qty_as_of" label="Qty as of" />
			<Column name="cost_as_of" label="Cost as of" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet stockLots()}
	<CollectionTable
		{client}
		collection="stock_lots"
		title="Stock lots"
		description="Quantity held in identifiable lots at each warehouse, without exposing cost."
		query={{ orderBy: { lot_no: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="lot_no" label="Lot" minWidth={140} card="badge" />
			<Column name="product_id" label="Product" minWidth={200} card="title" />
			<Column name="warehouse_id" label="Warehouse" minWidth={180} />
			<Column name="quantity" />
			<Column name="unit" />
			<Column name="sellable" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet outgoingPayments()}
	<CollectionTable
		{client}
		collection="payment_records"
		view="procurement_outgoing_payments"
		title="Outgoing payments"
		description="Payments made against submitted purchase orders."
		query={{
			where: { direction: { eq: 'outgoing' } },
			orderBy: { payment_date: 'desc' }
		}}
	>
		{#snippet columns({ Column })}
			<Column name="purchase_order_id" label="Purchase order" minWidth={200} card="title" />
			<Column name="amount" label="Amount" />
			<Column name="payment_date" label="Date" />
			<Column name="method" card="badge" />
			<Column name="reference" minWidth={160} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet procurementDashboard()}
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
					<p class="text-2xl font-semibold tabular-nums">
						{row.total.toLocaleString()}
					</p>
				</div>
			{/each}
		</Grid>

		{#if (dashboard.current?.low_stock ?? []).length > 0}
			<Stack gap="sm">
				<div>
					<h3 class="text-sm font-semibold">Low stock</h3>
					<p class="text-xs text-muted-foreground">
						Products with zero or negative quantity on hand.
					</p>
				</div>
				<table class="w-full rounded-lg border text-sm">
					<thead>
						<tr class="border-b bg-muted/50">
							<th class="px-4 py-2 text-left font-medium">Code</th>
							<th class="px-4 py-2 text-left font-medium">Product</th>
							<th class="px-4 py-2 text-right font-medium">On hand</th>
						</tr>
					</thead>
					<tbody>
						{#each dashboard.current?.low_stock ?? [] as item (item.product_id)}
							<tr class="border-b last:border-0">
								<td class="px-4 py-2 font-medium">{item.product_code}</td>
								<td class="px-4 py-2">{item.product_name}</td>
								<td class="px-4 py-2 text-right tabular-nums text-amber-600">
									{item.qty_on_hand.toLocaleString()}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</Stack>
		{/if}

		<Stack gap="sm">
			<div>
				<h3 class="text-sm font-semibold">Outstanding payables</h3>
				<p class="text-xs text-muted-foreground">
					Purchase order gross minus outgoing payments, per order.
				</p>
			</div>
			<table class="w-full rounded-lg border text-sm">
				<thead>
					<tr class="border-b bg-muted/50">
						<th class="px-4 py-2 text-left font-medium">Order</th>
						<th class="px-4 py-2 text-left font-medium">Currency</th>
						<th class="px-4 py-2 text-right font-medium">Committed</th>
						<th class="px-4 py-2 text-right font-medium">Paid</th>
						<th class="px-4 py-2 text-right font-medium">Outstanding</th>
						<th class="px-4 py-2 text-left font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{#each dashboard.current?.payables ?? [] as payable (payable.id)}
						<tr class="border-b last:border-0">
							<td class="px-4 py-2 font-medium">{payable.doc_no}</td>
							<td class="px-4 py-2">{payable.currency}</td>
							<td class="px-4 py-2 text-right tabular-nums">{payable.gross.toLocaleString()}</td>
							<td class="px-4 py-2 text-right tabular-nums">{payable.paid.toLocaleString()}</td>
							<td class="px-4 py-2 text-right tabular-nums"
								>{payable.outstanding.toLocaleString()}</td
							>
							<td class="px-4 py-2">
								<span
									class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {payableStatusBadge(
										payable.status
									)}"
								>
									{payable.status}
								</span>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Stack>
	</Stack>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Procurement"
		title="Buying workspace"
		description="Manage suppliers, purchase orders, stock, and outgoing payments."
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
				content: procurementDashboard
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
			{ name: 'suppliers', label: 'Suppliers', icon: 'lucide:truck', content: suppliers },
			{ name: 'warehouses', label: 'Warehouses', icon: 'lucide:warehouse', content: warehouses },
			{
				name: 'stock-levels',
				label: 'Stock levels',
				icon: 'lucide:layers',
				content: stockLevels
			},
			{ name: 'stock-lots', label: 'Stock lots', icon: 'lucide:boxes', content: stockLots },
			{
				name: 'payments',
				label: 'Outgoing payments',
				icon: 'lucide:banknote',
				content: outgoingPayments
			}
		] satisfies TabConfig[]}
	/>
</Cover>
