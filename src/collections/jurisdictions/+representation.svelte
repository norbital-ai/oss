<script lang="ts">
	/**
	 * One payroll regime, and the statutory schemes that only exist inside it.
	 *
	 * `statutory_contributions` has no home of its own: EPF, SOCSO, EIS and PCB are not a catalogue
	 * anybody browses across countries — each one is a fact about the jurisdiction that levies it, and
	 * reading it apart from that jurisdiction's currency, rounding and ordinary-rate divisor is how a
	 * scheme ends up configured against the wrong regime. So it lives here, scoped to the record it
	 * belongs to, rather than as a sibling tab implying schemes and regimes are peers.
	 */
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { formatNumeric } from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();
</script>

{#snippet regime()}
	<CollectionForm
		{client}
		collection="jurisdictions"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		submitLabel={record ? 'Save jurisdiction' : 'Create jurisdiction'}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field name="code" />
				<Field name="name" />
				<Field name="currency" />
				<Field name="tax_year_start_month" label="Tax year starts (month)" />
				<Field name="leave_year_start_month" label="Leave year starts (month)" />
				<Field name="proration" label="Proration basis" />
				<Field name="rounding" />
				<Field name="ordinary_rate_basis" label="Ordinary rate basis" />
				<Field name="ordinary_rate_divisor" label="Ordinary rate divisor" />
				<Field name="definition_hash" label="Definition hash" />
				<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet contributions()}
	{#if record}
		<CollectionTable
			{client}
			collection="statutory_contributions"
			view={`jurisdictions:contributions:${record.norbital_id}`}
			title="Statutory contributions"
			description="The schemes this regime levies, in the order payroll applies them."
			query={{
				where: { jurisdiction_id: { eq: record.norbital_id } },
				orderBy: { sequence: 'asc' }
			}}
			searchPlaceholder="Search contributions…"
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn name="code" card="title" />
				<TableColumn name="name" card="subtitle" />
				<TableColumn name="authority" />
				<TableColumn name="payer" card="badge" />
				<TableColumn name="keyed_by" label="Keyed by" />
				<TableColumn name="rounding" />
				<TableColumn name="sequence" label="Applied at" />
				<TableColumn name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#if record}
	{#snippet jurisdictionSummary()}
		<Stack gap="xs">
			<Inline gap="sm" align="baseline">
				<h2 class="truncate text-lg font-semibold">{record.code} · {record.name}</h2>
				<span class="text-sm text-muted-foreground">{record.currency}</span>
			</Inline>
			<p class="text-sm text-muted-foreground">
				Ordinary pay is divided by {formatNumeric(record.ordinary_rate_divisor)}
				{record.ordinary_rate_basis === 'HOURS_PER_MONTH' ? 'hours' : 'days'} a month. Every rule here
				is effective-dated — end-date and insert a successor, never update in place.
			</p>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={jurisdictionSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'regime', label: 'Regime', icon: 'lucide:globe', content: regime },
				{
					name: 'contributions',
					label: 'Statutory contributions',
					icon: 'lucide:landmark',
					content: contributions
				}
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render regime()}
{/if}
