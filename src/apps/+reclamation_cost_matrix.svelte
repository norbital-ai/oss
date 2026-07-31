<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { SUBSTRATES } from '../lib/reclamation/cost.js';
</script>

<svelte:head>
	<title>Reclamation Cost Matrix</title>
	<meta name="description" content="Unit rates per substrate and the estimates built from them." />
	<meta name="pod:icon" content="lucide:table-2" />
</svelte:head>

{#snippet rates()}
	<CollectionTable
		{client}
		collection="cost_rates"
		title="Unit cost matrix"
		description="One rate per substrate, shared by every project. Rates never change a volume."
	>
		{#snippet columns({ Column })}
			<Column name="label" minWidth={200} />
			<Column name="substrate" />
			<Column name="unit" />
			<Column name="rate" />
			<Column name="rate_basis" label="Basis" />
			<Column name="source" />
			<Column name="validity_range" label="Valid" />
		{/snippet}
		{#snippet ListCard(rate)}
			<Inline align="start" justify="between" gap="sm">
				<p class="truncate font-medium">{rate.label}</p>
				<span class="shrink-0 text-xs text-muted-foreground">{rate.unit}</span>
			</Inline>
			<p class="mt-1 truncate text-sm text-muted-foreground">
				{rate.substrate} · {rate.rate_basis ?? 'basis not stated'}
			</p>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet estimates()}
	<CollectionTable
		{client}
		collection="cost_estimates"
		title="Estimates"
		description="Each estimate prices one reconstruction revision. Totals recompute on every save."
	>
		{#snippet columns({ Column })}
			<Column name="estimate_name" minWidth={200} />
			<Column name="status" />
			<Column name="currency" />
			<Column name="subtotal" />
			<Column name="contingency" />
			<Column name="total" />
			<Column name="priced_at" label="Priced" />
		{/snippet}
		{#snippet ListCard(estimate)}
			<Inline align="start" justify="between" gap="sm">
				<p class="truncate font-medium">{estimate.estimate_name}</p>
				<span class="shrink-0 text-xs text-muted-foreground">{estimate.status ?? 'draft'}</span>
			</Inline>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet catalogue()}
	<Stack gap="md">
		<div class="divide-y rounded-md border bg-card text-sm">
			{#each SUBSTRATES as substrate (substrate.id)}
				<div class="p-3">
					<Inline align="start" justify="between" gap="sm">
						<p class="min-w-0 truncate font-medium">{substrate.label}</p>
						<span class="shrink-0 text-xs text-muted-foreground">
							{substrate.unit === 'm3' ? 'm³' : substrate.unit === 'm2' ? 'm²' : 'm'} · {substrate.driver}
						</span>
					</Inline>
					<p class="mt-1 text-xs text-muted-foreground">{substrate.note}</p>
				</div>
			{/each}
		</div>
		<p class="max-w-[70ch] text-xs text-muted-foreground">
			The catalogue is fixed by the engine: a substrate exists because the solid can measure it. A
			rate row without a matching substrate is never priced, and a substrate without a rate row
			prices at zero and is listed on the estimate as a missing rate.
		</p>
	</Stack>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Reclamation settings"
		title="Cost Matrix"
		description="Unit rates per substrate, the estimates built from them, and what each substrate measures."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		variant="underline"
		animate={false}
		config={[
			{ name: 'rates', label: 'Unit rates', icon: 'lucide:table-2', content: rates },
			{ name: 'estimates', label: 'Estimates', icon: 'lucide:calculator', content: estimates },
			{ name: 'catalogue', label: 'Substrate catalogue', icon: 'lucide:layers', content: catalogue }
		] satisfies TabConfig[]}
	/>
</Cover>
