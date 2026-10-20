<!--
@component
One field of the enclosing `Form` by name: its label, help, the kind's editor (or an `editor` snippet) and its error.
Readonly, it is a label over the value as copyable text: no field chrome, and no `editor` snippet.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Value, Kind } from '../kinds/kind.js';

	/** What a `Field editor` snippet receives: the field's value and kind, typed by context in the generated alias. */
	export type FieldEditor = {
		value: Value;
		kind: Kind;
		name: string;
		disabled: boolean;
		error?: string;
		onChange(next: Value): void;
		/** The id the field's label points at: give it to the control the snippet renders, so it is named by the label. */
		id: string;
	};
	/**
	 * One field of the enclosing `Form`, by its exposed name (§3.6). Without an `editor` it renders the kind's editor;
	 * `address` names the text field a `point` field's geocoded address is written to.
	 */
	export type FieldProps = {
		name: string;
		label?: string | undefined;
		help?: string;
		helpPosition?: 'below' | 'label';
		editor?: Snippet<[FieldEditor]>;
		address?: string;
		class?: string;
		/** Overrides the enclosing `Form`/`Fieldset`; a field the viewer cannot write (no update grant, a state lock) is readonly whatever this says. */
		readonly?: boolean;
		/** Overrides the enclosing `Form`/`Fieldset`: the editor stays, muted and inert. */
		disabled?: boolean;
		/** A table cell keeps its accessible field name while the column heading supplies its visible label. */
		dense?: true;
	};
</script>

<script lang="ts">
	import { cn, provideControls, provideFieldControl, uiText } from '../primitives/utils.js';
	import Editor from '../kinds/editor.svelte';
	import Show from '../kinds/show.svelte';
	import { useForm } from './form-state.svelte.js';
	import { claimSectionField } from './section.svelte';
	import { useBolt } from '../client/context.js';
	import { useFieldLabel } from '../collection/context.js';

	let {
		name,
		label,
		help,
		helpPosition = 'below',
		editor,
		address,
		class: className,
		readonly,
		disabled,
		dense
	}: FieldProps = $props();
	const form = useForm();
	// svelte-ignore state_referenced_locally -- a field's name is fixed for its life
	claimSectionField(name);
	const t = uiText();
	const bolt = useBolt();
	const fieldLabel = useFieldLabel();
	const labelClass = $derived(dense ? 'sr-only' : 'text-xs font-medium text-muted-foreground');
	const field = $derived(form?.spec.fields.find((f) => f.name === name));
	const id = $props.id();
	// svelte-ignore state_referenced_locally -- a field's editor snippet is fixed for its life
	if (editor) provideFieldControl(() => `${id}-${name}`);
	// what the engine knows the viewer cannot write is a floor no prop lifts; a save in flight holds every editor
	const controls = provideControls(() => ({
		readonly:
			form !== undefined &&
			(form.spec.readonly === true || field?.readonly === true || form.locked(name))
				? true
				: readonly,
		disabled: form?.pending === true ? true : disabled
	}));
</script>

{#if form === undefined}
	<p class="text-xs text-destructive">Field "{name}" is outside a Form.</p>
{:else if field === undefined || !form.readable(name)}
	<!-- not exposed to this caller in this mode: nothing to edit (a field the grant hides is not an empty field) -->
{:else if field.kind.hidden}
	<!-- hidden: the host fills it -->
{:else if controls.readonly}
	<div
		class={cn('grid content-start gap-1', className)}
		data-field={name}
		data-readonly
		role="group"
		aria-labelledby={`${id}-${name}-label`}
	>
		<span id={`${id}-${name}-label`} class={labelClass}
			>{label ??
				fieldLabel(
					name,
					field.kind.label
				)}{#if helpPosition === 'label' && (help ?? field.kind.help)}
				<span class="text-meta font-normal">{help ?? field.kind.help}</span>{/if}</span
		>
		<Show
			readonly
			kind={field.kind}
			value={form.get(name)}
			{name}
			row={form.row}
			relation={field.relation}
			{address}
		/>
		{#if form.mode !== 'view' && form.spec.readonly !== true}
			{#each [...new Set( [...form.restrictions(name), ...(field.reason === undefined ? [] : [field.reason])] )] as reason (reason)}<p
					class="text-meta"
					data-field-restriction={reason}
				>
					{t(reason)}
				</p>{/each}
		{/if}
		{#if helpPosition === 'below' && (help ?? field.kind.help)}<p class="text-meta">
				{help ?? field.kind.help}
			</p>{/if}
	</div>
{:else}
	{@const disabled = controls.disabled}
	{@const rawError = form.errors.get(name)}
	{@const error = rawError === undefined ? undefined : bolt.t(rawError)}
	<div class={cn('grid content-start gap-2', className)} data-field={name}>
		<label id={`${id}-${name}-label`} for={`${id}-${name}`} class={labelClass}>
			{label ?? fieldLabel(name, field.kind.label)}
			{#if !field.kind.optional && field.kind.default === undefined && field.kind.kind !== 'bool'}<span
					class="text-destructive"
					aria-label={t('required')}>*</span
				>{/if}
			{#if helpPosition === 'label' && (help ?? field.kind.help)}
				<span class="text-meta font-normal">{help ?? field.kind.help}</span>{/if}
		</label>
		{#if editor}
			{@render editor({
				value: form.get(name),
				kind: field.kind,
				name,
				id: `${id}-${name}`,
				disabled,
				error,
				onChange: (v) => form.set(name, v)
			})}
		{:else}
			<Editor
				kind={field.kind}
				value={form.get(name)}
				onChange={(v) => form.set(name, v)}
				{name}
				id={`${id}-${name}`}
				labelledby={`${id}-${name}-label`}
				{disabled}
				errors={form.errors}
				row={form.row}
				relation={field.relation}
				{address}
				onAddress={address === undefined ? undefined : (a) => form.set(address, a)}
			/>
		{/if}
		{#if helpPosition === 'below' && (help ?? field.kind.help)}<p class="text-meta">
				{help ?? field.kind.help}
			</p>{/if}
		{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
	</div>
{/if}
