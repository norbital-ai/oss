<script lang="ts">
	/**
	 * A settled line, read only.
	 *
	 * Nothing writes here by hand — the payroll engine writes every line when the run is built — so
	 * this panel explains a figure rather than offering to change one. The auto form did the
	 * opposite: it offered `payslip_id` and the three generated link columns as editable uuids, and
	 * the database would have refused every one of the writes.
	 *
	 * The three link columns are physical projections of `component`, so exactly one of them is set
	 * on any line. Each resolves to the record's own `code · name`; the empty ones read `—`.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

{#if record}
	<CollectionForm
		{client}
		collection="payslip_lines"
		recordId={record.norbital_id}
		defaultValues={record}
		disabled
	>
		{#snippet children({ Field })}
			<Grid gap="md" minimum="panel">
				<Field
					name="payslip_id"
					label={t('component.payslip')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'payslips',
						options: {
							label: (payslip) =>
								[payslip.currency, payslip.net]
									.filter((part) => part != null && part !== '')
									.join(' ') || '—',
							limit: 500
						}
					}}
				/>
				<Field name="sequence" label={t('component.applied_at')} />
				<Field name="bucket" label={t('component.bucket')} />
				<Field name="amount" label={t('component.amount')} />
				<Field name="quantity" label={t('component.quantity')} />
				<Field name="rate" label={t('component.rate')} />
				<Field
					name="pay_component_id"
					label={t('component.pay_component')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'pay_components',
						options: {
							label: (component) =>
								[component.code, component.name]
									.filter((part) => part != null && part !== '')
									.join(' · ') || '—',
							orderBy: { code: 'asc' },
							limit: 500
						}
					}}
				/>
				<Field
					name="statutory_contribution_id"
					label={t('component.statutory_scheme')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'statutory_contributions',
						options: {
							label: (contribution) =>
								[contribution.code, contribution.name]
									.filter((part) => part != null && part !== '')
									.join(' · ') || '—',
							orderBy: { code: 'asc' },
							limit: 500
						}
					}}
				/>
				<Field
					name="component_entry_id"
					label={t('component.input_entry')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'component_entries',
						options: {
							label: (entry) =>
								entry.description != null && entry.description !== ''
									? String(entry.description)
									: '—',
							limit: 500
						}
					}}
				/>
				<Column span="all"><Field name="component" label={t('component.line_kind')} /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{:else}
	<p class="text-sm text-muted-foreground">
		A payslip line is written by the payroll engine, never by hand: build the payroll run and it
		writes one line per settled component.
	</p>
{/if}
