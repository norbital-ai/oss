<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const revenue = client.invoke.revenue_summary({});

	function paymentStatusBadge(status: string): string {
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
	<title>CRM Operations</title>
	<meta
		name="description"
		content="Order fulfilment, payment tracking, revenue summary, and team activities"
	/>
	<meta name="pod:icon" content="lucide:settings-2" />
</svelte:head>

{#snippet orders()}
	<CollectionTable
		{client}
		collection="quotes"
		title="Orders & fulfilment"
		description="Confirmed and fulfilled orders. Track payment status and manage fulfilment."
		query={{
			where: { status: { in: ['confirmed', 'fulfilled', 'won'] } },
			orderBy: { confirmed_at: 'desc' }
		}}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column name="title" minWidth={240} card="title" />
			<Column name="status" card="badge" />
			<Column name="gross" label="Gross amount" />
			<Column name="currency" />
			<Column name="confirmed_at" label="Confirmed" />
			<Column name="fulfilled_at" label="Fulfilled" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet payments()}
	<CollectionTable
		{client}
		collection="payment_records"
		title="Payments"
		description="Payments received against confirmed and fulfilled orders."
		query={{ orderBy: { payment_date: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="quote_id" label="Order" minWidth={200} card="title" />
			<Column name="amount" label="Amount" />
			<Column name="payment_date" label="Date" />
			<Column name="method" card="badge" />
			<Column name="reference" minWidth={160} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet activities()}
	<CollectionTable
		{client}
		collection="activities"
		title="Activities"
		description="Calls, meetings, emails, tasks, and notes across all accounts, deals, and projects."
		query={{ orderBy: { due_date: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="subject" minWidth={280} card="title" />
			<Column name="type" card="badge" />
			<Column name="regarding_type" label="Regarding" />
			<Column name="due_date" label="Due" />
			<Column name="completed_at" label="Completed" />
			<Column name="owner_id" label="Owner" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet quoteLines()}
	<CollectionTable
		{client}
		collection="quote_lines"
		title="Quote lines"
		description="Line items across all quotes."
		query={{ orderBy: { quote_id: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="quote_id" label="Quote" minWidth={200} card="title" />
			<Column name="product_code" label="Code" minWidth={100} />
			<Column name="product_name" label="Product" minWidth={200} />
			<Column name="quantity" />
			<Column name="unit_price" label="Unit price" />
			<Column name="discount_pct" label="Discount %" />
			<Column name="line_total" label="Total" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet revenueSummary()}
	<Stack gap="lg">
		<Grid minimum="card">
			<div class="rounded-lg border bg-card p-4">
				<p class="text-sm text-muted-foreground">Total invoiced</p>
				<p class="text-2xl font-semibold tabular-nums">
					{revenue.current?.total_invoiced?.toLocaleString() ?? '—'}
				</p>
			</div>
			<div class="rounded-lg border bg-card p-4">
				<p class="text-sm text-muted-foreground">Total paid</p>
				<p class="text-2xl font-semibold tabular-nums text-green-600">
					{revenue.current?.total_paid?.toLocaleString() ?? '—'}
				</p>
			</div>
			<div class="rounded-lg border bg-card p-4">
				<p class="text-sm text-muted-foreground">Outstanding</p>
				<p class="text-2xl font-semibold tabular-nums text-amber-600">
					{revenue.current?.outstanding?.toLocaleString() ?? '—'}
				</p>
			</div>
		</Grid>
		<table class="w-full rounded-lg border text-sm">
			<thead>
				<tr class="border-b bg-muted/50">
					<th class="px-4 py-2 text-left font-medium">Order</th>
					<th class="px-4 py-2 text-left font-medium">Currency</th>
					<th class="px-4 py-2 text-right font-medium">Invoiced</th>
					<th class="px-4 py-2 text-right font-medium">Paid</th>
					<th class="px-4 py-2 text-left font-medium">Status</th>
				</tr>
			</thead>
			<tbody>
				{#each revenue.current?.orders ?? [] as order (order.id)}
					<tr class="border-b last:border-0">
						<td class="px-4 py-2 font-medium">{order.doc_no}</td>
						<td class="px-4 py-2">{order.currency}</td>
						<td class="px-4 py-2 text-right tabular-nums">{order.gross.toLocaleString()}</td>
						<td class="px-4 py-2 text-right tabular-nums">{order.paid.toLocaleString()}</td>
						<td class="px-4 py-2">
							<span
								class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {paymentStatusBadge(
									order.status
								)}"
							>
								{order.status}
							</span>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</Stack>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="CRM Operations"
		title="Order management"
		description="Review confirmed orders, track payments, monitor revenue, and manage team activities."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{ name: 'orders', label: 'Orders', icon: 'lucide:receipt', content: orders },
			{ name: 'revenue', label: 'Revenue', icon: 'lucide:bar-chart-3', content: revenueSummary },
			{ name: 'payments', label: 'Payments', icon: 'lucide:banknote', content: payments },
			{
				name: 'quote-lines',
				label: 'Quote lines',
				icon: 'lucide:list-checks',
				content: quoteLines
			},
			{
				name: 'activities',
				label: 'Activities',
				icon: 'lucide:calendar-check',
				content: activities
			}
		] satisfies TabConfig[]}
	/>
</Cover>
