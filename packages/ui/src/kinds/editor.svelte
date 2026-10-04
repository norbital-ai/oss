<!--
@component
The editor of one value by its field kind: every kind's input in one component (derived kinds read-only).
-->
<script lang="ts" module>
	import type { Json, Kind } from './kind.js';
	import type { JsonSchema } from './json-schema.js';

	/** The editor of one value by its kind (every §3.3.2 kind; derived kinds render read-only). */
	export type EditorProps = {
		kind: Kind;
		/** JSON Schema for the next-generation JSON editor; omitted retains the raw editor. */
		jsonSchema?: JsonSchema;
		value: Json;
		onChange(next: Json): void;
		/** The field's name (file uploads, custom renderers) and the dotted path errors are keyed by. */
		name: string;
		id?: string;
		/** The label naming a control that has no single input to point at (a group of boxes). */
		labelledby?: string;
		/** Shows the value as copyable text (`ReadValue`); an enclosing readonly `Form`, `Fieldset` or `Field` sets it. */
		readonly?: boolean;
		/** The editor stays, muted and inert; an enclosing disabled `Form`, `Fieldset` or `Field` sets it. */
		disabled?: boolean;
		/** Problems by dotted path under `name` (`lines.0.amount`), as a refusal or decode reports them. */
		errors?: ReadonlyMap<string, string>;
		/** The row being edited: a money field's currency sibling. */
		row?: { readonly [f: string]: Json };
		/** A `point` field's address sibling: its name in `row` (shown in the search box) and the writer of what is typed or found. */
		address?: string;
		onAddress?(address: string | null): void;
		/** One-relation target(s), when `kind` is the FK column of a relationship. */
		relation?: { targets: readonly string[] };
	};
	// IANA zones grouped by region; "kuala lumpur" finds Asia/Kuala_Lumpur. Built once, not per mounted editor.
	const zones = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])
		.map((z) => ({ value: z, label: z, group: z.split('/')[0], keywords: z.replace(/[_/]/g, ' ') }));
	const codes = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [];
</script>

<script lang="ts">
	import CodeEditor from '../editors/code-editor.svelte';
	import MarkdownEditor from '../editors/markdown-editor.svelte';
	import { useEnumText } from '../views/bolt.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import { fieldEntry } from './builtin/index.js';
	import DateInput from './date-input.svelte';
	import { DERIVED, STRUCTURED, untag } from './kind.js';
	import PeriodInput from './period-input.svelte';
	import Picker from './picker.svelte';
	import ReadValue from './read-value.svelte';
	import SchemaEditor from './schema-editor.svelte';
	import JsonSchemaForm from './json-schema-form.svelte';
	import Show from './show.svelte';
	import TagsInput from './tags-input.svelte';
	import TypedInput from './typed-input.svelte';

	let { kind, jsonSchema, value, onChange, name, id, labelledby, readonly, disabled: ownDisabled, errors, row = {}, address, onAddress, relation }: EditorProps = $props();
	const host = useKinds();
	// an explicit mode here reaches every control of a structured value too
	const controls = provideControls(() => ({ readonly, disabled: ownDisabled }));
	const disabled = $derived(controls.disabled);
	const t = uiText();
	const words = useEnumText();
	const v = $derived(untag(value));
	const invalid = $derived(errors?.has(name) ?? false);
	const str = (x: Json) => (typeof x === 'string' ? x : null);
	// money, file, point and phone render through their built-in custom field, a tenant's custom field through its own
	const field = $derived(fieldEntry(kind, host));
	const custom = $derived(kind.kind === 'custom' ? field?.entry : undefined);
	// ISO 4217 codes by name, each with its country's flag (EUR's is the EU's): staging's currency picker
	const currencies = $derived.by(() => {
		const names = new Intl.DisplayNames([host.locale ?? 'en'], { type: 'currency' });
		return codes.map((c) => {
			const flag = COUNTRY_CODES.includes(c.slice(0, 2)) || c.startsWith('EU') ? `${flagOf(c.slice(0, 2))} ` : '';
			return { value: c, label: `${flag}${c}`, description: names.of(c) ?? c, keywords: names.of(c) ?? '' };
		});
	});
	let jsonText = $state(''), jsonError = $state<string | null>(null), jsonLast: Json | undefined;
	$effect.pre(() => {
		if ((kind.kind === 'json' || kind.kind === 'custom') && value !== jsonLast) { jsonText = v === null ? '' : JSON.stringify(v, null, 2); jsonError = null; jsonLast = value; }
	});
</script>

{#if controls.readonly}
	<ReadValue {kind} {value} {name} {row} {relation} {address} {id} />
{:else if relation !== undefined}
	<!-- ponytail: a polymorphic ref edits its first target only; a target switch belongs here when a template needs one -->
	<Picker of={relation.targets[0]!} value={str(v)} onChange={onChange} {id} {disabled} {invalid} />
{:else if DERIVED.has(kind.kind) || kind.kind === 'state'}
	<!-- derived and state values are never typed: a state moves by its edges (an action or a board move) -->
	<Show {kind} {value} {name} {row} />
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	<Renderer view={{ mode: 'edit', name, value: v, row, kind: field.kind, disabled, error: errors?.get(name), onChange, ...(id === undefined ? {} : { id }),
		...(address === undefined ? {} : { address: { value: str(untag(row[address] ?? null)), ...(onAddress === undefined ? {} : { onChange: onAddress }) } }) }} />
{:else if kind.kind === 'bool'}
	<Checkbox {id} checked={v === true} onCheckedChange={(c) => onChange(c)} {disabled} aria-invalid={invalid ? 'true' : undefined} />
{:else if kind.kind === 'text' && kind.many}
	<TagsInput value={Array.isArray(v) ? v.map(String) : []} {onChange} {id} {disabled} {invalid} />
{:else if kind.kind === 'text' && kind.format === 'zone'}
	<Combobox {id} options={zones} value={str(v)} onChange={(z) => onChange(z)} clearable={kind.optional === true} {disabled} {invalid} />
{:else if kind.kind === 'text' && kind.format === 'markdown'}
	<MarkdownEditor {id} value={str(v) ?? ''} onChange={(next) => onChange(next === '' ? null : next)} {disabled} {invalid} />
{:else if kind.kind === 'text' && (kind.max ?? 0) > 200}
	<Textarea {id} value={str(v) ?? ''} oninput={(e) => onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)} maxlength={kind.max} {disabled} aria-invalid={invalid ? 'true' : undefined} />
{:else if ['text', 'int', 'number', 'decimal', 'duration'].includes(kind.kind)}
	<TypedInput {kind} {value} {onChange} {id} {disabled} {invalid} />
{:else if kind.kind === 'currency'}
	<Combobox {id} options={currencies} value={str(v)} onChange={(c) => onChange(c)} clearable={kind.optional === true} searchable {disabled} {invalid} aria-label={t('currency')} />
{:else if kind.kind === 'date' || kind.kind === 'instant' || kind.kind === 'time'}
	<DateInput of={kind.kind} precision={kind.precision} value={str(v)} {onChange} {id} {disabled} {invalid} />
{:else if kind.kind === 'period'}
	<PeriodInput of={kind.of} precision={kind.precision} {value} {onChange} {id} {disabled} {invalid} />
{:else if kind.kind === 'enum' && kind.many}
	<div class="flex flex-wrap gap-3" role="group" {id} aria-labelledby={labelledby}>
		{#each kind.values as option (option)}
			{@const list = Array.isArray(v) ? v.map(String) : []}
			<label class="inline-flex items-center gap-1.5 text-sm">
				<Checkbox checked={list.includes(option)} onCheckedChange={(c) => onChange(c ? [...list, option] : list.filter((x) => x !== option))} {disabled} />
				{words(option, name)}
			</label>
		{/each}
	</div>
{:else if kind.kind === 'enum'}
	<Combobox {id} options={kind.values.map((o) => ({ value: o, label: words(o, name) }))} value={str(v)} onChange={(o) => onChange(o)} clearable={kind.optional === true} {disabled} {invalid} />
{:else if kind.kind === 'id'}
	<Picker of={kind.of} value={str(v)} {onChange} where={kind.where as { readonly [key: string]: Json } | undefined} {id} {disabled} {invalid} />
{:else if kind.kind === 'custom' && custom}
	<SchemaEditor kind={custom.shape} {value} {onChange} {name} {disabled} {errors} />
{:else if kind.kind === 'json' && jsonSchema !== undefined}
	<JsonSchemaForm schema={jsonSchema} {value} {onChange} {name} {id} {disabled} {errors} />
{:else if kind.kind === 'json' && kind.shape}
	<SchemaEditor kind={kind.shape} {value} {onChange} {name} {disabled} {errors} />
{:else if STRUCTURED.has(kind.kind)}
	<SchemaEditor {kind} {value} {onChange} {name} {disabled} {errors} />
{:else if kind.kind === 'json' || kind.kind === 'custom'}
	<!-- an untyped json value, or a custom field this page was not given: edited as JSON text -->
	<CodeEditor
		{id}
		language="json"
		minHeight="4.5rem"
		invalid={jsonError !== null || invalid}
		value={jsonText}
		readonly={disabled}
		onChange={(text) => {
			jsonText = text;
			try { const parsed = text.trim() === '' ? null : (JSON.parse(text) as Json); jsonError = null; jsonLast = parsed; onChange(parsed); }
			catch { jsonError = t('invalid'); }
		}}
	/>
	{#if jsonError}<p class="text-xs text-destructive">{jsonError}</p>{/if}
{:else}
	<Show {kind} {value} {name} {row} />
{/if}
