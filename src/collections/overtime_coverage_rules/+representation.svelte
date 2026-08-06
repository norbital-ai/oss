<script lang="ts">
	/**
	 * A coverage test belongs to one payroll regime. Without this file the auto `CollectionForm`
	 * asked for `jurisdiction_id` as an editable uuid; it is a relationship and reads as the
	 * regime's `code · name`.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="overtime_coverage_rules"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_coverage_rule') : t('component.create_coverage_rule')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="jurisdiction_id"
				label={t('component.payroll_regime')}
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
			<Field name="authority" label={t('component.authority')} />
			<Field name="wage_ceiling" label={t('component.wage_ceiling')} />
			<Field name="wage_basis" label={t('component.ceiling_measured_against')} />
			<Field name="ceiling_is_inclusive" label={t('component.wages_equal_ceiling_covered')} />
			<Field name="category_basis" label={t('component.categories_named_from')} />
			<Column span="all">
				<Field name="excluded_categories" label={t('component.never_covered')} />
			</Column>
			<Column span="all">
				<Field name="exempt_categories" label={t('component.always_covered')} />
			</Column>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
