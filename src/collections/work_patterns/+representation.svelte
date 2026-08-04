<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="work_patterns"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="compact">
			<Field
				name="company_id"
				label="Company"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'companies',
					options: {
						label: (record) =>
							record.name != null && record.name !== '' ? String(record.name) : '—',
						orderBy: { name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="code" />
			<Field name="name" />
			<Field
				name="default_shift_definition_id"
				label="Default shift"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'shift_definitions',
					options: {
						label: (record) =>
							[record.code, record.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Column span="all"><Field name="variant" label="Shape of the week" /></Column>
			<Field name="min_rest_days_per_week" label="Minimum rest days per week" />
			<Field name="max_consecutive_work_days" label="Maximum consecutive working days" />
			<Field name="max_daily_work_minutes" label="Maximum daily work (min)" />
			<Field name="min_minutes_between_shifts" label="Minimum rest between shifts (min)" />
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
