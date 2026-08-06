<script lang="ts">
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
	collection="employment_terms"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_terms') : t('component.create_terms')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employment_id"
				label={t('component.employment')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'employments',
					options: {
						label: (employment) =>
							employment.employee_number != null && employment.employee_number !== ''
								? String(employment.employee_number)
								: '—',
						orderBy: { employee_number: 'asc' },
						limit: 1000
					}
				}}
			/>
			<Field
				name="work_pattern_id"
				label={t('component.work_pattern')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'work_patterns',
					options: {
						label: (pattern) =>
							[pattern.code, pattern.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="base_salary" label={t('component.base_salary')} />
			<Field name="pay_frequency" label={t('component.pay_frequency')} />
			<Field name="ordinary_hours_per_week" label={t('component.ordinary_hours_per_week')} />
			<Field name="working_days_per_week" label={t('component.working_days_per_week')} />
			<Field name="employment_type" label={t('component.employment_type')} />
			<Field name="work_classification" label={t('component.classification')} />
			<Field name="statutory_work_category" label={t('component.statutory_work_category')} />
			<Field name="overtime_eligible" label={t('component.overtime_eligible')} />
			<Field name="rest_day" label={t('component.rest_day_no_pattern')} />
			<Field name="job_title" label={t('component.job_title')} />
			<Field name="department" />
			<Field name="payroll_group" label={t('component.payroll_group')} />
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
