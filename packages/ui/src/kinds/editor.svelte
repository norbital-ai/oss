<!--
@component
The editor of one value by its field kind: every kind's input in one component (derived kinds read-only).
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import { Array as Arr } from 'effect';
	import type { Value, Kind } from './kind.js';
	import type { JsonSchema } from './json-schema.js';
	import type { Where } from '@norbital-ai/std/kind';

	/** The editor of one value by its kind (every §3.3.2 kind; derived kinds render read-only). */
	export type EditorProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		kind: Kind;
		/** JSON Schema for a generated structured editor; omitted infers the stored structure. */
		json_schema?: JsonSchema;
		/** Edit an untyped value as source JSON, retaining invalid text until it parses. */
		raw_json?: boolean;
		value: Value;
		on_change(next: Value): void;
		/** The field's name (file uploads, custom renderers) and the dotted path errors are keyed by. */
		name: string;
		id?: string;
		/** The label naming a control that has no single input to point at (a group of boxes). */
		labelledby?: string;
		/** Shows the value as copyable text (`Show`); an enclosing readonly `Form` or `Field` sets it. */
		readonly?: boolean;
		/** The editor stays, muted and inert; an enclosing disabled `Form` or `Field` sets it. */
		disabled?: boolean;
		/** Problems by dotted path under `name` (`lines.0.amount`), as a refusal or decode reports them. */
		errors?: ReadonlyMap<string, string>;
		/** The row being edited: a money field's currency sibling. */
		row?: { readonly [f: string]: Value };
		/** A `point` field's address sibling: its name in `row` (shown in the search box) and the writer of what is typed or found. */
		address?: string;
		on_address?(address: string | null): void;
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
	import { use_enum_text } from '../model/context.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import { provideControls, ui_text } from '../primitives/utils.js';
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import { field_entry } from './builtin/index.js';
	import TimeInput from './time-input.svelte';
	import { presentation } from './registry.js';
	import { arcOf } from './kind.js';
	import { humanize } from '../text/messages.js';
	import TimeRangeInput from './time-range-input.svelte';
	import Picker from './picker.svelte';
	import StructuredData, { type StructuredDataProps } from './structured-data.svelte';
	import { is_json_schema_document } from './json-schema.js';
	import Show from './show.svelte';
	import TagsInput from './tags-input.svelte';
	import TypedInput from './typed-input.svelte';

	let {
		ctx,
		kind,
		json_schema,
		raw_json = false,
		value,
		on_change,
		name,
		id,
		labelledby,
		readonly,
		disabled: ownDisabled,
		errors,
		row = {},
		address,
		on_address,
		relation
	}: EditorProps = $props();
	const host = $derived(ctx.ui.kinds);
	// an explicit mode here reaches every control of a structured value too
	const controls = provideControls(() => ({ readonly, disabled: ownDisabled }));
	const disabled = $derived(controls.disabled);
	const t = ui_text();
	const words = use_enum_text(() => ctx);
	const v = $derived(value);
	// a declared enum transition offers only the next states (and the current one) once the record has a state
	const enumValues = $derived.by(() => {
		if (kind.kind !== 'enum') return [];
		const from = name === undefined ? '' : String(row[name] ?? '');
		const allowed = kind.transitions?.[from];
		return allowed === undefined ? kind.values : [...new Set([from, ...allowed])];
	});
	const plan = $derived(
		raw_json && (kind.kind === 'json' || kind.kind === 'custom')
			? { ...presentation(kind), editor: 'json' as const }
			: presentation(kind)
	);
	// an arc's chosen target before a record there is picked
	let chosenArm = $state<string | null>(null);
	const invalid = $derived(errors?.has(name) ?? false);
	const str = (x: Value) => (typeof x === 'string' ? x : null);
	// money, file, point and phone render through their built-in custom field, a tenant's custom field through its own
	const field = $derived(field_entry(kind, host));
	const custom = $derived(kind.kind === 'custom' ? field?.entry : undefined);
	const structured = $derived.by((): {
		key: string;
		props: Pick<StructuredDataProps, 'kind' | 'schema' | 'mode' | 'value' | 'row'>;
	} | undefined => {
		if (kind.kind === 'custom' && custom && !raw_json)
			return { key: 'custom', props: { kind: custom.shape, value, mode: 'edit', row } };
		if (kind.kind === 'json' && !raw_json) {
			if (json_schema !== undefined) return { key: 'json-schema', props: { schema: json_schema, value, mode: 'edit', row } };
			if (!kind.shape && is_json_schema_document(v)) return { key: 'schema-document', props: { schema: v, mode: 'schema' } };
			if (kind.shape) return { key: 'json-shape', props: { kind: kind.shape, value, mode: 'edit', row } };
		}
		if (plan.editor === 'schema') return { key: 'kind-schema', props: { kind, value, mode: 'edit', row } };
		if (plan.editor === 'json' && !raw_json) return { key: 'inferred', props: { value, mode: 'edit', row } };
		return undefined;
	});
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

{#if controls.readonly && kind.kind === 'json' && json_schema !== undefined}
	<StructuredData {ctx} schema={json_schema} {value} mode="view" {name} {id} {errors} {row} />
{:else if controls.readonly}
	<Show {ctx} {kind} {value} {name} {row} {relation} {address} {id} readonly />
{:else if relation !== undefined && relation.targets.length > 1}
	<!-- an arc: its target first, then the record there; the value is `{ model, id }` -->
	{@const ref = arcOf(v)}
	{@const arm = chosenArm ?? ref?.model ?? relation.targets[0] ?? ''}
	<div class="grid min-w-0 gap-2 @sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]" data-arc>
		<Combobox
			options={relation.targets.map((target) => ({ value: target, label: humanize(target) }))}
			value={arm}
			on_change={(next) => {
				if (next === null || next === arm) return;
				chosenArm = next;
				on_change(null);
			}}
			{disabled}
			aria-label={humanize(name)}
		/>
		<Picker {ctx}
			of={arm}
			value={ref?.model === arm ? ref.id : null}
			on_change={(next) => on_change(next === null ? null : { model: arm, id: next })}
			{id}
			{disabled}
			{invalid}
		/>
	</div>
{:else if relation !== undefined}
	<Picker {ctx}
		of={relation.targets[0] ?? ''}
		value={str(v)}
		where={relation.where}
		{on_change}
		{id}
		{disabled}
		{invalid}
	/>
{:else if plan.derived}
	<!-- derived and state values are never typed: a state moves by its edges (an action or a board move) -->
	<Show {ctx} {kind} {value} {name} {row} />
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	<Renderer
		{ctx}
		view={{
			mode: 'edit',
			name,
			value: v,
			row,
			kind: field.kind,
			disabled,
			error: errors?.get(name),
			on_change,
			...(id === undefined ? {} : { id }),
			...(address === undefined
				? {}
				: {
						address: {
							value: str(row[address] ?? null),
							...(on_address === undefined ? {} : { on_change: on_address })
						}
					})
		}}
	/>
{:else if plan.editor === 'bool'}
	<Checkbox
		{id}
		checked={v === true}
		on_checked_change={(c) => on_change(c)}
		{disabled}
		aria-invalid={invalid ? 'true' : undefined}
	/>
{:else if plan.editor === 'tags'}
	<TagsInput
		value={Arr.isArray<Value>(v) ? v.map(String) : []}
		{on_change}
		{id}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'zone'}
	<Combobox
		{id}
		options={zones}
		value={str(v)}
		on_change={(z) => on_change(z)}
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
		min_height="2.25rem"
		readonly={disabled}
		{invalid}
		value={str(v) ?? ''}
		aria-label={name}
		aria-labelledby={labelledby}
		on_change={(next) => on_change(next === '' ? null : next)}
	/>
{:else if plan.editor === 'markdown'}
	<MarkdownEditor
		{id}
		value={str(v) ?? ''}
		on_change={(next) => on_change(next === '' ? null : next)}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'textarea' && kind.kind === 'text'}
	<Textarea
		{id}
		value={str(v) ?? ''}
		oninput={(e) => on_change(e.currentTarget.value === '' ? null : e.currentTarget.value)}
		maxlength={kind.max}
		{disabled}
		aria-invalid={invalid ? 'true' : undefined}
	/>
{:else if plan.editor === 'typed'}
	<TypedInput {kind} {value} {on_change} {id} {disabled} {invalid} />
{:else if plan.editor === 'currency'}
	<Combobox
		{id}
		options={currencies}
		value={str(v)}
		on_change={(c) => on_change(c)}
		clearable={kind.optional === true}
		searchable
		{disabled}
		{invalid}
		aria-label={t('currency')}
	/>
{:else if plan.editor === 'time' && (kind.kind === 'date' || kind.kind === 'instant' || kind.kind === 'time')}
	{#if Arr.isArray<Value>(v)}
		<TimeInput
			{ctx}
			of={kind.kind}
			precision={kind.precision}
			value={v.map(str)}
			{on_change}
			{id}
			{disabled}
			{invalid}
		/>
	{:else}
		<TimeInput
			{ctx}
			of={kind.kind}
			precision={kind.precision}
			value={str(v)}
			{on_change}
			{id}
			{disabled}
			{invalid}
		/>
	{/if}
{:else if plan.editor === 'period' && kind.kind === 'period'}
	<TimeRangeInput
		{ctx}
		of={kind.of}
		precision={kind.precision}
		{value}
		{on_change}
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
					on_checked_change={(c) =>
						on_change(c ? [...list, option] : list.filter((x) => x !== option))}
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
		on_change={(o) => on_change(o)}
		clearable={kind.optional === true}
		{disabled}
		{invalid}
	/>
{:else if plan.editor === 'id' && kind.kind === 'ref' && typeof kind.to === 'string'}
	<Picker {ctx} of={kind.to} value={str(v)} {on_change} where={kind.where} {id} {disabled} {invalid} />
{:else if structured !== undefined}
	{#key structured.key}
		<StructuredData {ctx} {...structured.props} {on_change} {name} {id} {disabled} {errors} />
	{/key}
{:else if plan.editor === 'json'}
	<!-- Explicit raw/source editing, also used by the shared renderer for unconstrained leaves. -->
	<CodeEditor
		{id}
		language="json"
		min_height="4.5rem"
		invalid={jsonError !== null || invalid}
		value={jsonText}
		readonly={disabled}
		on_change={(text) => {
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
			on_change(parsed.success);
		}}
	/>
	{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
{:else}
	<Show {ctx} {kind} {value} {name} {row} />
{/if}
