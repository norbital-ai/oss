<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
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
	const { t } = useI18n<TenantI18nKeys>();
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

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/record-media/repayment_agreements-banner.svg"
	/>
</svelte:head>

<CollectionForm
	{client}
	collection="repayment_agreements"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	{validation}
	submitLabel={record
		? t('component.save_repayment_agreement')
		: t('component.create_repayment_agreement')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field, form })}
		<Stack gap="md">
			<Grid gap="md" minimum="compact" class="shrink-0">
				<Field
					name="employment_id"
					label={t('component.employment')}
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
					label={t('component.payroll_deduction_type')}
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
				<Field name="disbursed_on" label={t('component.disbursed_on')} />
				<Field name="repay_by" label={t('component.repay_by')} />
				<Column span="all"
					><Field
						name="effective_range"
						label={t('component.agreement_effective_period')}
					/></Column
				>
			</Grid>

			{#if !record}
				<Stack gap="sm" shrink={false} class="rounded-md border border-border p-3">
					<Stack gap="none">
						<p class="text-sm font-medium">{t('component.provision_equal_instalments')}</p>
						<p class="text-xs text-muted-foreground">
							{t('component.provision_remainder_hint')}
						</p>
					</Stack>
					<Grid gap="md" minimum="compact">
						<label class="grid gap-1.5 text-sm font-medium">
							{t('component.first_repayment_date')}
							<Input type="date" bind:value={firstDueDate} />
						</label>
						<label class="grid gap-1.5 text-sm font-medium">
							{t('component.number_of_instalments')}
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
						{t('component.generate_equal_schedule')}
					</Button>
					{#if provisioningError}
						<p class="text-sm text-destructive" role="alert">{provisioningError}</p>
					{/if}
				</Stack>
			{/if}

			<Field name="schedule" label={t('component.recovery_instalments')} />
		</Stack>
	{/snippet}
</CollectionForm>
