<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { contributionTreatmentSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type TreatmentKind = Value['kind'];

	const KIND_OPTIONS: { value: TreatmentKind; label: string; description: string }[] = [
		{ value: 'INCLUDE', label: 'Include', description: 'Chargeable in full' },
		{ value: 'EXCLUDE', label: 'Exclude', description: 'Not chargeable' },
		{ value: 'REDUCE', label: 'Reduce', description: 'Reduces the contribution base' },
		{ value: 'SPECIAL', label: 'Special rule', description: 'Named rule on the contribution' },
		{ value: 'UNSET', label: 'Unset', description: 'Not yet decided by the authority' }
	];

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(contributionTreatmentSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		return current.kind === 'SPECIAL' ? `Special: ${current.rule}` : current.kind;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: TreatmentKind): Value {
		switch (kind) {
			case 'INCLUDE':
				return { kind: 'INCLUDE' };
			case 'EXCLUDE':
				return { kind: 'EXCLUDE' };
			case 'REDUCE':
				return { kind: 'REDUCE' };
			case 'SPECIAL':
				return { kind: 'SPECIAL', rule: '' };
			case 'UNSET':
				return { kind: 'UNSET' };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: TreatmentKind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Treatment
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.contribution_treatment.select_treatment')}
				onValueChange={selectKind}
			/>
		</label>
		{#if current?.kind === 'SPECIAL'}
			<label class="grid gap-1.5 text-sm font-medium">
				Rule name
				<Input
					value={current.rule}
					{disabled}
					placeholder={t('component.must_be_listed_on_contribution')}
					oninput={(event) => emit({ kind: 'SPECIAL', rule: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
