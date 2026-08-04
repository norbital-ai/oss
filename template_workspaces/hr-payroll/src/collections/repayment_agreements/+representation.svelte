<script lang="ts">
	import { client } from '$pod/client';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import type { CollectionFormValidation } from '@norbital-ai/ui/collection-form';
	import { Input } from '@norbital-ai/ui/input';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { RepresentationProps } from './$types.js';
	import {
		distributeRepaymentSchedule,
		monthlyDueDates,
		repaymentScheduleIssues
	} from './lib/repayment-schedule.js';

	let { record, close }: RepresentationProps = $props();
	// svelte-ignore state_referenced_locally -- a mounted representation owns one record baseline.
	let firstDueDate = $state(record?.schedule?.[0]?.due_date ?? '');
	// svelte-ignore state_referenced_locally -- a mounted representation owns one record baseline.
	let instalmentCount = $state(String(record?.schedule?.length ?? 1));
	let provisioningError = $state('');

	const validation = {
		semantic: (values) =>
			repaymentScheduleIssues({
				principal: values.principal,
				repayBy: values.repay_by,
				schedule: values.schedule
			}).map((message) => ({ message, path: ['schedule'] }))
	} satisfies CollectionFormValidation;
</script>

<CollectionForm
	{client}
	collection="repayment_agreements"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	{validation}
	submitLabel={record ? 'Save repayment agreement' : 'Create repayment agreement'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field, form })}
		<Stack gap="md">
			<Grid gap="md" minimum="compact" class="shrink-0">
				<Field
					name="employment_id"
					label="Employment"
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'employments',
						options: {
							label: (record) =>
								record.employee_number != null && record.employee_number !== ''
									? String(record.employee_number)
									: '—',
							orderBy: { employee_number: 'asc' },
							limit: 1000
						}
					}}
				/>
				<Field
					name="pay_component_id"
					label="Payroll deduction type"
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'pay_components',
						options: {
							label: (record) => {
								const code = record.code;
								const name = record.name;
								if (code && name) return `${code} · ${name}`;
								if (code) return String(code);
								if (name) return String(name);
								return '—';
							},
							orderBy: { code: 'asc' },
							limit: 500
						}
					}}
				/>
				<Field name="reference" />
				<Field name="principal" />
				<Field name="disbursed_on" label="Disbursed on" />
				<Field name="repay_by" label="Repay by" />
				<Column span="all"
					><Field name="effective_range" label="Agreement effective period" /></Column
				>
			</Grid>

			{#if !record}
				<Stack gap="sm" shrink={false} class="rounded-md border border-border p-3">
					<Stack gap="none">
						<p class="text-sm font-medium">Provision equal instalments</p>
						<p class="text-xs text-muted-foreground">
							The remainder, if any, is placed on the final instalment so the total is exact.
						</p>
					</Stack>
					<Grid gap="md" minimum="compact">
						<label class="grid gap-1.5 text-sm font-medium">
							First repayment date
							<Input type="date" bind:value={firstDueDate} />
						</label>
						<label class="grid gap-1.5 text-sm font-medium">
							Number of instalments
							<Input type="number" min="1" max="600" step="1" bind:value={instalmentCount} />
						</label>
					</Grid>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onclick={() => {
							provisioningError = '';
							try {
								const values = form.values();
								const schedule = distributeRepaymentSchedule(
									Number(values.principal),
									monthlyDueDates(firstDueDate, Number(instalmentCount))
								);
								form.setValues({ ...values, schedule });
							} catch (cause) {
								provisioningError = cause instanceof Error ? cause.message : String(cause);
							}
						}}
					>
						Generate equal schedule
					</Button>
					{#if provisioningError}
						<p class="text-sm text-destructive" role="alert">{provisioningError}</p>
					{/if}
				</Stack>
			{/if}

			<Field name="schedule" label="Recovery instalments" />
		</Stack>
	{/snippet}
</CollectionForm>
