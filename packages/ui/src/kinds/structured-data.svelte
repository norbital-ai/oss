<!--
@component
One compact schema, value, editor and inline comparison. Record lists use the model Table itself;
leaf values retain the workspace's native kinds, custom renderers and inherited controls.
-->
<script lang="ts" module>
	import type { Value, Kind } from './kind.js';
	import type { JsonSchema } from './json-schema.js';
	import type { ArrayKeys } from './structured-data.js';
	import type { Values } from '../model/types.js';
	import { Schema } from 'effect';
	import { inputSchema } from '@norbital-ai/std/kind';
	/** A schema or native kind with current data, editing controls, or a prior value for comparison. */
	export type StructuredDataProps = {
		schema?: JsonSchema;
		kind?: Kind;
		value?: Value;
		before?: Value;
		mode?: 'view' | 'edit' | 'schema' | 'diff';
		onChange?(next: Value): void;
		name?: string;
		id?: string;
		readonly?: boolean;
		disabled?: boolean;
		errors?: ReadonlyMap<string, string>;
		row?: Values;
		/** Prior row context for native currency and related-value formatting. */
		beforeRow?: Values;
		/** Explicit row identities, indexed by JSON Pointer. Unkeyed lists compare by position. */
		arrayKeys?: ArrayKeys;
		changesOnly?: boolean;
		/** A new record: schema defaults fill as the editor opens; an edit offers them by control instead. */
		create?: boolean;
		/** Internal recursion context. */
		root?: JsonSchema;
		path?: string;
		depth?: number;
		heading?: string;
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
	const pointer = (path: string, key: string | number) =>
		`${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
	const shape = (kind: Kind | undefined, value: Value | undefined): Kind | undefined => {
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
				kind.of.find((arm) => value !== undefined && Schema.is(inputSchema(arm))(value)) ??
					kind.of[0],
				value
			);
		return kind;
	};
	const visible = (
		value: Value | undefined,
		kind: Kind | undefined,
		host: ReturnType<typeof useKinds>
	): Value => {
		if (value === undefined) return null;
		const native = kind ? fieldEntry(kind, host) : undefined;
		if (native?.entry.renderer) return native.entry.label ?? kind?.label ?? 'Details';
		const planned = shape(native?.entry.shape ?? kind, value);
		if (planned !== kind && planned?.kind === 'custom') return visible(value, planned, host);
		if (Array.isArray(value))
			return value.map((item) =>
				visible(item, planned?.kind === 'list' ? planned.of : undefined, host)
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
	import { Decimal } from '@norbital-ai/std/decimal';
	import Self from './structured-data.svelte';
	import Editor from './editor.svelte';
	import Show from './show.svelte';
	import CodeEditor from '../editors/code-editor.svelte';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Button from '../primitives/button/button.svelte';
	import Table, { type Col } from '../table/Table.svelte';
	import Overflow from '../cell/Overflow.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { fieldEntry } from './builtin/index.js';
	import { useKinds } from './context.js';
	import { armValue, formatValue, inferKind, initial } from './kind.js';
	import { FIELD_TYPES, jsonSchemaFromRows, jsonSchemaRows } from './json-schema-rows.js';
	import { provideControls, uiText } from '../primitives/utils.js';
	import { humanize } from '../text/messages.js';
	import {
		jsonSchemaGroups,
		jsonSchemaInitial,
		jsonSchemaKind,
		nullableJsonSchema
	} from './json-schema.js';
	import {
		dataChanged,
		dataDefaults,
		dataEntries,
		dataEqual,
		inferJsonSchema,
		kindJsonSchema,
		pairDataRows,
		structuredSchema
	} from './structured-data.js';
	import { useForm } from '../form/form-state.svelte.js';

	let {
		schema,
		kind: declaredKind,
		value,
		before,
		mode,
		onChange,
		name = '',
		id,
		readonly,
		disabled,
		errors,
		row = {},
		beforeRow,
		arrayKeys,
		changesOnly = false,
		create,
		root,
		path = '',
		depth = 0,
		heading
	}: StructuredDataProps = $props();
	const uid = $props.id();
	const form = useForm();
	const newRecord = $derived(create ?? form?.mode === 'create');
	const controlId = $derived(id ?? uid);
	const controls = provideControls(() => ({ readonly, disabled }));
	const host = useKinds();
	const t = uiText();
	const currentMode = $derived(mode ?? (onChange ? 'edit' : 'view'));
	const editing = $derived(currentMode === 'edit' && !controls.readonly && !!onChange);
	const held = $derived(value === undefined ? before : value);
	const kind = $derived.by(() => {
		const next = shape(declaredKind, held),
			previous = shape(declaredKind, before);
		if (currentMode === 'diff' && next?.kind === 'object' && previous?.kind === 'object')
			return {
				...next,
				fields: Object.fromEntries(
					[...new Set([...Object.keys(previous.fields), ...Object.keys(next.fields)])]
						.filter((key) => !previous.fields[key]?.hidden && !next.fields[key]?.hidden)
						.map((key) => [key, next.fields[key] ?? previous.fields[key]!])
				)
			};
		return next;
	});
	const document = $derived(
		root ?? schema ?? (kind ? kindJsonSchema(kind) : inferJsonSchema(held))
	);
	const rawSchema = $derived(schema ?? (kind ? kindJsonSchema(kind) : inferJsonSchema(held)));
	const resolved = $derived(structuredSchema(rawSchema, document, held));
	const spec = $derived(node(resolved));
	const locked = $derived(!editing || spec.readOnly === true);
	let seeded = false;
	$effect(() => {
		if (currentMode !== 'edit' || seeded || !newRecord || depth !== 0 || onChange === undefined)
			return;
		seeded = true;
		const next = dataDefaults(rawSchema, value, document);
		if (next !== undefined) onChange(next);
	});
	const plan = $derived(kind ?? jsonSchemaKind(resolved));
	const native = $derived(plan.kind === 'custom' ? fieldEntry(plan, host) : undefined);
	const childName = (key: string | number) => (name === '' ? String(key) : `${name}.${key}`);
	const title = (key: string, child: JsonSchema, childKind?: Kind) =>
		unitTitle(childKind?.label ?? node(child).title ?? humanize(key), child);
	/** One line for a complex cell; its fields open in the bounded editor popover. */
	const summaryOf = (held: Value | undefined): string => {
		if (held === undefined || held === null) return '—';
		if (Array.isArray(held)) return `${held.length} ${held.length === 1 ? 'item' : 'items'}`;
		const entries = dataEntries(held);
		if (entries === undefined) return formatValue(held, host.locale);
		const fields = Object.entries(entries);
		return (
			fields
				.slice(0, 2)
				.map(([key, item]) => `${humanize(key)}: ${formatValue(item, host.locale)}`)
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
			jsonSchemaKind(structuredSchema(s, document, next === undefined ? previous : next));
		if (planned.kind === 'custom' && fieldEntry(planned, host)) return;
		if (currentMode === 'diff' && previous !== undefined) {
			const previousKind =
				shape(k, previous) ?? jsonSchemaKind(structuredSchema(s, document, previous));
			if (
				previousKind.kind === 'custom'
					? !!fieldEntry(previousKind, host)
					: !['object', 'list', 'record', 'json', 'union'].includes(previousKind.kind)
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
		if (planned.kind === 'object' || planned.kind === 'record')
			return newShape === 'array' ? undefined : 'object';
		if (planned.kind === 'list') return newShape === 'object' ? undefined : 'array';
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
			.map((key) => ({
				key,
				schema: structuredSchema(
					spec.properties?.[key] ??
						(fieldKind(key)
							? kindJsonSchema(fieldKind(key)!)
							: inferJsonSchema(object[key] === undefined ? previousObject[key] : object[key])),
					document
				),
				kind: fieldKind(key)
			}))
			.filter(
				(field) =>
					!changesOnly ||
					currentMode !== 'diff' ||
					dataChanged(
						previousObject[field.key],
						object[field.key],
						arrayKeys,
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
			onChange?.(armValue(tagged, next));
			return;
		}
		const field = fields.find((f) => f.key === key);
		if (next === null && field && field.kind === undefined && !nullableJsonSchema(field.schema))
			onChange?.(Object.fromEntries(Object.entries(object).filter(([k]) => k !== key)));
		else onChange?.({ ...object, [key]: next });
	}
	const list = $derived<readonly Value[]>(Array.isArray(value) ? value : []);
	/** A list of plain values (numbers, text, flags): read, it is one line of chips, not a one-column table. */
	const scalarList = (value: Value | undefined): value is readonly Value[] =>
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => item === null || typeof item !== 'object' || item instanceof Decimal);
	const previousList = $derived<readonly Value[]>(Array.isArray(before) ? before : []);
	const itemKind = $derived(kind?.kind === 'list' ? kind.of : undefined);
	const itemSchema = $derived(
		spec.items ??
			(itemKind
				? kindJsonSchema(itemKind)
				: (node(inferJsonSchema([...previousList, ...list])).items ?? true))
	);
	const schemaAt = (index: number): JsonSchema => spec.prefixItems?.[index] ?? itemSchema;
	const pairs = $derived(
		currentMode === 'diff'
			? pairDataRows(
					previousList,
					list,
					arrayKeys?.[path] ?? (kind?.kind === 'list' ? kind.key : undefined)
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
				!changesOnly ||
				currentMode !== 'diff' ||
				dataChanged(
					pair.before,
					pair.value,
					arrayKeys,
					pointer(path, pair.index ?? pair.beforeIndex ?? 0)
				)
		)
	);
	const recordList = $derived(
		(itemKind === undefined
			? !visiblePairs.some((pair) =>
					[pair.before, pair.value].some((value) => {
						if (value === undefined) return false;
						const plan = jsonSchemaKind(structuredSchema(itemSchema, document, value));
						return plan.kind === 'custom' && fieldEntry(plan, host) !== undefined;
					})
				)
			: itemKind.kind === 'object' || (itemKind.kind === 'json' && itemKind.shape === undefined)) &&
			(visiblePairs.length > 0
				? visiblePairs.every((pair) =>
						[pair.before, pair.value]
							.filter((value) => value !== undefined)
							.every((value) => !!dataEntries(value))
					)
				: jsonSchemaKind(structuredSchema(itemSchema, document)).kind === 'object')
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
				width: (itemObjectKind?.fields[field] ?? jsonSchemaKind(spec)).kind === 'bool' ? 104 : 200,
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
		onChange?.(list.map((value, index) => (index === pair.index ? updated : value)));
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
		min: spec.minItems ?? (kind?.kind === 'list' ? (kind.min ?? 0) : 0),
		max: spec.maxItems ?? (kind?.kind === 'list' ? kind.max : undefined)
	});
	const changed = $derived(currentMode === 'diff' && !dataEqual(before, value));
	const leafKind = $derived.by((): Kind => {
		if (held instanceof Decimal && !kind) return { kind: 'decimal', scale: held.scale };
		if (
			plan.kind !== 'json' &&
			plan.kind !== 'object' &&
			plan.kind !== 'list' &&
			plan.kind !== 'record' &&
			plan.kind !== 'union' &&
			(plan.kind !== 'custom' || native !== undefined)
		)
			return plan;
		if (held instanceof Decimal) return { kind: 'decimal', scale: held.scale };
		const inferred = inferKind(held ?? null);
		return ['object', 'list', 'record', 'union'].includes(inferred.kind)
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
	beforeRow: Values | undefined
)}
	<Self
		schema={child}
		kind={nativeKind}
		value={next}
		before={previous}
		mode={currentMode}
		onChange={locked ? undefined : (next) => listChange(entry.at, field, next)}
		name={childName(recordList ? `${index}.${field}` : index)}
		id={`${controlId}-${entry.at}-${field}`}
		disabled={controls.disabled}
		readonly={locked}
		{errors}
		{row}
		{beforeRow}
		{arrayKeys}
		{changesOnly}
		create={newRecord}
		root={document}
		path={recordList ? pointer(pointer(path, index), field) : pointer(path, index)}
		depth={depth + 1}
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
					? kindJsonSchema(nativeKind)
					: inferJsonSchema(next === undefined ? previous : next)))
			: schemaAt(index)}
		{@const held = dataEntries(pair.value) ?? row}
		{@const heldBefore = dataEntries(pair.before) ?? beforeRow}
		{@const complex =
			recordList &&
			(dataEntries(next) !== undefined ||
				(Array.isArray(next) && !(currentMode === 'view' && scalarList(next))))}
		<div class="relative w-full min-w-0">
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
						<Icon icon="lucide:maximize-2" class="size-3 shrink-0" />
					</Popover.Trigger>
					<Popover.Content
						align="start"
						class="max-h-[min(32rem,80vh)] w-[min(44rem,calc(100vw-2rem))] overflow-auto p-3"
						data-structured-editor
					>
						{@render dataSelf(
							entry,
							field,
							next,
							previous,
							nativeKind,
							child,
							index,
							held,
							heldBefore
						)}
					</Popover.Content>
				</Popover.Root>
			{:else if currentMode === 'view' && typeof next === 'string' && (nativeKind === undefined || (nativeKind.kind === 'text' && nativeKind.format === undefined))}
				<Overflow text={next}>
					{@render dataSelf(
						entry,
						field,
						next,
						previous,
						nativeKind,
						child,
						index,
						held,
						heldBefore
					)}
				</Overflow>
			{:else if currentMode === 'view' && typeof next === 'string' && nativeKind?.kind === 'text'}
				<!-- an expression or formatted text previews as one line; the popover renders it whole -->
				<Overflow text={next}>
					<code class="font-mono">{next.replace(/\s+/g, ' ')}</code>
					{#snippet full()}
						{@render dataSelf(
							entry,
							field,
							next,
							previous,
							nativeKind,
							child,
							index,
							held,
							heldBefore
						)}
					{/snippet}
				</Overflow>
			{:else if currentMode === 'view'}
				<!-- every row keeps one line's height: a taller value clamps and opens whole -->
				<Overflow>
					{@render dataSelf(
						entry,
						field,
						next,
						previous,
						nativeKind,
						child,
						index,
						held,
						heldBefore
					)}
				</Overflow>
			{:else}
				{@render dataSelf(entry, field, next, previous, nativeKind, child, index, held, heldBefore)}
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
					if (index !== undefined && index > 0)
						onChange?.(
							list.map((item, at) =>
								at === index ? list[index - 1]! : at === index - 1 ? list[index]! : item
							)
						);
				}}><Icon icon="lucide:arrow-up" class="size-3.5" /></Button
			>{/if}
		<Button
			size="icon"
			variant="ghost"
			title={`${t('remove')} ${entry.at + 1}`}
			disabled={controls.disabled || list.length <= bounds.min}
			onclick={() => {
				const index = visiblePairs[entry.at]?.index;
				if (index !== undefined) onChange?.(list.filter((_, at) => at !== index));
			}}
			><Icon icon="lucide:x" class="size-3.5" /><span class="sr-only"
				>{t('remove')} {entry.at + 1}</span
			></Button
		>
	</div>
{/snippet}

{#snippet fieldRows(members: typeof fields)}
	{#each members as field (field.key)}
		{@const child = node(field.schema)}
		{@const nested = structure(
			field.schema,
			field.kind,
			object[field.key],
			currentMode === 'diff' ? previousObject[field.key] : undefined
		)}
		{#if nested && !(locked && currentMode === 'view' && scalarList(object[field.key]))}
			<Self
				schema={field.schema}
				kind={field.kind}
				value={object[field.key]}
				before={previousObject[field.key]}
				mode={currentMode}
				onChange={locked ? undefined : (next) => assign(field.key, next)}
				name={childName(field.key)}
				id={`${controlId}-${field.key}`}
				disabled={controls.disabled}
				readonly={locked}
				{errors}
				row={object}
				beforeRow={previousObject}
				{arrayKeys}
				{changesOnly}
				create={newRecord}
				root={document}
				path={pointer(path, field.key)}
				depth={depth + 1}
				heading={title(field.key, field.schema, field.kind)}
			/>
		{:else}
			<div class="structured-field" data-schema-field={childName(field.key)}>
				<label class="text-sm text-muted-foreground" for={`${controlId}-${field.key}`}
					>{title(
						field.key,
						field.schema,
						field.kind
					)}{#if !locked && spec.required?.includes(field.key)}<span
							class="ml-0.5 text-destructive"
							aria-label={t('required')}>*</span
						>{/if}</label
				>
				<div class="structured-field-value">
					<Self
						schema={field.schema}
						kind={field.kind}
						value={object[field.key]}
						before={previousObject[field.key]}
						mode={currentMode}
						onChange={locked ? undefined : (next) => assign(field.key, next)}
						name={childName(field.key)}
						id={`${controlId}-${field.key}`}
						disabled={controls.disabled}
						readonly={locked}
						{errors}
						row={object}
						beforeRow={previousObject}
						{arrayKeys}
						{changesOnly}
						create={newRecord}
						root={document}
						path={pointer(path, field.key)}
						depth={depth + 1}
					/>
					{#if !locked && !spec.required?.includes(field.key) && Object.hasOwn(object, field.key) && child.readOnly !== true}<button
							class="structured-remove-field"
							type="button"
							aria-label={`${t('remove')} ${title(field.key, field.schema, field.kind)}`}
							disabled={controls.disabled}
							onclick={() =>
								onChange?.(
									Object.fromEntries(Object.entries(object).filter(([key]) => key !== field.key))
								)}><Icon icon="lucide:x" class="size-3.5" /></button
						>{/if}
				</div>
			</div>
		{/if}
	{/each}
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
				>{extraErrors.length ? 'Additional properties' : 'Add property'}</summary
			>
			<div class="flex items-center gap-2 px-3 pb-2">
				<input
					class="border-input bg-background min-w-0 flex-1 rounded-sm border px-2 py-1 text-sm"
					aria-label="Property name"
					placeholder="Property name"
					bind:value={extraKey}
					disabled={controls.disabled}
				/><Button
					size="sm"
					variant="ghost"
					disabled={controls.disabled || !extraKey.trim() || Object.hasOwn(object, extraKey.trim())}
					onclick={() => {
						onChange?.({
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
	{#if tableRows.length}<Table
			of={tableRows}
			columns={tableColumns}
			controlled
			embedded
			layout="grid"
			toolbar={false}
			key={`structured:${name || controlId}`}
			rowClass={rowChange}
			rowTrailing={locked ? undefined : trailing}
		/>
	{:else}<p class="px-3 py-2 text-sm text-muted-foreground">
			{currentMode === 'diff' && changesOnly ? 'No changes' : 'Empty array'}
		</p>{/if}
	{#if !locked}<Button
			class="m-1 justify-self-start text-muted-foreground"
			variant="ghost"
			size="sm"
			disabled={controls.disabled || (bounds.max !== undefined && list.length >= bounds.max)}
			onclick={() =>
				onChange?.([
					...list,
					itemKind ? initial(itemKind) : jsonSchemaInitial(schemaAt(list.length), document)
				])}><Icon icon="lucide:plus" class="size-3.5" />{t('add')}</Button
		>{/if}
{/snippet}

{#snippet shown(held: Value | undefined, previous = false)}
	{@const schema = structuredSchema(rawSchema, document, held)}
	{@const declared = shape(declaredKind, held) ?? jsonSchemaKind(schema)}
	{@const field = fieldEntry(declared, host)}
	{@const context = previous ? (beforeRow ?? row) : row}
	{@const nativeKind =
		held instanceof Decimal && (shape(declaredKind, held) === undefined || declared.kind === 'json')
			? { kind: 'decimal' as const, scale: held.scale }
			: declared}
	{#if held === undefined}<span class="text-sm text-muted-foreground">Not set</span>
	{:else if held === null}<span class="text-sm text-muted-foreground">Null</span>
	{:else if field}<Show kind={declared} value={held} {name} row={context} readonly />
	{:else if Array.isArray(held) && held.length === 0}<span class="text-sm text-muted-foreground"
			>Empty array</span
		>
	{:else if dataEntries(held) && Object.keys(dataEntries(held)!).length === 0}<span
			class="text-sm text-muted-foreground">Empty object</span
		>
	{:else if held === ''}<span class="text-sm text-muted-foreground">Empty text</span>
	{:else if typeof held === 'boolean'}<span class="structured-boolean"
			><Checkbox checked={held} readonly={false} disabled aria-label={name || 'Value'} /></span
		>
	{:else if (dataEntries(held) || Array.isArray(held)) && ['json', 'custom', 'object', 'list', 'record', 'union'].includes(declared.kind)}
		{#if depth >= 24}<CodeEditor
				language="json"
				readonly
				wrap
				value={JSON.stringify(visible(held, shape(declaredKind, held), host), null, 2)}
				aria-label={name || 'Nested value'}
			/>
		{:else}<Self
				schema={rawSchema}
				kind={declaredKind}
				value={held}
				mode="view"
				{name}
				row={context}
				create={newRecord}
				root={document}
				depth={depth + 1}
			/>{/if}
	{:else}<Show
			kind={['json', 'custom', 'object', 'list', 'record', 'union'].includes(nativeKind.kind)
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
	{#if currentMode === 'schema' && onChange && !controls.readonly}
		<Self
			schema={authorSchema}
			value={jsonSchemaRows(schema ?? true)}
			mode="edit"
			onChange={(next) => onChange?.(jsonSchemaFromRows(next, schema))}
			{name}
			{id}
			disabled={controls.disabled}
			{errors}
			depth={depth + 1}
		/>
	{:else if currentMode === 'schema'}
		<Table
			of={schemaFields}
			columns={schemaColumns}
			controlled
			embedded
			layout="grid"
			toolbar={false}
			key={`schema:${name || controlId}`}
			rowClass={(row) => (row.section ? 'structured-schema-section' : undefined)}
		/>
	{:else if !locked && kind?.kind === 'object' && kind.optional && (value === null || value === undefined)}<Button
			variant="ghost"
			size="sm"
			disabled={controls.disabled}
			onclick={() =>
				onChange?.(
					Object.fromEntries(
						Object.entries(kind.fields).map(([key, child]) => [key, initial(child)])
					)
				)}>{t('add')}</Button
		>
	{:else if layout === 'array' && locked && currentMode === 'view' && scalarList(value)}
		<span class="flex min-w-0 flex-wrap gap-1" data-structured-chips>
			{#each list as item, index (index)}
				<span class="bg-muted inline-flex max-w-full min-w-0 items-center rounded-sm px-1.5 text-sm"
					><Self
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
					/></span
				>
			{/each}
		</span>
	{:else if layout}
		{#if heading}<details
				class="structured-section structured-nested"
				class:structured-deep={depth > 1}
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
		{@render shown(value)}{#if !dataEqual(spec.const, value)}<Button
				variant="ghost"
				size="sm"
				disabled={controls.disabled}
				onclick={() => onChange?.(spec.const!)}>Use fixed value</Button
			>{/if}
	{:else if spec.enum !== undefined && leafKind.kind !== 'enum'}
		<Combobox
			id={controlId}
			options={spec.enum.map((option, index) => ({
				value: String(index),
				label: typeof option === 'string' ? option : JSON.stringify(option)
			}))}
			value={spec.enum.findIndex((option) => dataEqual(option, value)) < 0
				? null
				: String(spec.enum.findIndex((option) => dataEqual(option, value)))}
			disabled={controls.disabled}
			readonly={false}
			invalid={errors?.has(name)}
			onChange={(next) => {
				if (next !== null && spec.enum?.[Number(next)] !== undefined)
					onChange?.(spec.enum[Number(next)]!);
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
				onCheckedChange={(next) => onChange?.(next)}
			/></span
		>
	{:else}
		<Editor
			kind={leafKind}
			value={value ?? null}
			{name}
			id={controlId}
			onChange={(next) => onChange?.(next)}
			disabled={controls.disabled}
			rawJson={leafKind.kind === 'json' || (leafKind.kind === 'custom' && native === undefined)}
			{errors}
			{row}
		/>
	{/if}
	{#if !locked && nullableJsonSchema(resolved) && value !== null}<Button
			variant="ghost"
			size="sm"
			class="justify-self-start text-muted-foreground"
			disabled={controls.disabled}
			onclick={() => onChange?.(null)}>Clear value</Button
		>{/if}
	{#if !locked && !newRecord && layout === undefined && spec.default !== undefined && (value === undefined || value === null)}
		<Button
			variant="ghost"
			size="icon-sm"
			class="structured-default text-muted-foreground hover:text-foreground shrink-0"
			hint={t('useDefault')}
			aria-label={t('useDefault')}
			disabled={controls.disabled}
			onclick={() => onChange?.(spec.default!)}
		>
			<Icon icon="lucide:rotate-ccw" class="size-3.5" />
		</Button>
	{/if}
	{#if errors?.get(name)}<p class="text-sm text-destructive" role="alert">
			{errors.get(name)}
		</p>{/if}
</div>

<style>
	.structured-data {
		min-width: 0;
		font-size: var(--text-sm);
		line-height: var(--text-sm--line-height, 1.5);
	}
	.structured-leaf {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.structured-leaf > :global(:first-child) {
		flex: 1 1 auto;
		min-width: 0;
	}
	.structured-leaf > :global(.structured-default) {
		margin-left: auto;
	}
	.structured-leaf > :global(p[role='alert']) {
		flex-basis: 100%;
	}
	/* clip, not hidden: a hidden box is a scroll container and would pin the sticky labels to itself */
	.structured-root {
		overflow: clip;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}
	.structured-field {
		display: grid;
		grid-template-columns: minmax(8rem, 32%) minmax(0, 1fr);
		align-items: baseline;
		gap: 10px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--color-border);
	}
	/* the label sits on the value's first line and stays in view while a tall value (code, a long list) scrolls */
	.structured-field > label {
		position: sticky;
		top: 0;
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
	/* A nested object or list is its own small card, inset on both sides: its border no longer runs into the parent's. */
	.structured-nested {
		margin: 6px 8px;
		overflow: clip;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-card);
	}
	.structured-nested > summary {
		padding-inline: 8px;
		background: color-mix(in oklab, var(--color-muted) 60%, var(--color-card));
	}
	/* Past the first inset, another card only squeezes the rows: keep one guide line and flat fields. */
	.structured-nested.structured-deep {
		margin: 4px 0 4px 8px;
		overflow: visible;
		border-width: 0 0 0 1px;
		border-radius: 0;
		background: transparent;
	}
	.structured-nested.structured-deep > summary {
		padding-inline: 6px;
		background: transparent;
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
			grid-template-columns: minmax(6rem, 37%) minmax(0, 1fr);
			gap: 8px;
			padding: 7px 10px;
		}
		.structured-section > summary {
			padding-inline: 10px;
		}
	}
	@media (hover: none) {
		.structured-remove-field {
			opacity: 1;
		}
	}
</style>
