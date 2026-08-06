<script lang="ts">
	/**
	 * `component_id` is a foreign key the database cannot declare — a variant is one JSONB value —
	 * so the picker is built here, from a query scoped to the leave type's own company. It used to
	 * be a text box asking the operator for a uuid, and the display summary printed that uuid on
	 * every row of the leave-types table.
	 */
	import { client } from '$pod/client';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid } from '@norbital-ai/ui/layout';
	import { leavePayrollEffectSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type EffectKind = Value['kind'];

	const KIND_OPTIONS: { value: EffectKind; label: string; description: string }[] = [
		{ value: 'PAID', label: 'Paid', description: 'No effect on pay' },
		{
			value: 'UNPAID',
			label: 'Unpaid',
			description: 'Deducted through a named pay component'
		}
	];

	type LeavePayrollEffectRendererProps = RendererProps & {
		/** The leave type being edited, which is what scopes the pay catalogue below. */
		readonly row?: Record<string, unknown>;
	};

	let props: LeavePayrollEffectRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(leavePayrollEffectSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	/*
	 * The component is named in the editor, not here. Resolving it in display mode would mount one
	 * lookup per table row — the N+1 `controller-surfaces.md` §5 forbids — and the id itself is not
	 * an answer to any question an operator has.
	 */
	const summary = $derived(current === null ? '—' : current.kind === 'PAID' ? 'Paid' : 'Unpaid');

	const companyId = $derived(
		typeof props.row?.company_id === 'string' ? props.row.company_id : null
	);
	const componentsQuery = $derived(
		companyId == null
			? null
			: client.db.pay_components.findMany({
					where: { company_id: { eq: companyId } },
					orderBy: { code: 'asc' },
					limit: 500
				})
	);
	const componentOptions = $derived(
		(componentsQuery?.current ?? []).map((component) => ({
			value: component.norbital_id,
			label: [component.code, component.name].filter((part) => part).join(' · ') || '—',
			search_term: `${component.code ?? ''} ${component.name ?? ''}`
		}))
	);

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(kind: EffectKind): Value {
		switch (kind) {
			case 'PAID':
				return { kind: 'PAID' };
			case 'UNPAID':
				return { kind: 'UNPAID', component_id: '' };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: EffectKind | null): void {
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
			Payroll effect
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select an effect"
				onValueChange={selectKind}
			/>
		</label>
		{#if current?.kind === 'UNPAID'}
			<label class="grid gap-1.5 text-sm font-medium">
				Deducted on
				<Combobox
					ariaLabel="Deduction component"
					options={componentOptions}
					value={current.component_id === '' ? null : current.component_id}
					disabled={disabled || companyId == null}
					searchPlaceholder="Search pay components…"
					emptyPlaceholder="Choose the component that carries the lost wage"
					clientConfig={{
						isLoading: componentsQuery?.loading ?? false,
						error: componentsQuery?.error?.message ?? null
					}}
					onValueChange={(value) =>
						emit({ kind: 'UNPAID', component_id: typeof value === 'string' ? value : '' })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
