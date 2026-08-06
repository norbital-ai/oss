<script lang="ts">
	/**
	 * A statutory break belongs to one payroll regime. Without this file the auto `CollectionForm`
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
	collection="rest_break_rules"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_break_rule') : t('component.create_break_rule')}
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
			<Field name="applies_when" label={t('component.applies_when')} />
			<Field name="after_consecutive_hours" label={t('component.due_after_consecutive_hours')} />
			<Field name="minimum_minutes" label={t('component.minimum_length_min')} />
			<Field name="counts_as_worked_time" label={t('component.counts_as_working_time')} />
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
