<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { inForceTodayFilter } from '../../lib/ui/calendar.js';
	import { formatNumeric, formatProrationBasis } from '../../lib/ui/display-formatters.js';

	const { t } = useI18n<TenantI18nKeys>();

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
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/hr-payroll/app-media/settings-banner.svg"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/app-media/settings-banner.svg"
	/>
</svelte:head>

{#snippet jurisdictions()}
	<CollectionTable
		{client}
		collection="jurisdictions"
		view="hr_controller:settings:jurisdictions"
		title={t('app.settings.jurisdictions_title')}
		description={t('app.settings.jurisdictions_description')}
		initialFilters={inForceTodayFilter()}
		query={{ orderBy: { code: 'asc' } }}
		searchPlaceholder={t('app.settings.search_jurisdictions')}
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column name="currency" />
			<Column name="proration" render={({ value }) => formatProrationBasis(value, t)} />
			<Column name="rounding" />
			<Column name="ordinary_rate_basis" label={t('app.settings.ordinary_rate_basis')} />
			<Column
				name="ordinary_rate_divisor"
				label={t('app.settings.divisor')}
				render={({ value }) => formatNumeric(value)}
			/>
			<Column name="effective_range" label={t('component.effective')} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet companies()}
	<CollectionTable
		{client}
		collection="companies"
		view="hr_controller:settings:companies"
		title={t('app.settings.companies_title')}
		description={t('app.settings.companies_description')}
		initialFilters={inForceTodayFilter()}
		query={{ orderBy: { name: 'asc' } }}
		searchPlaceholder={t('component.search_companies')}
	>
		{#snippet columns({ Column })}
			<Column name="name" card="title" />
			<Column name="registration_number" card="subtitle" />
			<Column
				name="jurisdiction_id"
				label={t('app.settings.jurisdiction')}
				render={({ value }) =>
					value == null || value === '' ? '—' : (jurisdictionLabelsById.get(String(value)) ?? '—')}
			/>
			<Column name="pay_cutoff_day" label={t('app.settings.cutoff_day')} />
			<Column name="pay_day" label={t('app.settings.pay_day')} />
			<Column name="leave_year_start_month" label={t('app.settings.leave_year_starts')} />
			<Column name="overtime_calculation_method" label={t('app.settings.ot_calculation')} />
			<Column name="risk_class" label={t('app.settings.risk_class')} />
			<Column name="effective_range" label={t('component.effective')} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.settings.eyebrow')}
		title={t('app.settings.header_title')}
		description={t('app.settings.header_description')}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'jurisdictions',
				label: t('app.settings.jurisdictions_title'),
				icon: 'lucide:globe',
				content: jurisdictions
			},
			{
				name: 'companies',
				label: t('app.settings.tab_companies'),
				icon: 'lucide:building-2',
				content: companies
			}
		] satisfies TabConfig[]}
	/>
</Cover>
