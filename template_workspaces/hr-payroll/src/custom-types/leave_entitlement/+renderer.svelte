<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	/**
	 * The entitlement matrix had no editor at all — it was a display-only count, so a leave type's
	 * statutory, organisation and employee bands could not be corrected by hand at all. The frame
	 * below is the one `pay_component_policy` and `component_definition` also mount; what belongs
	 * only to this shape is the accrual band and the number of days.
	 */
	import EffectiveLayerList from '../../lib/ui/policy-layers/effective-layer-list.svelte';
	import LayerLevelPicker, {
		type PolicyLayerLevel
	} from '../../lib/ui/policy-layers/layer-level-picker.svelte';
	import AccrualKeyRenderer from '../accrual_key/+renderer.svelte';
	import { PAYROLL_TIME_ZONE, startOfDayInstant, todayKey } from '../../lib/ui/calendar.js';
	import { numberFrom } from '../../lib/ui/renderer-input.js';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { leaveEntitlementSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type Layer = Value['layers'][number];
	type AccrualBand = Layer['key'];

	/** A layer the leave year has not yet reached; the successor row end-dates it. */
	const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

	const BAND_FIELD = {
		name: 'key',
		kind: 'accrual_key',
		nullable: false
	} satisfies CollectionField;

	type LeaveEntitlementRendererProps = RendererProps & {
		/** The leave type being edited, which is what scopes the people an EMPLOYEE layer may name. */
		readonly row?: Record<string, unknown>;
	};

	let props: LeaveEntitlementRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const companyId = $derived(
		typeof props.row?.company_id === 'string' ? props.row.company_id : null
	);
	const parsed = $derived(leaveEntitlementSchema.safeParse(props.value));
	const layers = $derived<Layer[]>(parsed.success ? [...parsed.data.layers] : []);
	/*
	 * The count stays a static sentence. Naming the people behind the EMPLOYEE layers would mount
	 * one lookup per row of the leave-types table — the N+1 `controller-surfaces.md` §5 forbids —
	 * and they are named in the editor, where a single scoped query answers all of them at once.
	 */
	const summary = $derived(
		parsed.success
			? `${parsed.data.layers.length} statutory / organisation / employee entitlement layer${parsed.data.layers.length === 1 ? '' : 's'}`
			: '—'
	);

	function emit(next: Layer[]): void {
		if (props.mode === 'edit')
			props.onValueChange({ merge: 'MAX_WITH_STATUTORY_FLOOR', layers: next });
	}

	function newLayer(level: PolicyLayerLevel): Layer {
		const band = {
			key: { by: 'FLAT' } as const,
			days: 0,
			authority: '',
			effective_range: {
				start: startOfDayInstant(todayKey(), PAYROLL_TIME_ZONE),
				end: OPEN_ENDED
			}
		};
		switch (level) {
			case 'STATUTORY':
				return { level: 'STATUTORY', ...band };
			case 'ORGANISATION':
				return { level: 'ORGANISATION', ...band };
			case 'EMPLOYEE':
				return { level: 'EMPLOYEE', employment_id: '', ...band };
		}
	}

	/**
	 * Move a layer to another arm, carrying everything the arms share.
	 *
	 * Written out rather than spread so the EMPLOYEE arm's extra field is added and dropped
	 * explicitly: a spread would leave it behind on a STATUTORY row, which `strictObject` rejects
	 * only at save time, long after the operator has moved on.
	 */
	function atLevel(layer: Layer, level: PolicyLayerLevel): Layer {
		const { key, days, authority, effective_range } = layer;
		switch (level) {
			case 'STATUTORY':
				return { level: 'STATUTORY', key, days, authority, effective_range };
			case 'ORGANISATION':
				return { level: 'ORGANISATION', key, days, authority, effective_range };
			case 'EMPLOYEE':
				return {
					level: 'EMPLOYEE',
					employment_id: layer.level === 'EMPLOYEE' ? layer.employment_id : '',
					key,
					days,
					authority,
					effective_range
				};
		}
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack gap="sm" class="rounded-md border border-border bg-muted/20 p-3">
		<EffectiveLayerList
			{layers}
			{disabled}
			emptyMessage="No entitlement layers — this leave type grants nothing until one is added."
			addPlaceholder="Add an entitlement layer…"
			additions={[
				{ value: 'STATUTORY', label: 'Statutory layer', create: () => newLayer('STATUTORY') },
				{
					value: 'ORGANISATION',
					label: 'Organisation layer',
					create: () => newLayer('ORGANISATION')
				},
				{ value: 'EMPLOYEE', label: 'Employee layer', create: () => newLayer('EMPLOYEE') }
			]}
			onChange={emit}
		>
			{#snippet identity(row)}
				<LayerLevelPicker
					level={row.layer.level}
					employmentId={row.layer.level === 'EMPLOYEE' ? row.layer.employment_id : null}
					{companyId}
					disabled={row.disabled}
					onLevelChange={(level) => row.replace(atLevel(row.layer, level))}
					onEmploymentChange={(employment) => {
						if (row.layer.level === 'EMPLOYEE')
							row.replace({ ...row.layer, employment_id: employment });
					}}
				/>
			{/snippet}

			{#snippet body(row)}
				<Grid gap="sm" minimum="compact">
					<Stack gap="xs" class="text-sm font-medium">
						<span>{t('component.band')}</span>
						<AccrualKeyRenderer
							field={BAND_FIELD}
							value={row.layer.key}
							mode="edit"
							disabled={row.disabled}
							onValueChange={(next: AccrualBand | null) => {
								if (next !== null) row.replace({ ...row.layer, key: next });
							}}
						/>
					</Stack>
					<label class="grid gap-1.5 text-sm font-medium">
						Days granted
						<Input
							type="number"
							min="0"
							step="0.5"
							value={row.layer.days}
							disabled={row.disabled}
							oninput={(event) =>
								row.replace({ ...row.layer, days: numberFrom(event.currentTarget.value, 0) })}
						/>
					</label>
				</Grid>
			{/snippet}
		</EffectiveLayerList>
	</Stack>
{/if}
