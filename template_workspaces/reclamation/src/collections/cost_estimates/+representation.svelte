<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { formatMoney, formatQuantity } from '../../lib/reclamation/cost.js';
	import type { CostLine } from '../../lib/reclamation/cost.js';
	import type { RepresentationProps } from './$types.js';

	let { record, close }: RepresentationProps = $props();

	/**
	 * The priced lines are recomputed server-side on every write, so this panel
	 * only ever displays them. Editing a lever and saving re-prices the estimate.
	 */
	const lines = $derived.by((): CostLine[] => {
		if (!record?.lines_json) return [];
		try {
			const parsed: unknown = JSON.parse(record.lines_json);
			return Array.isArray(parsed) ? (parsed as CostLine[]) : [];
		} catch {
			return [];
		}
	});
	const currency = $derived(record?.currency ?? 'SGD');
</script>

<Stack gap="lg">
	<CollectionForm
		{client}
		collection="cost_estimates"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid minimum="compact">
				<Field name="estimate_name" />
				<Field name="project_id" />
				<Field name="reconstruction_id" />
				<Field name="status" />
				<Field name="currency" />
				<Field name="sand_loss_pct" />
				<Field name="dredged_fill_loss_pct" />
				<Field name="perimeter_margin_pct" />
				<Field name="pvd_area_fraction" />
				<Field name="pvd_spacing_m" />
				<Field name="contingency_pct" />
				<Column span="all"><Field name="notes" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>

	{#if lines.length > 0}
		<Stack as="section" gap="sm">
			<div class="border-b pb-2">
				<h3 class="text-sm font-semibold">Priced lines</h3>
				<p class="text-xs text-muted-foreground">
					Quantities come from the stitched solid; the levers above adjust what is priced.
				</p>
			</div>
			<div class="divide-y rounded-md border bg-card text-sm">
				{#each lines as line (line.substrate)}
					<div class="p-3">
						<Inline align="start" justify="between" gap="sm">
							<p class="min-w-0 truncate font-medium">{line.label}</p>
							<p class="shrink-0 tabular-nums">{formatMoney(line.amount, currency)}</p>
						</Inline>
						<Inline justify="between" gap="sm" class="mt-1 text-xs text-muted-foreground">
							<span class="tabular-nums">
								{formatQuantity(line.pricedQuantity, line.unit)} × {formatMoney(
									line.rate,
									currency
								)}
								{#if line.pricedQuantity !== line.stitchedQuantity}
									<span class="ml-1">
										(stitched {formatQuantity(line.stitchedQuantity, line.unit)})
									</span>
								{/if}
							</span>
							<span class="shrink-0 capitalize">{line.method}</span>
						</Inline>
						<p class="mt-1 text-xs text-muted-foreground">{line.basis}</p>
					</div>
				{/each}
			</div>
			<dl class="rounded-md border bg-card p-3 text-sm">
				<Inline as="div" justify="between" class="py-1">
					<dt>Subtotal</dt>
					<dd class="font-medium tabular-nums">
						{formatMoney(record?.subtotal?.value ?? 0, currency)}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="py-1">
					<dt>Contingency</dt>
					<dd class="font-medium tabular-nums">
						{formatMoney(record?.contingency?.value ?? 0, currency)}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="border-t pt-2">
					<dt class="font-medium">Total</dt>
					<dd class="text-heading tabular-nums">
						{formatMoney(record?.total?.value ?? 0, currency)}
					</dd>
				</Inline>
			</dl>
			{#if (record?.missing_rates?.length ?? 0) > 0}
				<p class="text-xs text-destructive">
					No usable {currency} rate for: {record?.missing_rates?.join(', ')}. Those lines price at
					zero.
				</p>
			{/if}
		</Stack>
	{/if}
</Stack>
