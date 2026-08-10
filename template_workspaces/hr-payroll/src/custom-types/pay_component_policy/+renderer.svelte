<script lang="ts">
	/**
	 * The policy used to be one JSON textarea, which put every `statutory_contribution_id` on screen
	 * as a uuid and asked the operator to keep the union arm and its settlement direction consistent
	 * by hand. The arm is now a picker that fixes the settlement, and each statutory decision is a
	 * row of the shared effective-dated layer list — one control per field, and a picker for the id.
	 *
	 * Unlike the other two matrices, a row here carries no `level`: it is identified by the
	 * contribution it decides, which is why the identity snippet is a contribution picker rather
	 * than the level picker the cap and entitlement matrices mount.
	 */
	import EffectiveLayerList from '../../lib/ui/policy-layers/effective-layer-list.svelte';
	import ContributionTreatmentRenderer from '../contribution_treatment/+renderer.svelte';
	import { PAYROLL_TIME_ZONE, startOfDayInstant, todayKey } from '../../lib/ui/calendar.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { client } from '$pod/client';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { Stack } from '@norbital-ai/ui/layout';
	import { payComponentPolicySchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type Kind = Value['kind'];
	type Treatment = Value['statutory_treatments'][number];
	type Charge = Treatment['treatment'];

	/** A decision the statute has not withdrawn; a successor row end-dates it. */
	const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

	const CHARGE_FIELD = {
		name: 'treatment',
		kind: 'contribution_treatment',
		nullable: false
	} satisfies CollectionField;

	const KIND_OPTIONS: { value: Kind; label: string; description: string }[] = [
		{ value: 'INFORMATION', label: 'Information', description: 'Recorded, never settled' },
		{ value: 'EARNING', label: 'Earning', description: 'Added to pay' },
		{ value: 'ABSENCE', label: 'Absence', description: 'Deducted for time not worked' },
		{ value: 'DEDUCTION', label: 'Deduction', description: 'Deducted from pay' },
		{
			value: 'NON_WAGE_PAYMENT',
			label: 'Non-wage payment',
			description: 'Added, but not wages'
		},
		{
			value: 'EMPLOYER_COST',
			label: 'Employer cost',
			description: 'Borne by the employer alone'
		}
	];

	type PayComponentPolicyRendererProps = RendererProps & {
		/** The pay component being edited, which is what scopes the contributions offered below. */
		readonly row?: Record<string, unknown>;
	};

	let props: PayComponentPolicyRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(payComponentPolicySchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const treatments = $derived<Treatment[]>(
		current === null ? [] : [...current.statutory_treatments]
	);
	/*
	 * The contributions are named in the editor, not here: resolving them would mount one lookup per
	 * row of the pay-components table, which is the N+1 `controller-surfaces.md` §5 forbids, and the
	 * ids themselves answer no question an operator has.
	 */
	const summary = $derived(
		current === null
			? '—'
			: `${current.kind.replaceAll('_', ' ').toLowerCase()} · ${current.settlement.toLowerCase()} · ${current.statutory_treatments.length} statutory decisions`
	);

	/*
	 * A statutory scheme belongs to a jurisdiction and a pay component to a company, so the option
	 * set is the schemes of the company's own jurisdiction — not every scheme in the workspace, half
	 * of which belong to another country and none of which this component can be charged against.
	 */
	const companyId = $derived(
		typeof props.row?.company_id === 'string' ? props.row.company_id : null
	);
	const companyQuery = $derived(
		companyId == null
			? null
			: client.db.companies.findFirst({ where: { norbital_id: { eq: companyId } } })
	);
	const jurisdictionId = $derived(companyQuery?.current?.jurisdiction_id ?? null);
	const contributionsQuery = $derived(
		jurisdictionId == null
			? null
			: client.db.statutory_contributions.findMany({
					where: { jurisdiction_id: { eq: jurisdictionId } },
					orderBy: { sequence: 'asc' },
					limit: 500
				})
	);
	const contributionOptions = $derived(
		(contributionsQuery?.current ?? []).map((contribution) => ({
			value: contribution.norbital_id,
			label: [contribution.code, contribution.name].filter((part) => part).join(' · ') || '—',
			search_term: `${contribution.code ?? ''} ${contribution.name ?? ''} ${contribution.authority ?? ''}`
		}))
	);

	/** The settlement direction each arm fixes — the reason the arm is a closed union at all. */
	function atKind(kind: Kind, decisions: Treatment[]): Value {
		switch (kind) {
			case 'INFORMATION':
				return { kind, settlement: 'NONE', statutory_treatments: decisions };
			case 'EARNING':
				return { kind, settlement: 'ADD', statutory_treatments: decisions };
			case 'ABSENCE':
				return { kind, settlement: 'DEDUCT', statutory_treatments: decisions };
			case 'DEDUCTION':
				return { kind, settlement: 'DEDUCT', statutory_treatments: decisions };
			case 'NON_WAGE_PAYMENT':
				return { kind, settlement: 'ADD', statutory_treatments: decisions };
			case 'EMPLOYER_COST':
				return { kind, settlement: 'EMPLOYER_ONLY', statutory_treatments: decisions };
		}
	}

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function selectKind(kind: Kind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(atKind(kind, treatments));
	}

	function newTreatment(): Treatment {
		return {
			statutory_contribution_id: '',
			authority: '',
			treatment: { kind: 'UNSET' },
			effective_range: {
				start: startOfDayInstant(todayKey(), PAYROLL_TIME_ZONE),
				end: OPEN_ENDED
			}
		};
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack gap="sm" class="rounded-md border border-border bg-muted/20 p-3">
		<label class="grid gap-1.5 text-sm font-medium">
			Economic type
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.pay_component_policy.select_economic_type')}
				onValueChange={selectKind}
			/>
		</label>
		{#if current !== null}
			<p class="text-xs text-muted-foreground">
				Settles as {current.settlement.replaceAll('_', ' ').toLowerCase()} — fixed by the economic type,
				and every statutory decision below is effective-dated in its own right.
			</p>

			<EffectiveLayerList
				layers={treatments}
				{disabled}
				emptyMessage={t('renderer.pay_component_policy.empty')}
				addPlaceholder={t('renderer.pay_component_policy.add_placeholder')}
				additions={[
					{
						value: 'TREATMENT',
						label: 'Statutory decision',
						description: 'How one scheme charges this component',
						create: newTreatment
					}
				]}
				onChange={(next) => emit(atKind(current.kind, next))}
			>
				{#snippet identity(row)}
					<label class="grid gap-1.5 text-sm font-medium">
						Statutory scheme
						<Combobox
							ariaLabel={t('component.statutory_scheme')}
							options={contributionOptions}
							value={row.layer.statutory_contribution_id === ''
								? null
								: row.layer.statutory_contribution_id}
							disabled={row.disabled || jurisdictionId == null}
							searchPlaceholder={t('renderer.pay_component_policy.search_schemes')}
							emptyPlaceholder={t('renderer.pay_component_policy.choose_scheme')}
							clientConfig={{
								isLoading: contributionsQuery?.loading ?? false,
								error: contributionsQuery?.error?.message ?? null
							}}
							onValueChange={(value) =>
								row.replace({
									...row.layer,
									statutory_contribution_id: typeof value === 'string' ? value : ''
								})}
						/>
					</label>
				{/snippet}

				{#snippet body(row)}
					<Stack gap="xs" class="text-sm font-medium">
						<span>{t('component.chargeability')}</span>
						<ContributionTreatmentRenderer
							field={CHARGE_FIELD}
							value={row.layer.treatment}
							mode="edit"
							disabled={row.disabled}
							onValueChange={(next: Charge | null) => {
								if (next !== null) row.replace({ ...row.layer, treatment: next });
							}}
						/>
					</Stack>
				{/snippet}
			</EffectiveLayerList>
		{/if}
	</Stack>
{/if}
