<script lang="ts">
	/**
	 * A drafted month belongs to one company and one work pattern. The auto form asked for both as
	 * editable uuids; both are relationships and read as their own names.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/record-media/rosters-banner.svg"
	/>
</svelte:head>

<CollectionForm
	{client}
	collection="rosters"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_roster') : t('component.create_roster')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
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
			<Field name="month" label={t('component.month')} />
			<Field name="published_at" label={t('component.published')} />
		</Grid>
	{/snippet}
</CollectionForm>
