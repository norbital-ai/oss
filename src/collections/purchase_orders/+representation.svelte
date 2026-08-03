<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import Icon from '@iconify/svelte';
	import { documentTotals } from '../../lib/pricing.js';

	let { record, close, refresh }: RepresentationProps = $props();

	const recordId = $derived(record?.norbital_id);
	const isDraft = $derived(record?.status === 'draft');
	let addLineOpen = $state(false);

	const linesQuery = $derived.by(() => {
		if (!recordId) return null;
		return client.db.purchase_order_lines.findMany({
			where: { purchase_order_id: { eq: recordId } },
			columns: { net: true, tax: true, line_total: true },
			limit: 500
		});
	});

	const totals = $derived.by(() => {
		const lines = linesQuery?.current ?? [];
		const currency = record?.currency;
		if (!currency || lines.length === 0) return null;
		return documentTotals(
			lines.map((line) => ({
				net: Number(line.net ?? 0),
				tax: Number(line.tax ?? 0),
				gross: Number(line.line_total ?? 0)
			})),
			currency
		);
	});
</script>

{#if !record}
	<CollectionForm {client} collection="purchase_orders" onAfterSubmit={close} />
{:else}
	<Stack gap="lg">
		<CollectionForm {client} collection="purchase_orders" {recordId} defaultValues={record}>
			{#snippet children({ Field })}
				<Grid minimum="compact">
					<Field name="doc_no" />
					<Field name="status" />
					<Field name="supplier_id" label="Supplier" />
					<Field name="currency" />
					<Field name="tax_inclusive" label="Tax inclusive" />
					<Field name="expected_date" label="Expected date" />
					<Field name="warehouse_id" label="Warehouse" />
					<Field name="payment_terms_days" label="Payment terms (days)" />
					<Field name="owner_id" label="Owner" />
					<Column span="all"><Field name="notes" /></Column>
					{#if record.status === 'cancelled'}
						<Column span="all"><Field name="cancel_reason" label="Cancellation reason" /></Column>
					{/if}
				</Grid>
			{/snippet}
		</CollectionForm>

		<Stack gap="sm">
			<Inline align="start" justify="between" gap="sm">
				<div>
					<h3 class="text-sm font-semibold">Line items</h3>
					<p class="text-xs text-muted-foreground">
						Products and quantities on this order. Lines can only be edited while the order is in
						draft.
					</p>
				</div>
				{#if isDraft}
					<Button size="sm" onclick={() => (addLineOpen = true)}>
						<Icon icon="lucide:plus" class="mr-1.5 size-4" />
						Add line
					</Button>
				{/if}
			</Inline>

			<CollectionTable
				{client}
				collection="purchase_order_lines"
				view={`purchase_order:${recordId}:lines`}
				title="Lines"
				description="Product lines on this purchase order."
				features={{ create: false }}
				query={{
					where: { purchase_order_id: { eq: recordId } },
					orderBy: { product_name: 'asc' }
				}}
			>
				{#snippet columns({ Column: LineColumn })}
					<LineColumn name="product_code" label="Code" minWidth={100} card="badge" />
					<LineColumn name="product_name" label="Product" minWidth={200} card="title" />
					<LineColumn name="quantity" />
					<LineColumn name="unit_cost" label="Unit cost" />
					<LineColumn name="tax_rate" label="Tax %" />
					<LineColumn name="line_total" label="Total" />
				{/snippet}
			</CollectionTable>
		</Stack>

		{#if totals && record.currency}
			<dl class="rounded-md border bg-card p-3 text-sm">
				<Inline as="div" justify="between" class="py-1">
					<dt>Net</dt>
					<dd class="font-medium tabular-nums">
						{record.currency}
						{totals.net.toLocaleString()}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="py-1">
					<dt>Tax</dt>
					<dd class="font-medium tabular-nums">
						{record.currency}
						{totals.tax.toLocaleString()}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="border-t pt-2">
					<dt class="font-medium">Gross</dt>
					<dd class="text-heading tabular-nums">
						{record.currency}
						{totals.gross.toLocaleString()}
					</dd>
				</Inline>
			</dl>
		{/if}
	</Stack>

	<Sheet.Root bind:open={addLineOpen}>
		<Sheet.Content flush class="sm:max-w-xl">
			<Sheet.Header class="border-b border-border px-5 py-4">
				<Sheet.Title>Add line</Sheet.Title>
				<Sheet.Description>Add a product line to {record.doc_no}.</Sheet.Description>
			</Sheet.Header>
			<div class="p-5">
				<CollectionForm
					{client}
					collection="purchase_order_lines"
					defaultValues={{ purchase_order_id: recordId }}
					onAfterSubmit={async () => {
						await linesQuery?.refresh();
						await refresh?.();
						addLineOpen = false;
					}}
				/>
			</div>
		</Sheet.Content>
	</Sheet.Root>
{/if}
