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
	collection="shift_definitions"
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
			<Field name="start_time" label="Start time" />
			<Field name="end_time" label="End time" />
			<Field name="break_minutes" label="Break (min)" />
			<Field name="crosses_midnight" label="Crosses midnight" />
			<Field name="pays_overtime" label="Overtime eligible" />
			<Field name="overtime_break_minutes" label="Overtime break (min)" />
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
