<!--
@component
One field of the enclosing `Form` by name: its label, help, the kind's editor (or an `editor` snippet) and its error.
Readonly, it is a label over the value as copyable text (or a `view` snippet): no field chrome, and no `editor` snippet.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Snippet } from 'svelte';
	import { required, wideKind, type Value, type Kind } from '../kinds/kind.js';

	/** What a `Field editor` snippet receives: the field's value and kind, typed by context in the generated alias. */
	export type FieldEditor = {
		value: Value;
		kind: Kind;
		name: string;
		disabled: boolean;
		error?: string;
		on_change(next: Value): void;
		/** The id the field's label points at: give it to the control the snippet renders, so it is named by the label. */
		id: string;
		/** The enclosing form: a custom editor reads sibling fields (a schema version, a currency) through it. */
		form: FormState;
	};
	/**
	 * One field of the enclosing `Form`, by its exposed name. Without an `editor` it renders the kind's editor;
	 * `address` names the text field a `point` field's geocoded address is written to.
	 */
	export type FieldProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
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
		/** Overrides the enclosing `Form`: the editor stays, muted and inert. */
		disabled?: boolean;
		/** A table cell keeps its accessible field name while the column heading supplies its visible label. */
		dense?: true;
	};
</script>

<script lang="ts">
	import { cn, provideControls, provideFieldControl, ui_text } from '../primitives/utils.js';
	import Editor from '../kinds/editor.svelte';
	import FieldControl from './field-control.svelte';
	import Show from '../kinds/show.svelte';
	import { use_form, type FormState } from './form-state.svelte.js';
	import { claimSectionField } from './section.svelte';
	import { bolt_of } from '../client/context.js';
	import { use_field_label, use_field_help } from '../model/context.js';

	let {
		ctx,
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
	const form = use_form();
	// svelte-ignore state_referenced_locally -- a field's name is fixed for its life
	claimSectionField(name);
	const t = ui_text();
	const bolt = $derived(bolt_of(ctx));
	const fieldLabel = use_field_label(() => ctx);
	const field_help = use_field_help(() => ctx);
	const errors = $derived(form?.field_errors);
	const rawError = $derived(errors?.get(name));
	const error = $derived(rawError === undefined ? undefined : bolt.t(rawError));
	const field = $derived(form?.spec.fields.find((f) => f.name === name));
	// derived from the field's kind as this write mode exposes it (a relation's `optional`, a host-filled create column):
	// a box always holds a value
	const mandatory = $derived(
		field !== undefined && required(field.kind) && field.kind.kind !== 'bool'
	);
	const id = $props.id();
	// a structure, a map, code, long text or a custom datatype's editor takes its grid's whole row (short fields flow
	// beside each other), and is a large control: it may hold a section alone
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
</script>

{#if form === undefined}
	<p class="text-xs text-destructive">Field "{name}" is outside a Form.</p>
{:else if field === undefined || !form.readable(name)}
	<!-- not exposed to this caller in this mode: nothing to edit (a field the grant hides is not an empty field) -->
{:else if field.kind.hidden}
	<!-- hidden: the host fills it -->
{:else if controls.readonly}
	<FieldControl
		id={`${id}-${name}`}
		label={label ?? fieldLabel(name, field.kind.label)}
		help={help ?? field_help(name, field.kind.help)}
		{error}
		{dense}
		readonly
		dirty={false}
		class={cn(wide && 'col-span-full', className)}
		data-field={name}
		data-field-large={wide || undefined}
	>
		{#if view}
			{@render view({ value: form.get(name), kind: field.kind, name, id: `${id}-${name}` })}
		{:else}
			<Show {ctx}
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
	</FieldControl>
{:else}
	{@const disabled = controls.disabled}
	<FieldControl
		id={`${id}-${name}`}
		label={label ?? fieldLabel(name, field.kind.label)}
		help={help ?? field_help(name, field.kind.help)}
		{error}
		{dense}
		required={mandatory}
		dirty={form.field_dirty(name)}
		class={cn(wide && 'col-span-full', className)}
		data-field={name}
		data-field-large={wide || undefined}
	>
		{#if editor}
			{@render editor({
				value: form.get(name),
				kind: field.kind,
				name,
				id: `${id}-${name}`,
				disabled,
				error,
				on_change: (v) => form.set(name, v),
				form
			})}
		{:else}
			<Editor {ctx}
				kind={field.kind}
				value={form.get(name)}
				on_change={(v) => form.set(name, v)}
				{name}
				id={`${id}-${name}`}
				labelledby={`${id}-${name}-label`}
				{disabled}
				{errors}
				row={form.row}
				relation={field.relation}
				{address}
				on_address={address === undefined ? undefined : (a) => form.set(address, a)}
			/>
		{/if}
	</FieldControl>
{/if}
