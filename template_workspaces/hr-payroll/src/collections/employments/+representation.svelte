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
	collection="employments"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? 'Save employment' : 'Create employment'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employee_id"
				label="Person"
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
				label="Legal entity"
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
			<Field name="employee_number" label="Employee number" />
			<Field name="hire_date" label="Hired" />
			<Field name="exit_date" label="Exited" />
			<Field name="exit_reason" label="Exit reason" />
			<Column span="all"><Field name="bank" label="Pay destination" /></Column>
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
