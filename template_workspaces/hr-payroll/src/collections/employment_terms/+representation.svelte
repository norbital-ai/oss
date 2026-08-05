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
	collection="employment_terms"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? 'Save terms' : 'Create terms'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employment_id"
				label="Employment"
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
				label="Work pattern"
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
			<Field name="base_salary" label="Base salary" />
			<Field name="pay_frequency" label="Pay frequency" />
			<Field name="ordinary_hours_per_week" label="Ordinary hours per week" />
			<Field name="working_days_per_week" label="Working days per week" />
			<Field name="employment_type" label="Employment type" />
			<Field name="work_classification" label="Classification" />
			<Field name="statutory_work_category" label="Statutory work category" />
			<Field name="overtime_eligible" label="Overtime eligible" />
			<Field name="rest_day" label="Rest day (when no pattern is named)" />
			<Field name="job_title" label="Job title" />
			<Field name="department" />
			<Field name="payroll_group" label="Payroll group" />
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
