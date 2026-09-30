<!--
@component
One field of the enclosing `Form` by name: its label, help, the kind's editor (or an `editor` snippet) and its error.
Readonly, it is a label over the value as copyable text: no field chrome, and no `editor` snippet.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Json, Kind } from '../kinds/kind.js';

	/** What a `Field editor` snippet receives: the field's value and kind, typed by context in the generated alias. */
	export type FieldEditor = {
		value: Json; kind: Kind; name: string; disabled: boolean; error?: string; onChange(next: Json): void;
		/** The id the field's label points at: give it to the control the snippet renders, so it is named by the label. */
		id: string;
	};
	/**
	 * One field of the enclosing `Form`, by its exposed name (§3.6). Without an `editor` it renders the kind's editor;
	 * `address` names the text field a `point` field's geocoded address is written to.
	 */
	export type FieldProps = {
		name: string; label?: string | undefined; help?: string; editor?: Snippet<[FieldEditor]>; address?: string; class?: string;
		/** Overrides the enclosing `Form`/`Fieldset`; a field the viewer cannot write (no update grant, a state lock) is readonly whatever this says. */
		readonly?: boolean;
		/** Overrides the enclosing `Form`/`Fieldset`: the editor stays, muted and inert. */
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import { cn, provideControls, provideFieldControl, uiText } from '../primitives/utils.js';
	import Editor from '../kinds/editor.svelte';
	import ReadValue from '../kinds/read-value.svelte';
	import { useForm } from './form-state.svelte.js';
	import { humanize } from '../views/model.js';

	let { name, label, help, editor, address, class: className, readonly, disabled }: FieldProps = $props();
	const form = useForm();
	const t = uiText();
	const field = $derived(form?.spec.fields.find((f) => f.name === name));
	const id = $props.id();
	// svelte-ignore state_referenced_locally -- a field's editor snippet is fixed for its life
	if (editor) provideFieldControl(() => `${id}-${name}`);
	// what the engine knows the viewer cannot write is a floor no prop lifts; a save in flight holds every editor
	const controls = provideControls(() => ({
		readonly: form !== undefined && (form.spec.readonly === true || form.locked(name)) ? true : readonly,
		disabled: form?.pending === true ? true : disabled
	}));
</script>

{#if form === undefined}
	<p class="text-xs text-destructive">Field "{name}" is outside a Form.</p>
{:else if field === undefined}
	<!-- not exposed to this caller in this mode: nothing to edit (a field the grant hides is not an empty field) -->
{:else if field.kind.hidden}
	<!-- hidden: the host fills it -->
{:else if controls.readonly}
	<div class={cn('grid content-start gap-1', className)} data-field={name} data-readonly role="group" aria-labelledby={`${id}-${name}-label`}>
		<span id={`${id}-${name}-label`} class="text-xs font-medium text-muted-foreground">{label ?? field.kind.label ?? humanize(name)}</span>
		<ReadValue kind={field.kind} value={form.get(name)} {name} row={form.values} relation={field.relation} {address} />
		{#if help ?? field.kind.help}<p class="text-meta">{help ?? field.kind.help}</p>{/if}
	</div>
{:else}
	{@const disabled = controls.disabled}
	{@const error = form.errors.get(name)}
	<div class={cn('grid gap-1.5', className)} data-field={name}>
		<label id={`${id}-${name}-label`} for={`${id}-${name}`} class="text-sm font-medium">
			{label ?? field.kind.label ?? humanize(name)}
			{#if !field.kind.optional && field.kind.default === undefined && field.kind.kind !== 'bool'}<span class="text-destructive" aria-label={t('required')}>*</span>{/if}
		</label>
		{#if editor}
			{@render editor({ value: form.get(name), kind: field.kind, name, id: `${id}-${name}`, disabled, error, onChange: (v) => form.set(name, v) })}
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
				row={form.values}
				relation={field.relation}
				{address}
				onAddress={address === undefined ? undefined : (a) => form.set(address, a)}
			/>
		{/if}
		{#if help ?? field.kind.help}<p class="text-meta">{help ?? field.kind.help}</p>{/if}
		{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
	</div>
{/if}
