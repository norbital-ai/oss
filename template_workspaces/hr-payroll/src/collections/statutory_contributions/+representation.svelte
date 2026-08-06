<script lang="ts">
	/**
	 * One statutory scheme, and the rate bands that price it.
	 *
	 * `contribution_rates.statutory_contribution_id` points at a scheme — not at a jurisdiction — so a
	 * band is not a sibling of the scheme and cannot be read beside one. A row like "5.5% from RM0 to
	 * RM5,000" is meaningless without the EPF/SOCSO/EIS scheme whose wage ladder it is a rung of, and
	 * the database says so: `contribution_rates_no_overlap` excludes overlaps *within one
	 * contribution*, so the set of bands that must not collide is exactly the set shown below.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { Column, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { inForceTodayFilter } from '../../lib/ui/calendar.js';
	import { formatRateAward, formatRateSelector } from '../../lib/ui/display-formatters.js';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();

	/*
	 * Bands are effective-dated, so the ladder opens on the rung in force *today* — the one payroll
	 * would actually use — seeded as a removable filter chip rather than a page-level toggle. The
	 * chip says what is being hidden, the operator widens it in place, and clearing it is
	 * remembered. `inForceTodayFilter()` writes the seed in the filter builder's vocabulary — a
	 * plain calendar day — and the existing conversion turns it into the instant `contains_date`
	 * compares against.
	 *
	 * `contribution_rates` carries `effective_range` itself, which is what the seed needs: an
	 * unknown field is skipped in silence, so a seed pointed at a related collection's dating would
	 * look like a working filter while filtering nothing.
	 */

	const payerLabel = $derived(
		record?.payer === 'BOTH' ? 'employee and employer' : (record?.payer?.toLowerCase() ?? 'nobody')
	);
	const keyedByLabel = $derived(
		record?.keyed_by?.toLowerCase().replaceAll('_', ' ') ?? 'nothing yet'
	);
</script>

{#snippet scheme()}
	<CollectionForm
		{client}
		collection="statutory_contributions"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		submitLabel={record ? t('component.save_scheme') : t('component.create_scheme')}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field
					name="jurisdiction_id"
					label={t('component.jurisdiction')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'jurisdictions',
						options: {
							label: (jurisdiction) =>
								[jurisdiction.code, jurisdiction.name]
									.filter((part) => part != null && part !== '')
									.join(' · ') || '—',
							orderBy: { code: 'asc' },
							limit: 200
						}
					}}
				/>
				<Field name="code" />
				<Field name="name" />
				<Field name="authority" />
				<Field name="payer" label={t('component.paid_by')} />
				<Field name="keyed_by" label={t('component.bands_keyed_by')} />
				<Field name="rounding" />
				<Field name="sequence" label={t('component.applied_at')} />
				<Column span="all">
					<Field
						name="relief_for"
						label={t('component.gives_relief_for')}
						renderer={RelationshipRenderer}
						rendererProps={{
							target: 'statutory_contributions',
							multiple: true,
							options: {
								label: (contribution) =>
									[contribution.code, contribution.name]
										.filter((part) => part != null && part !== '')
										.join(' · ') || '—',
								orderBy: { sequence: 'asc' },
								limit: 500
							}
						}}
					/>
				</Column>
				<Column span="all"
					><Field name="special_rules" label={t('component.named_special_rules')} /></Column
				>
				<Column span="all"
					><Field name="effective_range" label={t('component.effective_period')} /></Column
				>
			</Grid>
		{/snippet}
	</CollectionForm>
{/snippet}

{#snippet rates()}
	{#if record}
		<CollectionTable
			{client}
			collection="contribution_rates"
			view={`statutory_contributions:rates:${record.norbital_id}`}
			title={t('component.rate_bands')}
			description="One rung of this scheme's ladder: the selector that picks it — wage, wage and age, headcount or risk class — and the award it pays. A floor is the first band, a ceiling the terminal one."
			initialFilters={inForceTodayFilter()}
			query={{
				where: { statutory_contribution_id: { eq: record.norbital_id } },
				orderBy: { norbital_created_at: 'desc' }
			}}
			searchPlaceholder="Search rate bands…"
		>
			{#snippet columns({ Column: TableColumn })}
				<TableColumn
					name="selector"
					label={t('component.applies_to')}
					card="title"
					render={({ value }) => formatRateSelector(value)}
				/>
				<TableColumn
					name="award"
					label={t('component.award')}
					card="subtitle"
					render={({ value }) => formatRateAward(value)}
				/>
				<TableColumn name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#if record}
	{#snippet schemeSummary()}
		<Stack gap="xs">
			<Inline gap="sm" align="baseline">
				<h2 class="truncate text-lg font-semibold">{record.code} · {record.name}</h2>
				<span class="text-sm text-muted-foreground">{record.authority}</span>
			</Inline>
			<p class="text-sm text-muted-foreground">
				Paid by {payerLabel}, applied at step {record.sequence}, with bands keyed by {keyedByLabel}.
				End-date a band and insert a successor; never update one in place.
			</p>
		</Stack>
	{/snippet}

	<Cover as="main" gap="md" top={schemeSummary}>
		<Tabs
			animate={false}
			config={[
				{ name: 'scheme', label: 'Scheme', icon: 'lucide:landmark', content: scheme },
				{ name: 'rates', label: 'Rate bands', icon: 'lucide:percent', content: rates }
			] satisfies TabConfig[]}
		/>
	</Cover>
{:else}
	{@render scheme()}
{/if}
