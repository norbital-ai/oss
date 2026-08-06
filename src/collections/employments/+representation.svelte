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
	collection="employments"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_employment') : t('component.create_employment')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employee_id"
				label={t('component.person')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'employees',
					options: {
						label: (person) =>
							person.name != null && person.name !== '' ? String(person.name) : '—',
						orderBy: { name: 'asc' },
						limit: 1000
					}
				}}
			/>
			<Field
				name="company_id"
				label={t('component.legal_entity')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'companies',
					options: {
						label: (company) =>
							company.name != null && company.name !== '' ? String(company.name) : '—',
						orderBy: { name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="employee_number" label={t('component.employee_number')} />
			<Field name="hire_date" label={t('component.hired')} />
			<Field name="exit_date" label={t('component.exited')} />
			<Field name="exit_reason" label={t('component.exit_reason')} />
			<Column span="all"><Field name="bank" label={t('component.pay_destination')} /></Column>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
