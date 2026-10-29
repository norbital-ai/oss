<!--
@component
One field of the enclosing `Form` by name: its label, help, the kind's editor (or an `editor` snippet) and its error.
Readonly, it is a label over the value as copyable text (or a `view` snippet): no field chrome, and no `editor` snippet.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import { required, wideKind, type Value, type Kind } from '../kinds/kind.js';

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
		/** The field's description: an info button beside the label, never text under the control. */
		help?: string;
		editor?: Snippet<[FieldEditor]>;
		/** Renders the value when the field is readonly, in place of the kind's display (a value shaped by another record's schema, say). */
		view?: Snippet<[Pick<FieldEditor, 'value' | 'kind' | 'name' | 'id'>]>;
		address?: string;
		class?: string;
		/**
		 * `true` keeps this field read-only while its `Form` edits (shown as its value, never saved from here):
		 * `<Field name="reference" readonly />`. It only adds: `false` never lifts an enclosing readonly form, and a field
		 * the viewer cannot write (no update grant, a state lock) is readonly whatever this says.
		 */
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
	import DescriptionHint from './description-hint.svelte';
	import Show from '../kinds/show.svelte';
	import { useForm } from './form-state.svelte.js';
	import { claimSectionField } from './section.svelte';
	import { useBolt } from '../client/context.js';
	import { useFieldLabel } from '../model/context.js';

	let {
		name,
		label,
		help,
		editor,
		view,
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
	const description = $derived(help ?? field?.kind.help);
	// derived from the field's kind as this write mode exposes it (a relation's `optional`, a host-filled create column):
	// a box always holds a value
	const mandatory = $derived(
		field !== undefined && required(field.kind) && field.kind.kind !== 'bool'
	);
	const id = $props.id();
	// a structure, code or long text takes its grid's whole row; short fields flow beside each other
	const wide = $derived(field !== undefined && wideKind(field.kind));
	// svelte-ignore state_referenced_locally -- a field's editor snippet is fixed for its life
	if (editor) provideFieldControl(() => `${id}-${name}`);
	// what the engine knows the viewer cannot write is a floor no prop lifts (nor does it lift an enclosing readonly); a
	// save in flight holds every editor
	const controls = provideControls(() => ({
		readonly:
			form !== undefined &&
			(form.spec.readonly === true || field?.readonly === true || form.locked(name))
				? true
				: readonly,
		disabled: form?.pending === true ? true : disabled
	}));
	// a broken invariant shows like a field error; a check or refusal error on the same key wins
	const errors = $derived.by(() => {
		if (form === undefined || form.semanticErrors.length === 0) return form?.errors;
		const all = new Map(form.errors);
		for (const issue of form.semanticErrors)
			if (!all.has(issue.field)) all.set(issue.field, issue.message);
		return all;
	});
</script>

{#if form === undefined}
	<p class="text-xs text-destructive">Field "{name}" is outside a Form.</p>
{:else if field === undefined || !form.readable(name)}
	<!-- not exposed to this caller in this mode: nothing to edit (a field the grant hides is not an empty field) -->
{:else if field.kind.hidden}
	<!-- hidden: the host fills it -->
{:else if controls.readonly}
	<div
		class={cn('grid min-w-0 content-start gap-1', wide && 'col-span-full', className)}
		data-field={name}
		data-readonly
		role="group"
		aria-labelledby={`${id}-${name}-label`}
	>
		<div class="flex min-w-0 items-center gap-1">
			<span id={`${id}-${name}-label`} class={cn(labelClass, 'min-w-0')}
				>{label ?? fieldLabel(name, field.kind.label)}</span
			>
			{#if description && !dense}<DescriptionHint text={description} />{/if}
		</div>
		{#if view}
			{@render view({ value: form.get(name), kind: field.kind, name, id: `${id}-${name}` })}
		{:else}
			<Show
				readonly
				kind={field.kind}
				value={form.get(name)}
				{name}
				row={form.row}
				relation={field.relation}
				{address}
			/>
		{/if}
		{#if form.mode !== 'view' && form.spec.readonly !== true}
			{#each [...new Set( [...form.restrictions(name), ...(field.reason === undefined ? [] : [field.reason])] )] as reason (reason)}<p
					class="text-meta"
					data-field-restriction={reason}
				>
					{t(reason)}
				</p>{/each}
		{/if}
	</div>
{:else}
	{@const disabled = controls.disabled}
	{@const rawError = errors?.get(name)}
	{@const error = rawError === undefined ? undefined : bolt.t(rawError)}
	<!-- the control the label names says it is required, whether the kind's editor or an `editor` snippet renders it -->
	<div
		class={cn('grid min-w-0 content-start gap-2', wide && 'col-span-full', className)}
		data-field={name}
		{@attach (node) => {
			const control = node.querySelector(`#${CSS.escape(`${id}-${name}`)}`);
			if (mandatory) control?.setAttribute('aria-required', 'true');
			else control?.removeAttribute('aria-required');
		}}
	>
		<div class="flex min-w-0 items-center gap-1">
			<label id={`${id}-${name}-label`} for={`${id}-${name}`} class={cn(labelClass, 'min-w-0')}>
				{label ?? fieldLabel(name, field.kind.label)}
				{#if mandatory}<span class="text-destructive" aria-label={t('required')}>*</span>{/if}
			</label>
			{#if description && !dense}<DescriptionHint text={description} />{/if}
		</div>
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
				{errors}
				row={form.row}
				relation={field.relation}
				{address}
				onAddress={address === undefined ? undefined : (a) => form.set(address, a)}
			/>
		{/if}
		{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
	</div>
{/if}
