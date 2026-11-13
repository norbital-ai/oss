<!--
@component
One compact schema, value, editor and inline comparison. Record lists use the model Table itself;
leaf values retain the workspace's native kinds, custom renderers and inherited controls.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import { item_kind } from '@norbital-ai/store/kind';
	import type { Value, Kind } from './kind.js';
	import type { KindsHost } from './context.js';
	import type { JsonSchema } from './json-schema.js';
	import type { ArrayKeys } from './structured-data.js';
	import type { Values } from '../model/types.js';
	import { Schema } from 'effect';
	import { input_schema } from '@norbital-ai/store/kind';
	/** A schema or native kind with current data, editing controls, or a prior value for comparison. */
	export type StructuredDataProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		schema?: JsonSchema;
		kind?: Kind;
		value?: Value;
		before?: Value;
		mode?: 'view' | 'edit' | 'schema' | 'diff';
		on_change?(next: Value): void;
		name?: string;
		id?: string;
		readonly?: boolean;
		disabled?: boolean;
		errors?: ReadonlyMap<string, string>;
		row?: Values;
		/** Prior row context for native currency and related-value formatting. */
		before_row?: Values;
		/** Explicit row identities, indexed by JSON Pointer. Unkeyed lists compare by position. */
		array_keys?: ArrayKeys;
		changes_only?: boolean;
		/** A new record: schema defaults fill as the editor opens; an edit offers them by control instead. */
		create?: boolean;
		/** Internal recursion context. */
		root?: JsonSchema;
		path?: string;
		depth?: number;
		heading?: string;
		/** `false`: one border only, the outer one: a first-level section lies flat inside it instead of being its own card. */
		frame?: boolean;
	};
	type DataRow = { readonly [key: string]: Value; readonly id: string; readonly at: number };
	type SchemaRow = {
		readonly [key: string]: Value;
		id: string;
		field: string;
		type: string;
		details: string;
		level: number;
		section: boolean;
		required: boolean;
	};
	const node = (schema: JsonSchema) => (typeof schema === 'boolean' ? {} : schema);
	const unitTitle = (label: string, schema: JsonSchema): string => {
		const unit = node(schema).unit;
		return unit?.trim() && !label.trim().endsWith(`(${unit})`) ? `${label} (${unit})` : label;
	};
	const enumLike = (value: unknown): value is string =>
		typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
	const enumList = (value: unknown): readonly string[] | null =>
		Array.isArray(value) && value.length > 0 && value.every(enumLike) ? value : null;
	/** A JSON leaf fits a compact column unless it is a nested object or a list of objects. */
	const compactJson = (kind: Kind, value: Value | undefined): boolean => {
		if (kind.kind !== 'json') return !wideKind(kind);
		if (Array.isArray(value))
			return !value.some((item) => item !== null && typeof item === 'object');
		return value === null || value === undefined || typeof value !== 'object';
	};

	const pointer = (path: string, key: string | number) =>
		`${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
	const shape = (kind: Kind | undefined, value: Value | undefined): Kind | undefined => {
		if (kind?.many === true) return kind;
		if (kind?.kind === 'json') return kind.shape ? shape(kind.shape, value) : undefined;
		if (kind?.kind === 'union' && 'arms' in kind) {
			const object = dataEntries(value);
			return {
				kind: 'object',
				fields: {
					[kind.by]: { kind: 'enum', values: Object.keys(kind.arms) },
					...(kind.arms[String(object?.[kind.by])] ?? {})
				}
			};
		}
		if (kind?.kind === 'union' && 'of' in kind)
			return shape(
				kind.of.find((arm) => value !== undefined && Schema.is(input_schema(arm))(value)) ??
					kind.of[0],
				value
			);
		return kind;
	};
	const visible = (
		value: Value | undefined,
		kind: Kind | undefined,
		host: KindsHost
	): Value => {
		if (value === undefined) return null;
		const native = kind ? field_entry(kind, host) : undefined;
		if (native?.entry.renderer) return native.entry.label ?? kind?.label ?? 'Details';
		const planned = shape(native?.entry.shape ?? kind, value);
		if (planned !== kind && planned?.kind === 'custom') return visible(value, planned, host);
		if (Array.isArray(value))
			return value.map((item) =>
				visible(item, planned?.many === true ? item_kind(planned) : undefined, host)
			);
		const entries = dataEntries(value);
		if (!entries) return value;
		const fields =
			planned?.kind === 'object'
				? Object.entries(planned.fields)
						.filter(([, kind]) => !kind.hidden)
						.map(([key]) => key)
				: Object.keys(entries);
		return Object.fromEntries(
			fields.map((key) => [
				key,
				visible(
					entries[key],
					planned?.kind === 'object'
						? planned.fields[key]
						: planned?.kind === 'record'
							? planned.of
							: undefined,
					host
				)
			])
		);
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { watch } from 'runed';
	import Self from './structured-data.svelte';
	import Editor from './editor.svelte';
	import Show from './show.svelte';
	import Badge from '../primitives/badge/badge.svelte';
	import CodeEditor from '../editors/code-editor.svelte';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Button from '../primitives/button/button.svelte';
	import Table, { type Col } from '../table/Table.svelte';
	import Overflow from '../cell/Overflow.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { field_entry } from './builtin/index.js';
	import { armValue, format_value, inferKind, initial, wideKind } from './kind.js';
	import { FIELD_TYPES, json_schema_from_rows, json_schema_rows } from './json-schema-rows.js';
	import { provideControls, ui_text } from '../primitives/utils.js';
	import { humanize } from '../text/messages.js';
	import {
		jsonSchemaGroups,
		jsonSchemaInitial,
		json_schema_kind,
		nullableJsonSchema
	} from './json-schema.js';
	import {
		data_changed,
		dataDefaults,
		dataEntries,
		data_equal,
		infer_json_schema,
		kind_json_schema,
		pair_data_rows,
		structuredSchema
	} from './structured-data.js';
	import { use_form } from '../form/form-state.svelte.js';
	import FieldControl, { useFieldPresentation } from '../form/field-control.svelte';
	import { optional_bolt_of } from '../client/context.js';
	import { useSectionTitle } from '../form/section.svelte';

	let {
		ctx,
		schema,
		kind: declaredKind,
		value,
		before,
		mode,
		on_change,
		name = '',
		id,
		readonly,
		disabled,
		errors: ownErrors,
		row = {},
		before_row,
		array_keys,
		changes_only = false,
		create,
		root,
		path = '',
		depth = 0,
		heading,
		frame = true
	}: StructuredDataProps = $props();
	const uid = $props.id();
	const form = use_form();
	const bolt = $derived(optional_bolt_of(ctx));
	const presentation = useFieldPresentation();
	const errors = $derived(ownErrors ?? form?.field_errors);
	const errorFor = (name: string) => {
		const error = errors?.get(name);
		return error === undefined ? undefined : (bolt?.t(error) ?? error);
	};
	const newRecord = $derived(create ?? form?.mode === 'create');
	const controlId = $derived(id ?? uid);
	const controls = provideControls(() => ({ readonly, disabled }));
	const host = $derived(ctx.ui.kinds);
	const t = ui_text();
	const currentMode = $derived(mode ?? (on_change ? 'edit' : 'view'));
	const editing = $derived(currentMode === 'edit' && !controls.readonly && !!on_change);
	const held = $derived(value === undefined ? before : value);
	const kind = $derived.by(() => {
		const next = shape(declaredKind, held),
			previous = shape(declaredKind, before);
		if (currentMode === 'diff' && next?.kind === 'object' && previous?.kind === 'object')
			return {
				...next,
				fields: Object.fromEntries(
					[...Object.entries(previous.fields), ...Object.entries(next.fields)].filter(
						([key]) => !previous.fields[key]?.hidden && !next.fields[key]?.hidden
					)
				)
			};
		return next;
	});
	const document = $derived(
		root ?? schema ?? (kind ? kind_json_schema(kind) : infer_json_schema(held))
	);
	const rawSchema = $derived(schema ?? (kind ? kind_json_schema(kind) : infer_json_schema(held)));
	const resolved = $derived(structuredSchema(rawSchema, document, held));
	const spec = $derived(node(resolved));
	const locked = $derived(!editing || spec.readOnly === true);
	let seeded = false;
	watch(
		() => {
			if (currentMode !== 'edit' || seeded || !newRecord || depth !== 0 || on_change === undefined)
				return null;
			return { next: dataDefaults(rawSchema, value, document), on_change };
		},
		(seed) => {
			if (seed === null) return;
			seeded = true;
			if (seed.next !== undefined) seed.on_change(seed.next);
		}
	);
	const plan = $derived(kind ?? json_schema_kind(resolved));
	const native = $derived(plan.kind === 'custom' ? field_entry(plan, host) : undefined);
	const childName = (key: string | number) => (name === '' ? String(key) : `${name}.${key}`);
	const title = (key: string, child: JsonSchema, childKind?: Kind) =>
		unitTitle(childKind?.label ?? node(child).title ?? humanize(key), child);
	/** One line for a complex cell; its fields open in the bounded editor popover. */
	const summaryOf = (held: Value | undefined): string => {
		if (held === undefined || held === null) return '—';
		if (Array.isArray(held)) return `${held.length} ${held.length === 1 ? 'item' : 'items'}`;
		const entries = dataEntries(held);
		if (entries === undefined) return format_value(held, host.locale);
		const fields = Object.entries(entries);
		return (
			fields
				.slice(0, 2)
				.map(([key, item]) => `${humanize(key)}: ${format_value(item, host.locale)}`)
				.join(' · ') + (fields.length > 2 ? ' …' : '')
		);
	};
	function structure(
		s: JsonSchema,
		k: Kind | undefined,
		next: Value | undefined,
		previous?: Value
	): 'object' | 'array' | undefined {
		if (depth >= 24) return;
		const leaf = node(structuredSchema(s, document, next === undefined ? previous : next));
		if (currentMode === 'edit' && (leaf.const !== undefined || leaf.enum !== undefined)) return;
		// A variant switch is one replacement; each side keeps its own renderer and visibility rules.
		if (
			currentMode === 'diff' &&
			previous !== undefined &&
			next !== undefined &&
			(JSON.stringify(structuredSchema(s, document, previous)) !==
				JSON.stringify(structuredSchema(s, document, next)) ||
				JSON.stringify(shape(k, previous)) !== JSON.stringify(shape(k, next)))
		)
			return;
		const held = next === undefined ? previous : next;
		const entries = dataEntries(held);
		if (
			currentMode === 'diff' &&
			(next === undefined || previous === undefined) &&
			(Array.isArray(held)
				? held.length === 0
				: entries !== undefined && Object.keys(entries).length === 0)
		)
			return;
		const declared = shape(k, next === undefined ? previous : next);
		const planned =
			declared ??
			json_schema_kind(structuredSchema(s, document, next === undefined ? previous : next));
		if (planned.kind === 'custom' && field_entry(planned, host)) return;
		if (currentMode === 'diff' && previous !== undefined) {
			const previousKind =
				shape(k, previous) ?? json_schema_kind(structuredSchema(s, document, previous));
			if (
				previousKind.kind === 'custom'
					? !!field_entry(previousKind, host)
					: previousKind.many !== true &&
						!['object', 'record', 'json', 'union'].includes(previousKind.kind)
			)
				return;
		}
		const oldShape =
			previous === undefined
				? undefined
				: dataEntries(previous)
					? 'object'
					: Array.isArray(previous)
						? 'array'
						: 'scalar';
		const newShape =
			next === undefined
				? undefined
				: dataEntries(next)
					? 'object'
					: Array.isArray(next)
						? 'array'
						: 'scalar';
		if (
			currentMode === 'diff' &&
			oldShape !== undefined &&
			newShape !== undefined &&
			oldShape !== newShape
		)
			return;
		if (
			currentMode !== 'edit' &&
			(newShape === 'scalar' || (currentMode !== 'diff' && next === undefined))
		)
			return;
		if (planned.many === true) return newShape === 'object' ? undefined : 'array';
		if (planned.kind === 'object' || planned.kind === 'record')
			return newShape === 'array' ? undefined : 'object';
		if (!['json', 'custom', 'union'].includes(planned.kind)) return;
		const actual = newShape ?? oldShape;
		if (actual === 'object' || actual === 'array') return actual;
		const types = node(s).type;
		return types === 'object' ? 'object' : types === 'array' ? 'array' : undefined;
	}
	const layout = $derived(
		structure(rawSchema, declaredKind, value, currentMode === 'diff' ? before : undefined)
	);
	const object = $derived(dataEntries(value) ?? {});
	const previousObject = $derived(dataEntries(before) ?? {});
	const objectKind = $derived(kind?.kind === 'object' ? kind : undefined);
	const fieldKind = (key: string) =>
		objectKind?.fields[key] ?? (kind?.kind === 'record' ? kind.of : undefined);
	// the enclosing section's title, read once: a root object whose only field repeats it shows that field headless
	// svelte-ignore state_referenced_locally -- a structure's depth is fixed for its life
	const sectionTitle = depth === 0 ? useSectionTitle() : undefined;
	const repeatsSection = (heading: string) =>
		sectionTitle !== undefined &&
		fields.length === 1 &&
		heading.trim().toLowerCase() === sectionTitle.trim().toLowerCase();
	const fields = $derived.by(() => {
		const keys = objectKind
			? Object.keys(objectKind.fields).filter((key) => !objectKind.fields[key]?.hidden)
			: [
					...new Set([
						...Object.keys(spec.properties ?? {}),
						...Object.keys(previousObject),
						...Object.keys(object)
					])
				];
		return keys
			.map((key) => {
				const kind = fieldKind(key);
				return {
					key,
					schema: structuredSchema(
						spec.properties?.[key] ??
							(kind
								? kind_json_schema(kind)
									: infer_json_schema(object[key] === undefined ? previousObject[key] : object[key])),
						document
					),
					kind
				};
			})
			.filter(
				(field) =>
					!changes_only ||
					currentMode !== 'diff' ||
					data_changed(
						previousObject[field.key],
						object[field.key],
						array_keys,
						pointer(path, field.key)
					)
			);
	});
	const groups = $derived(
		jsonSchemaGroups(
			{ ...spec, properties: Object.fromEntries(fields.map((field) => [field.key, field.schema])) },
			document
		).map((group) => ({
			...group,
			fields: group.fields.flatMap((member) => {
				const field = fields.find((field) => field.key === member.name);
				return field ? [field] : [];
			})
		}))
	);
	function assign(key: string, next: Value) {
		const tagged = declaredKind?.kind === 'json' ? declaredKind.shape : declaredKind;
		if (
			tagged?.kind === 'union' &&
			'arms' in tagged &&
			key === tagged.by &&
			typeof next === 'string'
		) {
			on_change?.(armValue(tagged, next));
			return;
		}
		const field = fields.find((f) => f.key === key);
		if (next === null && field && field.kind === undefined && !nullableJsonSchema(field.schema))
			on_change?.(Object.fromEntries(Object.entries(object).filter(([k]) => k !== key)));
		else on_change?.({ ...object, [key]: next });
	}
	const list = $derived<readonly Value[]>(Array.isArray(value) ? value : []);
	/** A list of plain values (numbers, text, flags): read, it is one line of chips, not a one-column table. */
	const scalarList = (value: Value | undefined): value is readonly Value[] =>
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => item === null || typeof item !== 'object');
	const previousList = $derived<readonly Value[]>(Array.isArray(before) ? before : []);
	const itemKind = $derived(kind?.many === true ? item_kind(kind) : undefined);
	const itemSchema = $derived(
		spec.items ??
			(itemKind
				? kind_json_schema(itemKind)
				: (node(infer_json_schema([...previousList, ...list])).items ?? true))
	);
	const schemaAt = (index: number): JsonSchema => spec.prefixItems?.[index] ?? itemSchema;
	const pairs = $derived(
		currentMode === 'diff'
			? pair_data_rows(
					previousList,
					list,
					array_keys?.[path] ?? (kind?.many === true ? kind.key : undefined)
				)
			: list.map((item, index) => ({
					before: undefined,
					value: item,
					beforeIndex: undefined,
					index
				}))
	);
	const visiblePairs = $derived(
		pairs.filter(
			(pair) =>
				!changes_only ||
				currentMode !== 'diff' ||
				data_changed(
					pair.before,
					pair.value,
					array_keys,
					pointer(path, pair.index ?? pair.beforeIndex ?? 0)
				)
		)
	);
	const recordList = $derived(
		(itemKind === undefined
			? !visiblePairs.some((pair) =>
					[pair.before, pair.value].some((value) => {
						if (value === undefined) return false;
						const plan = json_schema_kind(structuredSchema(itemSchema, document, value));
						return plan.kind === 'custom' && field_entry(plan, host) !== undefined;
					})
				)
			: itemKind.kind === 'object' || (itemKind.kind === 'json' && itemKind.shape === undefined)) &&
			(visiblePairs.length > 0
				? visiblePairs.every((pair) =>
						[pair.before, pair.value]
							.filter((value) => value !== undefined)
							.every((value) => !!dataEntries(value))
					)
				: json_schema_kind(structuredSchema(itemSchema, document)).kind === 'object')
	);
	const itemSpec = $derived(node(structuredSchema(itemSchema, document)));
	const itemObjectKind = $derived(itemKind?.kind === 'object' ? itemKind : undefined);
	const listFields = $derived(
		recordList
			? itemObjectKind
				? Object.keys(itemObjectKind.fields).filter((key) => !itemObjectKind.fields[key]?.hidden)
				: [
						...new Set([
							...Object.keys(itemSpec.properties ?? {}),
							...visiblePairs.flatMap((pair) => [
								...Object.keys(dataEntries(pair.value) ?? {}),
								...Object.keys(dataEntries(pair.before) ?? {})
							])
						])
					]
			: ['value']
	);
	const tableRows = $derived<DataRow[]>(visiblePairs.map((_, at) => ({ id: String(at), at })));
	const tableColumns = $derived<readonly Col<DataRow>[]>(
		listFields.map((field) => {
			const spec = structuredSchema(itemSpec.properties?.[field] ?? true, document);
			return {
				field,
				label: recordList
					? title(field, spec, itemObjectKind?.fields[field]) +
						(!locked && itemSpec.required?.includes(field) ? '*' : '')
					: t('schemaValue'),
				width: (itemObjectKind?.fields[field] ?? json_schema_kind(spec)).kind === 'bool' ? 104 : 200,
				cell: dataCell
			};
		})
	);
	function listChange(at: number, field: string, next: Value) {
		const pair = visiblePairs[at];
		if (pair?.index === undefined) return;
		const item = dataEntries(pair.value) ?? {};
		const child = itemSpec.properties?.[field] ?? true;
		const updated = recordList
			? next === null && itemObjectKind?.fields[field] === undefined && !nullableJsonSchema(child)
				? Object.fromEntries(Object.entries(item).filter(([key]) => key !== field))
				: { ...item, [field]: next }
			: next;
		on_change?.(list.map((value, index) => (index === pair.index ? updated : value)));
	}
	const rowChange = (entry: DataRow) => {
		const pair = visiblePairs[entry.at];
		return !pair || currentMode !== 'diff'
			? undefined
			: pair.before === undefined
				? 'structured-row-added'
				: pair.value === undefined
					? 'structured-row-removed'
					: undefined;
	};
	const bounds = $derived({
		min: spec.minItems ?? (kind?.many === true ? (kind.min_items ?? 0) : 0),
		max: spec.maxItems ?? (kind?.many === true ? kind.max_items : undefined)
	});
	const changed = $derived(currentMode === 'diff' && !data_equal(before, value));
	const leafKind = $derived.by((): Kind => {
		if (
			plan.kind !== 'json' &&
			plan.kind !== 'object' &&
			plan.many !== true &&
			plan.kind !== 'record' &&
			plan.kind !== 'union' &&
			(plan.kind !== 'custom' || native !== undefined)
		)
			return plan;
		const inferred = inferKind(held ?? null);
		return inferred.many === true || ['object', 'record', 'union'].includes(inferred.kind)
			? { kind: 'json' }
			: inferred;
	});
	let extraKey = $state('');
	const extraErrors = $derived(
		[...(errors?.entries() ?? [])].filter(
			([key]) =>
				key !== name &&
				(name === '' || key.startsWith(name + '.')) &&
				!Object.keys(spec.properties ?? {}).some(
					(field) => key === childName(field) || key.startsWith(childName(field) + '.')
				)
		)
	);
	function schemaRows(
		input: JsonSchema,
		at = '',
		level = 0,
		required = false,
		seen = new Set<JsonSchema>()
	): SchemaRow[] {
		const resolved = structuredSchema(input, document),
			spec = node(resolved);
		const recursive = seen.has(resolved) || level > 24;
		const object = spec.type === 'object' || !!spec.properties;
		const array = spec.type === 'array' || spec.items !== undefined;
		const name = unitTitle(
			spec.title ?? (at ? humanize(at.split('/').at(-1) ?? '') : t('schemaValue')),
			resolved
		);
		const primitive = (typeof spec.type === 'string' ? [spec.type] : (spec.type ?? []))
			.filter((type) => !['object', 'array'].includes(type))
			.join(' | ');
		const details = [
			spec.format ?? '',
			spec.enum ? spec.enum.map((v) => JSON.stringify(v)).join(', ') : '',
			spec.minimum !== undefined ? `≥ ${spec.minimum}` : '',
			spec.maximum !== undefined ? `≤ ${spec.maximum}` : '',
			recursive ? '$ref' : ''
		]
			.filter(Boolean)
			.join(' · ');
		const own: SchemaRow = {
			id: at || '/',
			field: name,
			type: object || array ? '' : primitive || '—',
			details,
			level,
			section: object || array,
			required
		};
		if (recursive) return [own];
		const nextSeen = new Set([...seen, resolved]);
		if (object)
			return [
				...(at ? [own] : []),
				...Object.entries(spec.properties ?? {}).flatMap(([key, child]) =>
					schemaRows(
						child,
						pointer(at, key),
						level + (at ? 1 : 0),
						spec.required?.includes(key) ?? false,
						nextSeen
					)
				)
			];
		if (array && spec.prefixItems !== undefined)
			return [
				...(at ? [own] : []),
				...spec.prefixItems.flatMap((child, index) =>
					schemaRows(child, pointer(at, index), level + (at ? 1 : 0), false, nextSeen)
				)
			];
		if (array && spec.items !== undefined)
			return [
				...(at ? [own] : []),
				...schemaRows(spec.items, pointer(at, 'items'), level + (at ? 1 : 0), false, nextSeen)
			];
		const composition = spec.allOf ?? spec.oneOf ?? spec.anyOf;
		if (!spec.type && composition !== undefined)
			return composition.flatMap((child, index) =>
				schemaRows(child, pointer(at, index), level, required, nextSeen)
			);
		return [own];
	}
	const schemaFields = $derived(currentMode === 'schema' ? schemaRows(resolved) : []);
	const authorSchema = $derived<JsonSchema>({
		type: 'array',
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['path', 'type'],
			properties: {
				path: { type: 'string', title: t('schemaKey') },
				type: { type: 'string', enum: [...FIELD_TYPES], title: t('schemaType') },
				label: { type: 'string', title: t('schemaLabel') },
				required: { type: 'boolean', title: t('required') },
				values: { type: 'string', title: t('schemaValues') },
				help: { type: 'string', title: t('schemaHelp') }
			}
		}
	});
	const schemaColumns: readonly Col<SchemaRow>[] = [
		{ field: 'field', label: t('schemaField'), width: 260, cell: schemaField },
		{ field: 'type', label: t('schemaType'), width: 140 },
		{ field: 'details', label: t('schemaValues'), width: 300 }
	];
</script>

{#snippet schemaField({ row }: { row: SchemaRow })}
	<span
		class:font-medium={row.section}
		class="text-muted-foreground"
		style:padding-left={`${row.level * 24}px`}
		>{row.field}{#if row.required}<span class="ml-0.5 text-destructive" aria-label={t('required')}
				>*</span
			>{/if}</span
	>
{/snippet}

{#snippet dataSelf(
	entry: DataRow,
	field: string,
	next: Value | undefined,
	previous: Value | undefined,
	nativeKind: Kind | undefined,
	child: JsonSchema,
	index: number,
	row: Values,
	before_row: Values | undefined
)}
	<Self {ctx}
		schema={child}
		kind={nativeKind}
		value={next}
		before={previous}
		mode={currentMode}
		on_change={locked ? undefined : (next) => listChange(entry.at, field, next)}
		name={childName(recordList ? `${index}.${field}` : index)}
		id={`${controlId}-${entry.at}-${field}`}
		disabled={controls.disabled}
		readonly={locked}
		{errors}
		{row}
		{before_row}
		{array_keys}
		{changes_only}
		create={newRecord}
		root={document}
		path={recordList ? pointer(pointer(path, index), field) : pointer(path, index)}
		depth={depth + 1}
		{frame}
	/>
{/snippet}

{#snippet dataCell({
	row: entry,
	field
}: {
	row: DataRow;
	value: Value | undefined;
	field: string;
})}
	{@const pair = visiblePairs[entry.at]}
	{#if pair}
		{@const previous = recordList ? dataEntries(pair.before)?.[field] : pair.before}
		{@const next = recordList ? dataEntries(pair.value)?.[field] : pair.value}
		{@const nativeKind = recordList ? itemObjectKind?.fields[field] : itemKind}
		{@const index = pair.index ?? pair.beforeIndex ?? 0}
		{@const indexed = node(
			structuredSchema(
				schemaAt(index),
				document,
				pair.value === undefined ? pair.before : pair.value
			)
		)}
		{@const child = recordList
			? (indexed.properties?.[field] ??
				(nativeKind
					? kind_json_schema(nativeKind)
					: infer_json_schema(next === undefined ? previous : next)))
			: schemaAt(index)}
		{@const held = dataEntries(pair.value) ?? row}
		{@const heldBefore = dataEntries(pair.before) ?? before_row}
		<!-- a value of a native kind (a period, a money, a point) keeps its own editor and renderer in the cell; only a
		     structure opens the popover -->
		{@const cellKind = nativeKind ?? json_schema_kind(child)}
		{@const complex =
			recordList &&
			(cellKind.many === true ||
				['object', 'record', 'union', 'json'].includes(cellKind.kind) ||
				(cellKind.kind === 'custom' && !field_entry(cellKind, host))) &&
			(dataEntries(next) !== undefined ||
				(Array.isArray(next) && !(currentMode === 'view' && scalarList(next))))}
		{#snippet cellValue()}
			{@render dataSelf(entry, field, next, previous, nativeKind, child, index, held, heldBefore)}
		{/snippet}
		<div class="group/cell relative w-full min-w-0">
			{#if !complex}<label class="sr-only" for={`${controlId}-${entry.at}-${field}`}
					>{recordList ? title(field, child, nativeKind) : 'Item'} {index + 1}</label
				>{/if}
			{#if complex}
				<Popover.Root>
					<Popover.Trigger
						class="text-muted-foreground hover:text-foreground flex max-w-full min-w-0 items-center gap-1 text-left"
						aria-label={`${t('expand')} ${recordList ? title(field, child, nativeKind) : field}`}
						data-structured-expand
					>
						<span class="truncate">{summaryOf(next)}</span>
						<!-- the expand mark shows on its cell's hover or focus (always on touch) -->
						<Icon
							icon="lucide:maximize-2"
							class="size-3 shrink-0 opacity-0 group-focus-within/cell:opacity-100 group-hover/cell:opacity-100"
						/>
					</Popover.Trigger>
					<Popover.Content
						align="start"
						class="max-h-[min(32rem,var(--bits-popover-content-available-height,80vh))] w-[min(44rem,calc(100vw-2rem))] overflow-auto p-3"
						data-structured-editor
					>
						{@render cellValue()}
					</Popover.Content>
				</Popover.Root>
			{:else if currentMode === 'view' && typeof next === 'string' && (nativeKind === undefined || (nativeKind.kind === 'text' && nativeKind.format === undefined))}
				<Overflow text={next}>
					{@render cellValue()}
				</Overflow>
			{:else if currentMode === 'view' && typeof next === 'string' && nativeKind?.kind === 'text'}
				<!-- an expression or formatted text previews as one line; the popover renders it whole -->
				<Overflow text={next}>
					<code class="font-mono">{next.replace(/\s+/g, ' ')}</code>
					{#snippet full()}
						{@render cellValue()}
					{/snippet}
				</Overflow>
			{:else if currentMode === 'view'}
				<!-- every row keeps one line's height: a taller value clamps and opens whole -->
				<Overflow>
					{@render cellValue()}
				</Overflow>
			{:else}
				{@render cellValue()}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet trailing(entry: DataRow)}
	<div class="flex items-center">
		{#if !recordList}<Button
				size="icon"
				variant="ghost"
				title="Move up"
				aria-label="Move up"
				disabled={controls.disabled || entry.at === 0}
				onclick={() => {
					const index = visiblePairs[entry.at]?.index;
					if (index === undefined || index <= 0) return;
					const previous = list[index - 1], current = list[index];
					if (previous === undefined || current === undefined) return;
					on_change?.(list.map((item, at) => at === index ? previous : at === index - 1 ? current : item));
				}}><Icon icon="lucide:arrow-up" class="size-3.5" /></Button
			>{/if}
		<Button
			size="icon"
			variant="ghost"
			title={`${t('remove')} ${entry.at + 1}`}
			disabled={controls.disabled || list.length <= bounds.min}
			onclick={() => {
				const index = visiblePairs[entry.at]?.index;
				if (index !== undefined) on_change?.(list.filter((_, at) => at !== index));
			}}
			><Icon icon="lucide:x" class="size-3.5" /><span class="sr-only"
				>{t('remove')} {entry.at + 1}</span
			></Button
		>
	</div>
{/snippet}

{#snippet fieldSelf(field: (typeof fields)[number], heading: string | undefined)}
	<Self {ctx}
		schema={field.schema}
		kind={field.kind}
		value={object[field.key]}
		before={previousObject[field.key]}
		mode={currentMode}
		on_change={locked ? undefined : (next) => assign(field.key, next)}
		name={childName(field.key)}
		id={`${controlId}-${field.key}`}
		disabled={controls.disabled}
		readonly={locked}
		{errors}
		row={object}
		before_row={previousObject}
		{array_keys}
		{changes_only}
		create={newRecord}
		root={document}
		path={pointer(path, field.key)}
		depth={depth + 1}
		{frame}
		{heading}
	/>
{/snippet}

{#snippet fieldRows(members: typeof fields)}
	<div class="structured-fields" class:structured-fields-compact={currentMode === 'view'}>
		{#each members as field (field.key)}
			{@const child = node(field.schema)}
			{@const nested = structure(
				field.schema,
				field.kind,
				object[field.key],
				currentMode === 'diff' ? previousObject[field.key] : undefined
			)}
			{#if nested && !(locked && currentMode === 'view' && scalarList(object[field.key]))}
				{@render fieldSelf(field, repeatsSection(title(field.key, field.schema, field.kind)) ? undefined : title(field.key, field.schema, field.kind))}
			{:else}
				<div
					class="structured-field"
					class:structured-field-wide={!compactJson(
						field.kind ?? json_schema_kind(field.schema),
						object[field.key]
					)}
					data-schema-field={childName(field.key)}
				>
					<FieldControl
						id={`${controlId}-${field.key}`}
						label={title(field.key, field.schema, field.kind)}
						help={field.kind?.help ?? child.description}
						error={errorFor(childName(field.key))}
						readonly={locked}
						required={spec.required?.includes(field.key)}
					>
						<div class="structured-field-value">
							{@render fieldSelf(field, undefined)}
							{#if !locked && !spec.required?.includes(field.key) && Object.hasOwn(object, field.key) && child.readOnly !== true}<button
									class="structured-remove-field"
									type="button"
									aria-label={`${t('remove')} ${title(field.key, field.schema, field.kind)}`}
									disabled={controls.disabled}
									onclick={() =>
										on_change?.(
											Object.fromEntries(
												Object.entries(object).filter(([key]) => key !== field.key)
											)
										)}><Icon icon="lucide:x" class="size-3.5" /></button
								>{/if}
						</div>
					</FieldControl>
				</div>
			{/if}
		{/each}
	</div>
{/snippet}

{#snippet fieldsBody()}
	{#each groups as group, index (index)}
		{#if group.title || group.advanced}
			<details
				class="structured-section"
				open={!group.advanced ||
					group.fields.some((field) =>
						[...(errors?.keys() ?? [])].some(
							(key) => key === childName(field.key) || key.startsWith(childName(field.key) + '.')
						)
					)}
			>
				<summary
					><Icon icon="lucide:chevron-right" class="size-4 shrink-0" /><span
						>{group.title || 'Advanced'}</span
					></summary
				>
				<div class="structured-section-body">{@render fieldRows(group.fields)}</div>
			</details>
		{:else}{@render fieldRows(group.fields)}{/if}
	{/each}
	{#if !fields.length}<p class="px-3 py-2 text-sm text-muted-foreground">
			{currentMode === 'diff' ? 'No changes' : 'Empty object'}
		</p>{/if}
	{#if !locked && !objectKind && spec.additionalProperties !== false}
		<details
			class="structured-properties"
			open={extraErrors.length > 0}
			data-section={`${controlId}:properties`}
			data-open={extraErrors.length > 0}
		>
			<summary class="cursor-pointer px-3 py-2 text-sm text-muted-foreground"
				>{t(extraErrors.length ? 'additionalProperties' : 'addProperty')}</summary
			>
			<div class="flex items-center gap-2 px-3 pb-2">
				<input
					class="border-input bg-background min-w-0 flex-1 rounded-sm border px-2 py-1 text-sm"
					aria-label={t('propertyName')}
					placeholder={t('propertyName')}
					bind:value={extraKey}
					disabled={controls.disabled}
				/><Button
					variant="ghost"
					disabled={controls.disabled || !extraKey.trim() || Object.hasOwn(object, extraKey.trim())}
					onclick={() => {
						on_change?.({
							...object,
							[extraKey.trim()]: kind?.kind === 'record' ? initial(kind.of) : ''
						});
						extraKey = '';
					}}>{t('add')}</Button
				>
			</div>
			{#each extraErrors as [key, message] (key)}<p
					class="px-3 pb-2 text-sm text-destructive"
					role="alert"
				>
					{key}: {message}
				</p>{/each}
		</details>
	{/if}
{/snippet}

{#snippet listBody()}
	{#if tableRows.length}<Table {ctx}
			of={tableRows}
			columns={tableColumns}
			controlled
			embedded
			layout="grid"
			toolbar={false}
			key={`structured:${name || controlId}`}
			row_class={rowChange}
			row_trailing={locked ? undefined : trailing}
		/>
	{:else}<p class="px-3 py-2 text-sm text-muted-foreground">
			{currentMode === 'diff' && changes_only ? 'No changes' : 'Empty array'}
		</p>{/if}
	{#if !locked}<Button
			class="m-1 justify-self-start text-muted-foreground"
			variant="ghost"
			disabled={controls.disabled || (bounds.max !== undefined && list.length >= bounds.max)}
			onclick={() =>
				on_change?.([
					...list,
					itemKind ? initial(itemKind) : jsonSchemaInitial(schemaAt(list.length), document)
				])}><Icon icon="lucide:plus" class="size-3.5" />{t('add')}</Button
		>{/if}
{/snippet}

{#snippet shown(held: Value | undefined, previous = false)}
	{@const schema = structuredSchema(rawSchema, document, held)}
	{@const entries = dataEntries(held)}
	{@const enumItems = enumList(held)}
	{@const declared = shape(declaredKind, held) ?? json_schema_kind(schema)}
	{@const field = field_entry(declared, host)}
	{@const context = previous ? (before_row ?? row) : row}
	{@const nativeKind = declared}
	{#if held === undefined}<span class="text-sm text-muted-foreground">Not set</span>
	{:else if held === null}<span class="text-sm text-muted-foreground">Null</span>
	{:else if field}<Show {ctx} kind={declared} value={held} {name} row={context} readonly />
	{:else if Array.isArray(held) && held.length === 0}<span class="text-sm text-muted-foreground"
			>Empty array</span
		>
	{:else if entries !== undefined && Object.keys(entries).length === 0}<span
			class="text-sm text-muted-foreground">Empty object</span
		>
	{:else if held === ''}<span class="text-sm text-muted-foreground">Empty text</span>
	{:else if typeof held === 'boolean'}<span class="structured-boolean"
			><Checkbox checked={held} readonly={false} disabled aria-label={name || 'Value'} /></span
		>
	{:else if enumItems !== null}
		<span class="inline-flex flex-wrap gap-1" data-enum-list
			>{#each enumItems as item (item)}<Badge
					variant="outline"
					class="font-medium"
					data-enum-value={item}>{item}</Badge
				>{/each}</span
		>
	{:else if enumLike(held)}
		<Badge variant="outline" class="font-medium" data-enum-value={held}>{held}</Badge>
	{:else if (entries || Array.isArray(held)) && (declared.many === true || ['json', 'custom', 'object', 'record', 'union'].includes(declared.kind))}
		{#if depth >= 24}<CodeEditor
				language="json"
				readonly
				wrap
				value={JSON.stringify(visible(held, shape(declaredKind, held), host), null, 2)}
				aria-label={name || 'Nested value'}
			/>
		{:else}<Self {ctx}
				schema={rawSchema}
				kind={declaredKind}
				value={held}
				mode="view"
				{name}
				row={context}
				create={newRecord}
				root={document}
				depth={depth + 1}
				{frame}
			/>{/if}
	{:else}<Show {ctx}
			kind={nativeKind.many === true ||
			['json', 'custom', 'object', 'record', 'union'].includes(nativeKind.kind)
				? inferKind(held)
				: nativeKind}
			value={held}
			{name}
			row={context}
			readonly
		/>{/if}
{/snippet}

<div
	class="structured-data"
	class:structured-root={depth === 0}
	class:structured-leaf={layout === undefined && currentMode !== 'schema'}
	data-structured-data={currentMode}
>
	{#if currentMode === 'schema' && on_change && !controls.readonly}
		<Self {ctx}
			schema={authorSchema}
			value={json_schema_rows(schema ?? true)}
			mode="edit"
			on_change={(next) => on_change?.(json_schema_from_rows(next, schema))}
			{name}
			{id}
			disabled={controls.disabled}
			{errors}
			depth={depth + 1}
			{frame}
		/>
	{:else if currentMode === 'schema'}
		<Table {ctx}
			of={schemaFields}
			columns={schemaColumns}
			controlled
			embedded
			layout="grid"
			toolbar={false}
			key={`schema:${name || controlId}`}
			row_class={(row) => (row.section ? 'structured-schema-section' : undefined)}
		/>
	{:else if !locked && kind?.kind === 'object' && kind.optional && (value === null || value === undefined)}<Button
			variant="ghost"
			disabled={controls.disabled}
			onclick={() =>
				on_change?.(
					Object.fromEntries(
						Object.entries(kind.fields).map(([key, child]) => [key, initial(child)])
					)
				)}>{t('add')}</Button
		>
	{:else if layout === 'array' && locked && currentMode === 'view' && scalarList(value)}
		<span class="flex min-w-0 flex-wrap gap-1" data-structured-chips>
			{#each list as item, index (index)}
				<span class="bg-muted inline-flex max-w-full min-w-0 items-center rounded-sm px-1.5 text-sm"
					><Self {ctx}
						schema={schemaAt(index)}
						kind={itemKind}
						value={item}
						mode="view"
						name={childName(index)}
						id={`${controlId}-${index}`}
						readonly
						{row}
						root={document}
						path={pointer(path, index)}
						depth={depth + 1}
						{frame}
					/></span
				>
			{/each}
		</span>
	{:else if layout}
		{#if heading}<details
				class="structured-section structured-nested"
				class:structured-flat={depth === 1 && !frame}
				open
			>
				<summary
					><Icon icon="lucide:chevron-right" class="size-4 shrink-0" /><span>{heading}</span
					>{#if layout === 'array'}<span class="ml-auto text-xs font-normal text-muted-foreground"
							>{value === undefined ? previousList.length : list.length}</span
						>{/if}</summary
				>
				<div class="structured-section-body">
					{#if layout === 'object'}{@render fieldsBody()}{:else}{@render listBody()}{/if}
				</div>
			</details>
		{:else if layout === 'object'}{@render fieldsBody()}{:else}{@render listBody()}{/if}
	{:else if currentMode === 'diff' && changed}
		<span class="structured-diff"
			>{#if before !== undefined}<del aria-label="Previous value">{@render shown(before, true)}</del
				>{/if}{#if value !== undefined}<ins aria-label="New value">{@render shown(value)}</ins
				>{/if}</span
		>
	{:else if locked || currentMode === 'diff'}{@render shown(value)}
	{:else if spec.const !== undefined}
		{@render shown(value)}{#if !data_equal(spec.const, value)}<Button
				variant="ghost"
				disabled={controls.disabled}
				onclick={() => {
					const fixed = spec.const;
					if (fixed !== undefined) on_change?.(fixed);
				}}>Use fixed value</Button
			>{/if}
	{:else if spec.enum !== undefined && leafKind.kind !== 'enum'}
		<Combobox
			id={controlId}
			options={spec.enum.map((option, index) => ({
				value: String(index),
				label: typeof option === 'string' ? option : JSON.stringify(option)
			}))}
			value={spec.enum.findIndex((option) => data_equal(option, value)) < 0
				? null
				: String(spec.enum.findIndex((option) => data_equal(option, value)))}
			disabled={controls.disabled}
			readonly={false}
			invalid={errors?.has(name)}
			on_change={(next) => {
				const option = next === null ? undefined : spec.enum?.[Number(next)];
				if (option !== undefined) on_change?.(option);
			}}
		/>
	{:else if leafKind.kind === 'bool'}
		<span class="structured-boolean"
			><Checkbox
				id={controlId}
				checked={value === true}
				indeterminate={value === undefined || value === null}
				readonly={false}
				disabled={controls.disabled}
				aria-label={name || 'Value'}
				on_checked_change={(next) => on_change?.(next)}
			/></span
		>
	{:else}
		<Editor {ctx}
			kind={leafKind}
			value={value ?? null}
			{name}
			id={controlId}
			on_change={(next) => on_change?.(next)}
			disabled={controls.disabled}
			raw_json={leafKind.kind === 'json' || (leafKind.kind === 'custom' && native === undefined)}
			{errors}
			{row}
		/>
	{/if}
	{#if !locked && nullableJsonSchema(resolved) && value !== null}<Button
			variant="ghost"
			size="icon"
			class="structured-trailing"
			hint="Clear value"
			aria-label="Clear value"
			disabled={controls.disabled}
			onclick={() => on_change?.(null)}><Icon icon="lucide:x" class="size-3.5" /></Button
		>{/if}
	{#if !locked && !newRecord && layout === undefined && spec.default !== undefined && (value === undefined || value === null)}
		<Button
			variant="ghost"
			size="icon"
			class="structured-trailing"
			hint={t('useDefault')}
			aria-label={t('useDefault')}
			disabled={controls.disabled}
			onclick={() => {
				const fallback = spec.default;
				if (fallback !== undefined) on_change?.(fallback);
			}}
		>
			<Icon icon="lucide:rotate-ccw" class="size-3.5" />
		</Button>
	{/if}
	{#if presentation?.id !== controlId && errorFor(name)}<p
			class="text-sm text-destructive"
			role="alert"
		>
			{errorFor(name)}
		</p>{/if}
</div>

<style>
	.structured-data {
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--text-sm--line-height, 1.5);
	}
	/* a leaf is one control high: its reset or clear button is an adornment at the control's end, over the control
	   (shown on hover or focus), never a line or a column of its own; only an error message takes a line below */
	.structured-leaf {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: center;
		row-gap: 4px;
	}
	.structured-leaf > :global(:first-child),
	.structured-leaf > :global(.structured-trailing) {
		grid-area: 1 / 1;
		min-width: 0;
	}
	.structured-leaf > :global(.structured-trailing) {
		z-index: 1;
		justify-self: end;
		margin-inline-end: 2px;
		color: var(--color-muted-foreground);
		background: var(--color-background);
		opacity: 0;
	}
	.structured-leaf:hover > :global(.structured-trailing),
	.structured-leaf:focus-within > :global(.structured-trailing) {
		opacity: 1;
	}
	/* clip, not hidden: a hidden box is a scroll container and would pin the sticky labels to itself */
	.structured-root {
		overflow: clip;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	/* Pair columns follow the pane's width; editors keep their full-width rows. */
	.structured-fields-compact {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, clamp(9rem, 50% - 8px, 16rem)), 1fr));
		gap: 8px 16px;
		padding-block: 4px;
	}
	.structured-fields-compact > :global(.structured-data),
	.structured-fields-compact > .structured-field-wide {
		grid-column: 1 / -1;
	}
	.structured-fields-compact > .structured-field {
		border-bottom: 0;
		overflow-wrap: anywhere;
	}
	.structured-field {
		min-width: 0;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
	}
	.structured-field:last-child {
		border-bottom: 0;
	}
	.structured-field-value {
		position: relative;
		min-width: 0;
	}
	.structured-field-value > :global(.structured-data) {
		width: 100%;
	}
	.structured-section > summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		cursor: pointer;
		background: var(--color-muted);
		border-bottom: 1px solid var(--color-border);
		list-style: none;
		font-weight: 500;
	}
	.structured-section > summary::-webkit-details-marker {
		display: none;
	}
	.structured-section[open] > summary :global(svg) {
		transform: rotate(90deg);
	}
	/* closed, the heading's rule would double the line under the section: it keeps its width (no shift), not its colour */
	.structured-section:not([open]) > summary {
		border-bottom-color: transparent;
	}
	/* One border per visual container: the root's frame is the box. A nested object or list is a band of it, ruled off
	   like a field row, never a second card inside the frame (a list's table draws only its row lines). */
	.structured-nested {
		overflow: clip;
		border-bottom: 1px solid var(--color-border);
	}
	:global(.structured-data:last-child) > .structured-nested {
		border-bottom-width: 0;
	}
	.structured-nested > summary {
		padding-inline: 12px;
		background: color-mix(in oklab, var(--color-muted) 60%, var(--color-card));
	}
	/* Inside another frame (a step's input or output), the first section is the frame's own content: no rule. */
	.structured-nested.structured-flat {
		border: 0;
	}
	/* A section's content steps in under its heading, a level at a time, so the hierarchy reads at a glance. */
	.structured-nested:not(.structured-flat) > .structured-section-body {
		margin-inline-start: 12px;
		border-inline-start: 1px solid var(--color-border);
	}
	.structured-data :global(input:not([type='checkbox'])),
	.structured-data :global(textarea),
	.structured-data :global([role='combobox']),
	.structured-data :global([data-date-input]) {
		width: 100%;
		min-width: 0;
		max-width: 100%;
	}
	.structured-boolean {
		display: flex;
		align-items: center;
		line-height: 0;
	}
	.structured-diff {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-inline: -4px;
	}
	.structured-diff > del,
	.structured-diff > ins {
		display: inline-flex;
		align-items: center;
		min-width: 0;
		max-width: 100%;
		padding: 1px 4px;
		border-radius: 3px;
	}
	.structured-diff > del {
		color: var(--color-destructive);
		background: color-mix(in oklab, var(--color-destructive) 8%, transparent);
		text-decoration: line-through;
	}
	.structured-diff > ins {
		color: var(--color-success);
		background: color-mix(in oklab, var(--color-success) 8%, transparent);
		text-decoration: none;
	}
	.structured-diff :global([data-enum-value]) {
		color: inherit;
		background: transparent;
	}
	.structured-diff :global([data-readonly]) {
		color: inherit;
	}
	.structured-diff :global([data-readonly] button) {
		display: none;
	}
	.structured-diff > del :global(span) {
		text-decoration: inherit;
	}
	.structured-diff > del :global([role='checkbox']) {
		position: relative;
	}
	.structured-diff > del :global([role='checkbox']):after {
		content: '';
		position: absolute;
		left: -2px;
		right: -2px;
		top: 50%;
		border-top: 1px solid var(--color-destructive);
		transform: rotate(-35deg);
	}
	.structured-remove-field {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0;
		padding: 3px;
		border-radius: var(--radius-sm);
		background: var(--color-background);
	}
	.structured-field:hover .structured-remove-field,
	.structured-field:focus-within .structured-remove-field {
		opacity: 1;
	}
	.structured-data :global(.structured-row-added > td) {
		background: color-mix(in oklab, var(--color-success) 8%, var(--color-card));
	}
	.structured-data :global(.structured-row-removed > td) {
		background: color-mix(in oklab, var(--color-destructive) 8%, var(--color-card));
	}
	.structured-data :global(.structured-schema-section > td) {
		background: var(--color-muted);
	}
	@media (max-width: 600px) {
		.structured-field {
			padding: 7px 10px;
		}
		.structured-section > summary {
			padding-inline: 10px;
		}
	}
	@media (hover: none) {
		.structured-remove-field,
		.structured-leaf > :global(.structured-trailing) {
			opacity: 1;
		}
	}
</style>
