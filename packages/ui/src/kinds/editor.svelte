<!--
@component
The editor of one value by its field kind: every kind's input in one component (derived kinds read-only).
-->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import type { Value, Kind } from './kind.js';
	import type { JsonSchema } from './json-schema.js';
	import type { Where } from '@norbital-ai/std/kind';

	/** The editor of one value by its kind (every §3.3.2 kind; derived kinds render read-only). */
	export type EditorProps = {
		kind: Kind;
		/** JSON Schema for a generated structured editor; omitted infers the stored structure. */
		jsonSchema?: JsonSchema;
		/** Edit an untyped value as source JSON, retaining invalid text until it parses. */
		rawJson?: boolean;
		value: Value;
		onChange(next: Value): void;
		/** The field's name (file uploads, custom renderers) and the dotted path errors are keyed by. */
		name: string;
		id?: string;
		/** The label naming a control that has no single input to point at (a group of boxes). */
		labelledby?: string;
		/** Shows the value as copyable text (`Show`); an enclosing readonly `Form`, `Fieldset` or `Field` sets it. */
		readonly?: boolean;
		/** The editor stays, muted and inert; an enclosing disabled `Form`, `Fieldset` or `Field` sets it. */
		disabled?: boolean;
		/** Problems by dotted path under `name` (`lines.0.amount`), as a refusal or decode reports them. */
		errors?: ReadonlyMap<string, string>;
		/** The row being edited: a money field's currency sibling. */
		row?: { readonly [f: string]: Value };
		/** A `point` field's address sibling: its name in `row` (shown in the search box) and the writer of what is typed or found. */
		address?: string;
		onAddress?(address: string | null): void;
		/** One-relation target(s), when `kind` is the FK column of a relationship. */
		relation?: { targets: readonly string[]; where?: Where | undefined };
	};
	// IANA zones grouped by region; "kuala lumpur" finds Asia/Kuala_Lumpur. Built once, not per mounted editor.
	const zones = (
		typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
	).map((z) => ({ value: z, label: z, group: z.split('/')[0], keywords: z.replace(/[_/]/g, ' ') }));
	const codes =
		typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
</script>

<script lang="ts">
	import { Schema } from 'effect';
	import { watch } from 'runed';
	import CodeEditor from '../editors/code-editor.svelte';
	import MarkdownEditor from '../editors/markdown-editor.svelte';
	import { useEnumText } from '../model/context.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import { fieldEntry } from './builtin/index.js';
	import TimeInput from './time-input.svelte';
	import { presentation } from './registry.js';
	import { arcOf } from './kind.js';
	import { humanize } from '../text/messages.js';
	import TimeRangeInput from './time-range-input.svelte';
	import Picker from './picker.svelte';
	import StructuredData from './structured-data.svelte';
	import { isJsonSchemaDocument } from './json-schema.js';
	import Show from './show.svelte';
	import TagsInput from './tags-input.svelte';
	import TypedInput from './typed-input.svelte';

	let {
		kind,
		jsonSchema,
		rawJson = false,
		value,
		onChange,
		name,
		id,
		labelledby,
		readonly,
		disabled: ownDisabled,
		errors,
		row = {},
		address,
		onAddress,
		relation
	}: EditorProps = $props();
	const host = useKinds();
	// an explicit mode here reaches every control of a structured value too
	const controls = provideControls(() => ({ readonly, disabled: ownDisabled }));
	const disabled = $derived(controls.disabled);
	const t = uiText();
	const words = useEnumText();
	const v = $derived(value);
	// a declared enum transition offers only the next states (and the current one) once the record has a state
	const enumValues = $derived.by(() => {
		if (kind.kind !== 'enum') return [];
		const from = name === undefined ? '' : String(row[name] ?? '');
		const allowed = kind.transitions?.[from];
		return allowed === undefined ? kind.values : [...new Set([from, ...allowed])];
	});
	const plan = $derived(
		rawJson && (kind.kind === 'json' || kind.kind === 'custom')
			? { ...presentation(kind), editor: 'json' as const }
			: presentation(kind)
	);
	// an arc's chosen target before a record there is picked
	let chosenArm = $state<string | null>(null);
	const invalid = $derived(errors?.has(name) ?? false);
	const str = (x: Value) => (typeof x === 'string' ? x : null);
	// money, file, point and phone render through their built-in custom field, a tenant's custom field through its own
	const field = $derived(fieldEntry(kind, host));
	const custom = $derived(kind.kind === 'custom' ? field?.entry : undefined);
	// ISO 4217 codes by name, each with its country's flag (EUR's is the EU's): the currency picker
	const currencies = $derived.by(() => {
		const names = new Intl.DisplayNames([host.locale ?? 'en'], { type: 'currency' });
		return codes.map((c) => {
			const flag =
				COUNTRY_CODES.includes(c.slice(0, 2)) || c.startsWith('EU')
					? `${flagOf(c.slice(0, 2))} `
					: '';
			return {
				value: c,
				label: `${flag}${c}`,
				description: names.of(c) ?? c,
				keywords: names.of(c) ?? ''
			};
		});
	});
	let jsonText = $state(''),
		jsonError = $state<string | null>(null),
		jsonLast: Value | undefined;
	watch.pre([() => kind.kind, () => value, () => v], () => {
		if ((kind.kind === 'json' || kind.kind === 'custom') && value !== jsonLast) {
			jsonText = v === null ? '' : JSON.stringify(v, null, 2);
			jsonError = null;
			jsonLast = value;
		}
	});
</script>

{#if controls.readonly && kind.kind === 'json' && jsonSchema !== undefined}
	<StructuredData schema={jsonSchema} {value} mode="view" {name} {id} {errors} {row} />
{:else if controls.readonly}
	<Show {kind} {value} {name} {row} {relation} {address} {id} readonly />
{:else if relation !== undefined && relation.targets.length > 1}
	<!-- an arc: its target first, then the record there; the value is `{ model, id }` -->
	{@const ref = arcOf(v)}
	{@const arm = chosenArm ?? ref?.model ?? relation.targets[0] ?? ''}
	<div class="grid min-w-0 gap-2 @sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]" data-arc>
		<Combobox
			options={relation.targets.map((target) => ({ value: target, label: humanize(target) }))}
			value={arm}
			onChange={(next) => {
				if (next === null || next === arm) return;
				chosenArm = next;
				onChange(null);
			}}
			{disabled}
			aria-label={humanize(name)}
		/>
		<Picker
			of={arm}
			value={ref?.model === arm ? ref.id : null}
			onChange={(next) => onChange(next === null ? null : { model: arm, id: next })}
			{id}
			{disabled}
			{invalid}
		/>
	</div>
{:else if relation !== undefined}
	<Picker
		of={relation.targets[0] ?? ''}
		value={str(v)}
		where={relation.where}
		{onChange}
		{id}
		{disabled}
		{invalid}
	/>
{:else if plan.derived}
	<!-- derived and state values are never typed: a state moves by its edges (an action or a board move) -->
	<Show {kind} {value} {name} {row} />
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	<Renderer
		view={{
			mode: 'edit',
			name,
			value: v,
			row,
			kind: field.kind,
			disabled,
			error: errors?.get(name),
			onChange,
			...(id === undefined ? {} : { id }),
			...(address === undefined
				? {}
				: {
						address: {
							value: str(row[address] ?? null),
							...(onAddress === undefined ? {} : { onChange: onAddress })
						}
					})
		}}
	/>
{:else if plan.editor === 'bool'}
	<Checkbox
		{id}
		checked={v === true}
		onCheckedChange={(c) => onChange(c)}
		{disabled}
		aria-invalid={invalid ? 'true' : undefined}
	/>
{:else if plan.editor === 'tags'}
	<TagsInput
		value={Arr.isArray<Value>(v) ? v.map(String) : []}
		{onChange}
		{id}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'zone'}
	<Combobox
		{id}
		options={zones}
		value={str(v)}
		onChange={(z) => onChange(z)}
		clearable={kind.optional === true}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'code'}
	<!-- a CEL expression: code, wrapped at the field's width, one line high until it grows -->
	<CodeEditor
		{id}
		language="javascript"
		wrap
		minHeight="2.25rem"
		readonly={disabled}
		{invalid}
		value={str(v) ?? ''}
		aria-label={name}
		aria-labelledby={labelledby}
		onChange={(next) => onChange(next === '' ? null : next)}
	/>
{:else if plan.editor === 'markdown'}
	<MarkdownEditor
		{id}
		value={str(v) ?? ''}
		onChange={(next) => onChange(next === '' ? null : next)}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'textarea' && kind.kind === 'text'}
	<Textarea
		{id}
		value={str(v) ?? ''}
		oninput={(e) => onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
		maxlength={kind.max}
		{disabled}
		aria-invalid={invalid ? 'true' : undefined}
	/>
{:else if plan.editor === 'typed'}
	<TypedInput {kind} {value} {onChange} {id} {disabled} {invalid} />
{:else if plan.editor === 'currency'}
	<Combobox
		{id}
		options={currencies}
		value={str(v)}
		onChange={(c) => onChange(c)}
		clearable={kind.optional === true}
		searchable
		{disabled}
		{invalid}
		aria-label={t('currency')}
	/>
{:else if plan.editor === 'time' && (kind.kind === 'date' || kind.kind === 'instant' || kind.kind === 'time')}
	{#if Arr.isArray<Value>(v)}
		<TimeInput
			of={kind.kind}
			precision={kind.precision}
			value={v.map(str)}
			{onChange}
			{id}
			{disabled}
			{invalid}
		/>
	{:else}
		<TimeInput
			of={kind.kind}
			precision={kind.precision}
			value={str(v)}
			{onChange}
			{id}
			{disabled}
			{invalid}
		/>
	{/if}
{:else if plan.editor === 'period' && kind.kind === 'period'}
	<TimeRangeInput
		of={kind.of}
		precision={kind.precision}
		{value}
		{onChange}
		{id}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'enumMany' && kind.kind === 'enum'}
	<div class="flex flex-wrap gap-3" role="group" {id} aria-labelledby={labelledby}>
		{#each kind.values as option (option)}
			{@const list = Arr.isArray<Value>(v) ? v.map(String) : []}
			<label class="inline-flex items-center gap-1.5 text-sm">
				<Checkbox
					checked={list.includes(option)}
					onCheckedChange={(c) =>
						onChange(c ? [...list, option] : list.filter((x) => x !== option))}
					{disabled}
				/>
				{words(option, name)}
			</label>
		{/each}
	</div>
{:else if plan.editor === 'enum' && kind.kind === 'enum'}
	<Combobox
		{id}
		options={enumValues.map((o) => ({ value: o, label: words(o, name) }))}
		value={str(v)}
		onChange={(o) => onChange(o)}
		clearable={kind.optional === true}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'id' && kind.kind === 'id'}
	<Picker of={kind.of} value={str(v)} {onChange} where={kind.where} {id} {disabled} {invalid} />
{:else if kind.kind === 'custom' && custom && !rawJson}
	<StructuredData
		kind={custom.shape}
		{value}
		mode="edit"
		{onChange}
		{name}
		{id}
		{disabled}
		{errors}
		{row}
	/>
{:else if kind.kind === 'json' && jsonSchema !== undefined && !rawJson}
	<StructuredData
		schema={jsonSchema}
		{value}
		mode="edit"
		{onChange}
		{name}
		{id}
		{disabled}
		{errors}
		{row}
	/>
{:else if kind.kind === 'json' && !kind.shape && isJsonSchemaDocument(v) && !rawJson}
	<StructuredData schema={v} mode="schema" {onChange} {name} {id} {disabled} {errors} />
{:else if kind.kind === 'json' && kind.shape && !rawJson}
	<StructuredData
		kind={kind.shape}
		{value}
		mode="edit"
		{onChange}
		{name}
		{id}
		{disabled}
		{errors}
		{row}
	/>
{:else if plan.editor === 'schema'}
	<StructuredData {kind} {value} mode="edit" {onChange} {name} {id} {disabled} {errors} {row} />
{:else if plan.editor === 'json' && !rawJson}
	<StructuredData {value} mode="edit" {onChange} {name} {id} {disabled} {errors} {row} />
{:else if plan.editor === 'json'}
	<!-- Explicit raw/source editing, also used by the shared renderer for unconstrained leaves. -->
	<CodeEditor
		{id}
		language="json"
		minHeight="4.5rem"
		invalid={jsonError !== null || invalid}
		value={jsonText}
		readonly={disabled}
		onChange={(text) => {
			jsonText = text;
			const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(
				text.trim() === '' ? 'null' : text
			);
			if (parsed._tag === 'Failure') {
				jsonError = t('invalid');
				return;
			}
			jsonError = null;
			jsonLast = parsed.success;
			onChange(parsed.success);
		}}
	/>
	{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
{:else}
	<Show {kind} {value} {name} {row} />
{/if}
