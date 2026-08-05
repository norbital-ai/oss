<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { ToggleGroup, ToggleGroupItem } from '@norbital-ai/ui/toggle-group';
	import { todayInstant } from '../../lib/ui/calendar.js';
	import { formatNumeric, formatProrationBasis } from '../../lib/ui/display-formatters.js';

	/**
	 * Both catalogues here are effective-dated, so both open on the regime in force *today* and widen
	 * only when the operator asks for history. `contains_date` compares against a `dateRange()`
	 * bound, which is an instant: `todayInstant()` resolves the payroll timezone, while a bare
	 * calendar day is rejected by the query layer.
	 */
	let effectiveWindow = $state<'current' | 'history'>('current');
	const effectiveRange: { effective_range?: { contains_date: string } } = $derived(
		effectiveWindow === 'history' ? {} : { effective_range: { contains_date: todayInstant() } }
	);

	/**
	 * Relation column labels, not a listing — deliberately unfiltered by the effective window so a
	 * superseded jurisdiction still resolves to its name instead of an em dash when history is shown.
	 */
	const jurisdictionsQuery = client.db.jurisdictions.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	const jurisdictionLabelsById = $derived(
		new Map(
			(jurisdictionsQuery.current ?? []).map((jurisdiction) => [
				jurisdiction.norbital_id,
				jurisdiction.name
			])
		)
	);
</script>

<svelte:head>
	<title>Statutory profile</title>
	<meta
		name="description"
		content="The regime every payroll is calculated against: jurisdictions with the schemes, rates, overtime rules and limits configured inside them, and the companies bound to each"
	/>
	<meta name="pod:icon" content="lucide:scale" />
</svelte:head>

{#snippet effectiveWindowActions()}
	<Stack gap="xs">
		<span class="text-sm font-medium text-muted-foreground">Effective</span>
		<ToggleGroup
			type="single"
			size="sm"
			value={effectiveWindow}
			onValueChange={(value) => {
				effectiveWindow = value === 'history' ? 'history' : 'current';
			}}
		>
			<ToggleGroupItem value="current" aria-label="Show only what is in force today">
				In force today
			</ToggleGroupItem>
			<ToggleGroupItem value="history" aria-label="Show every version, including superseded ones">
				All history
			</ToggleGroupItem>
		</ToggleGroup>
	</Stack>
{/snippet}

{#snippet jurisdictions()}
	<CollectionTable
		{client}
		collection="jurisdictions"
		view="hr_controller:settings:jurisdictions"
		title="Jurisdictions"
		description="Open a jurisdiction to configure everything it sets: the statutory schemes it levies (and the rate bands inside each), what overtime is worth, and the ceiling on overtime hours. None of those is a catalogue of its own."
		query={{ where: { ...effectiveRange }, orderBy: { code: 'asc' } }}
		searchPlaceholder="Search jurisdictions…"
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column name="currency" />
			<Column name="proration" render={({ value }) => formatProrationBasis(value)} />
			<Column name="rounding" />
			<Column name="ordinary_rate_basis" label="Ordinary rate basis" />
			<Column
				name="ordinary_rate_divisor"
				label="Divisor"
				render={({ value }) => formatNumeric(value)}
			/>
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet companies()}
	<CollectionTable
		{client}
		collection="companies"
		view="hr_controller:settings:companies"
		title="Companies"
		description="The legal entities payroll runs for, each bound to the jurisdiction whose regime prices it."
		query={{ where: { ...effectiveRange }, orderBy: { name: 'asc' } }}
		searchPlaceholder="Search companies…"
	>
		{#snippet columns({ Column })}
			<Column name="name" card="title" />
			<Column name="registration_number" card="subtitle" />
			<Column
				name="jurisdiction_id"
				label="Jurisdiction"
				render={({ value }) =>
					value == null || value === '' ? '—' : (jurisdictionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="pay_cutoff_day" label="Cutoff day" />
			<Column name="pay_day" label="Pay day" />
			<Column name="leave_year_start_month" label="Leave year starts" />
			<Column name="overtime_calculation_method" label="OT calculation" />
			<Column name="risk_class" label="Risk class" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Statutory profile"
		description="The regime payroll is calculated against, and the companies bound to one. Contribution rates, overtime rules and overtime limits are not catalogues — they are configured inside the jurisdiction that levies them, and rate bands inside the scheme they belong to. The pay catalogue lives under Pay components and per-person registrations under People. Every rule is effective-dated — end-date and insert a successor, never update in place."
		actions={effectiveWindowActions}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'jurisdictions',
				label: 'Jurisdictions',
				icon: 'lucide:globe',
				content: jurisdictions
			},
			{ name: 'companies', label: 'Companies', icon: 'lucide:building-2', content: companies }
		] satisfies TabConfig[]}
	/>
</Cover>
