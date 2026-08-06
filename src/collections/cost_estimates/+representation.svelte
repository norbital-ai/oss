<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { formatMoney, formatQuantity, parseCostLines } from '../../lib/reclamation/cost.js';
	import type { RepresentationProps } from './$types.js';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	/**
	 * The priced lines are recomputed server-side on every write, so this panel
	 * only ever displays them. Editing a lever and saving re-prices the estimate.
	 */
	const lines = $derived(parseCostLines(record?.lines_json));
	const currency = $derived(record?.currency ?? 'SGD');
</script>

<Stack gap="lg">
	<CollectionForm
		{client}
		collection="cost_estimates"
		recordId={record?.norbital_id}
		defaultValues={record ?? undefined}
		onAfterSubmit={record ? undefined : close}
	>
		{#snippet children({ Field, form })}
			{@const values = form.values()}
			<Grid minimum="compact">
				<Field name="estimate_name" />
				<Field
					name="project_id"
					label={t('component.project')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'reclamation_projects',
						options: {
							label: (record) => {
								const code = record.project_code;
								const name = record.project_name;
								if (code && name) return `${code} · ${name}`;
								const v = record.project_name;
								return v != null && v !== '' ? String(v) : '—';
							},
							orderBy: { project_code: 'asc' },
							limit: 200
						}
					}}
				/>
				{#key values.project_id}
					<Field
						name="reconstruction_id"
						label={t('component.reconstruction')}
						renderer={RelationshipRenderer}
						rendererProps={{
							target: 'site_reconstructions',
							disabled: !values.project_id,
							placeholder: values.project_id
								? t('component.select_reconstruction')
								: t('component.choose_project_first'),
							options: {
								where: values.project_id
									? { project_id: { eq: values.project_id } }
									: { norbital_id: { eq: '' } },
								label: (record) => {
									const revision = record.revision;
									return revision != null && revision !== '' ? `Revision ${revision}` : '—';
								},
								orderBy: { revision: 'desc' },
								limit: 200
							}
						}}
					/>
				{/key}
				<Field name="status" />
				<Field name="currency" />
				<Field name="sand_loss_pct" />
				<Field name="dredged_fill_loss_pct" />
				<Field name="perimeter_margin_pct" />
				<Field name="pvd_area_fraction" />
				<Field name="pvd_spacing_m" />
				<Field name="contingency_pct" />
				<Column span="all"><Field name="notes" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>

	{#if lines.length > 0}
		<Stack as="section" gap="sm">
			<div class="border-b pb-2">
				<h3 class="text-sm font-semibold">{t('component.priced_lines')}</h3>
				<p class="text-xs text-muted-foreground">
					{t('component.priced_lines_description')}
				</p>
			</div>
			<div class="divide-y rounded-md border bg-card text-sm">
				{#each lines as line (line.substrate)}
					<div class="p-3">
						<Inline align="start" justify="between" gap="sm">
							<p class="min-w-0 truncate font-medium">{line.label}</p>
							<p class="shrink-0 tabular-nums">{formatMoney(line.amount, currency)}</p>
						</Inline>
						<Inline justify="between" gap="sm" class="mt-1 text-xs text-muted-foreground">
							<span class="tabular-nums">
								{formatQuantity(line.pricedQuantity, line.unit)} × {formatMoney(
									line.rate,
									currency
								)}
								{#if line.pricedQuantity !== line.stitchedQuantity}
									<span class="ml-1">
										{t('component.stitched_qty', {
											quantity: formatQuantity(line.stitchedQuantity, line.unit)
										})}
									</span>
								{/if}
							</span>
							<span class="shrink-0 capitalize">{line.method}</span>
						</Inline>
						<p class="mt-1 text-xs text-muted-foreground">{line.basis}</p>
					</div>
				{/each}
			</div>
			<dl class="rounded-md border bg-card p-3 text-sm">
				<Inline as="div" justify="between" class="py-1">
					<dt>{t('component.subtotal')}</dt>
					<dd class="font-medium tabular-nums">
						{formatMoney(record?.subtotal?.value ?? 0, currency)}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="py-1">
					<dt>{t('component.contingency')}</dt>
					<dd class="font-medium tabular-nums">
						{formatMoney(record?.contingency?.value ?? 0, currency)}
					</dd>
				</Inline>
				<Inline as="div" justify="between" class="border-t pt-2">
					<dt class="font-medium">{t('component.total')}</dt>
					<dd class="text-heading tabular-nums">
						{formatMoney(record?.total?.value ?? 0, currency)}
					</dd>
				</Inline>
			</dl>
		</Stack>
	{/if}
</Stack>
