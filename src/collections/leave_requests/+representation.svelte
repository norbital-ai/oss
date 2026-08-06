<script lang="ts">
	/**
	 * A leave request is three facts: who, which leave, and what happened.
	 *
	 * The auto form painted all twelve columns. `kind`, `from_date`, `to_date`, `days`,
	 * `half_day_start`, `half_day_end`, `reason`, `certificate_file` and `summary` are every one of
	 * them `generatedAlwaysAs` projections of `event` — the database computes them so the collection
	 * can be indexed, ordered, searched and listed — so offering them as form fields showed the same
	 * values a second time, in inputs the database will not accept a write on.
	 *
	 * They are omitted here, not deleted from the model. Each is read: the leave tables order and
	 * print `from_date`/`to_date`/`days`/`certificate_file`, the approval analytics remote filters on
	 * `kind`, the scheduling board marks half days from `half_day_start`/`half_day_end`, `reason` and
	 * `summary` carry the row's search text, and the `(employment_id, leave_type_id, from_date)`
	 * index is built on three of them. The event is the source; they are its shadow.
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
	collection="leave_requests"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_leave') : t('component.submit_leave')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employment_id"
				label={t('component.person')}
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
				name="leave_type_id"
				label={t('component.leave_type')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'leave_types',
					options: {
						label: (leaveType) =>
							[leaveType.code, leaveType.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Column span="all"><Field name="event" label={t('component.what_happened')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
