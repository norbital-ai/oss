<!--
@component
Edits a JSON Schema value compactly, laid out by the schema itself: an object is a Field | Value matrix of label | control rows, a
nested object an indented group of its own rows, an array of flat objects an editable table (a column per property, a
row per item) and any other array a numbered list. Leaves dispatch through `Editor` and the workspace datatype
registry; unsupported shapes keep the raw JSON editor.
-->
<script lang="ts" module>
	import { Decimal } from '@norbital-ai/std/decimal';
	import { Array as Arr } from 'effect';
	import type { Value } from './kind.js';
	import type { JsonSchema } from './json-schema.js';
	/** JSON Schema, draft value, edit callback and inherited controls for a generated input form. */
	export type JsonSchemaFormProps = {
		schema: JsonSchema;
		value: Value;
		onChange(next: Value): void;
		name?: string;
		id?: string;
		disabled?: boolean;
		readonly?: boolean;
		/** Server/validator errors by dotted path, matching Editor/Form. */
		errors?: ReadonlyMap<string, string>;
		/** Internal reference root; normally omitted. */
		root?: JsonSchema;
		depth?: number;
	};
	type Entries = { readonly [key: string]: Value };
	type Column = { readonly name: string; readonly schema: JsonSchema; readonly required: boolean };
	const entriesOf = (value: Value): Entries =>
		value !== null &&
		typeof value === 'object' &&
		!Arr.isArray<Value>(value) &&
		!(value instanceof Decimal)
			? value
			: {};
	const without = (entries: Entries, key: string): Entries =>
		Object.fromEntries(Object.entries(entries).filter(([held]) => held !== key));
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import Self from './json-schema-form.svelte';
	import Editor from './editor.svelte';
	import Section from '../form/section.svelte';
	import Button from '../primitives/button/button.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import { humanize } from '../text/messages.js';
	import {
		composesJsonSchema,
		jsonSchemaGroups,
		jsonSchemaInitial,
		jsonSchemaKind,
		nullableJsonSchema,
		resolveJsonSchema
	} from './json-schema.js';
	let {
		schema,
		value,
		onChange,
		name = '',
		id,
		disabled,
		readonly,
		errors,
		root,
		depth = 0
	}: JsonSchemaFormProps = $props();
	const uid = $props.id();
	const controlId = $derived(id ?? uid);
	const controls = provideControls(() => ({ disabled, readonly }));
	const t = uiText();
	const document = $derived(root ?? schema);
	const resolved = $derived(resolveJsonSchema(schema, document));
	const spec = $derived(typeof resolved === 'boolean' ? {} : resolved);
	const kind = $derived(depth >= 24 ? { kind: 'json' as const } : jsonSchemaKind(resolved));
	const object = $derived(entriesOf(value));
	const extra = $derived(
		Object.fromEntries(
			Object.entries(object).filter(([key]) => !Object.hasOwn(spec.properties ?? {}, key))
		)
	);
	const list = $derived<readonly Value[]>(Arr.isArray<Value>(value) ? value : []);
	const locked = $derived(controls.readonly || spec.readOnly === true);
	const path = (key: string | number) => (name === '' ? String(key) : `${name}.${key}`);
	const specOf = (child: JsonSchema) => (typeof child === 'boolean' ? {} : child);
	const titleOf = (column: Column) => specOf(column.schema).title ?? humanize(column.name);
	/** A cleared field the schema does not let be null is absent, never a stored null. */
	const assign = (entries: Entries, key: string, child: JsonSchema, next: Value): Entries =>
		next === null && !nullableJsonSchema(child)
			? without(entries, key)
			: { ...entries, [key]: next };
	const setItem = (index: number, next: Value) =>
		onChange(list.map((held, at) => (at === index ? next : held)));
	/** An array of objects whose properties are all leaves edits as one table: a column per property. */
	const columns = $derived.by((): readonly Column[] | null => {
		if (kind.kind !== 'list' || spec.items === undefined) return null;
		const items = resolveJsonSchema(spec.items, document);
		if (typeof items === 'boolean' || jsonSchemaKind(items).kind !== 'object') return null;
		const fields = Object.entries(items.properties ?? {}).map(([field, child]) => ({
			name: field,
			schema: resolveJsonSchema(child, document),
			required: items.required?.includes(field) ?? false
		}));
		const leaf = (column: Column) =>
			!['object', 'list', 'json', 'custom'].includes(jsonSchemaKind(column.schema).kind);
		return fields.length > 0 && fields.every(leaf) ? fields : null;
	});
	let extraProblem = $state<string | null>(null);
	const extraErrors = $derived(
		[...(errors?.entries() ?? [])].filter(
			([key]) =>
				key !== name &&
				(name === '' || key.startsWith(`${name}.`)) &&
				!Object.keys(spec.properties ?? {}).some(
					(field) => key === path(field) || key.startsWith(`${path(field)}.`)
				)
		)
	);
	function setExtra(next: Value) {
		if (
			next === null ||
			typeof next !== 'object' ||
			Arr.isArray<Value>(next) ||
			next instanceof Decimal
		) {
			extraProblem = 'Enter a JSON object of additional properties.';
			return;
		}
		extraProblem = null;
		const known = Object.fromEntries(
			Object.entries(object).filter(([key]) => Object.hasOwn(spec.properties ?? {}, key))
		);
		const added = Object.fromEntries(
			Object.entries(next).filter(([key]) => !Object.hasOwn(spec.properties ?? {}, key))
		);
		onChange({ ...known, ...added });
	}
	const hasError = (key: string) =>
		[...(errors?.keys() ?? [])].some((p) => p === key || p.startsWith(`${key}.`));
</script>

{#snippet requiredMark()}<span class="ml-0.5 text-destructive" aria-label={t('required')}>*</span
	>{/snippet}

{#snippet removeButton(label: string, blocked: boolean, remove: () => void)}
	<Button
		variant="ghost"
		size="icon"
		class="shrink-0 text-muted-foreground"
		title={label}
		disabled={controls.disabled || blocked}
		onclick={remove}
		><Icon icon="lucide:x" class="size-3.5" /><span class="sr-only">{label}</span></Button
	>
{/snippet}

{#snippet addButton(blocked: boolean)}
	<Button
		variant="ghost"
		size="sm"
		class="justify-self-start text-muted-foreground"
		disabled={controls.disabled || blocked}
		onclick={() => onChange([...list, jsonSchemaInitial(spec.items ?? true, document)])}
		><Icon icon="lucide:plus" class="size-3.5" />{t('add')}</Button
	>
{/snippet}

{#snippet rows(fields: readonly Column[])}
	<!-- the schema matrix's look with each type cell a control: the outermost object is a bordered Field | Value table -->
	<div
		class={[
			'@container grid min-w-0 divide-y divide-border',
			depth === 0 && 'rounded-md border border-border'
		]}
	>
		{#if depth === 0}
			<div
				class="hidden gap-x-3 rounded-t-md bg-muted/50 px-3 py-2 text-sm font-medium text-muted-foreground @md:grid @md:grid-cols-[minmax(8rem,16rem)_minmax(0,1fr)]"
				aria-hidden="true"
			>
				<span>{t('schemaField')}</span><span>{t('schemaValue')}</span>
			</div>
		{/if}
		{#each fields as field (field.name)}
			{@const child = specOf(field.schema)}
			{@const nested = jsonSchemaKind(field.schema).kind === 'object'}
			<div
				class={[
					'grid min-w-0 gap-x-3 gap-y-1 py-1.5',
					depth === 0 && 'px-3',
					!nested && '@md:grid-cols-[minmax(8rem,16rem)_minmax(0,1fr)]'
				]}
				data-schema-field={path(field.name)}
			>
				<div class={['min-w-0', !nested && '@md:pt-2']}>
					<label for={`${controlId}-${field.name}`} class="text-label"
						>{child.title ??
							humanize(field.name)}{#if field.required}{@render requiredMark()}{/if}</label
					>
					{#if child.description}<p class="line-clamp-2 text-meta" title={child.description}>
							{child.description}
						</p>{/if}
				</div>
				<div class={['flex min-w-0 items-start gap-1', nested && 'border-l border-border pl-3']}>
					<div class="min-w-0 flex-1">
						<Self
							schema={field.schema}
							value={(Object.hasOwn(object, field.name) ? object[field.name] : null) ?? null}
							onChange={(next) => onChange(assign(object, field.name, field.schema, next))}
							name={path(field.name)}
							id={`${controlId}-${field.name}`}
							disabled={controls.disabled}
							readonly={locked}
							{errors}
							root={document}
							depth={depth + 1}
						/>
					</div>
					{#if !field.required && Object.hasOwn(object, field.name) && !locked && child.readOnly !== true}
						{@render removeButton(t('remove'), false, () => onChange(without(object, field.name)))}
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/snippet}

<div class="grid min-w-0 gap-1.5" data-json-schema-form={name}>
	{#if spec.const !== undefined}
		<Editor kind={{ kind: 'json' }} value={spec.const} {onChange} {name} id={controlId} readonly />
		{#if !locked && JSON.stringify(value) !== JSON.stringify(spec.const)}<Button
				variant="outline"
				size="sm"
				disabled={controls.disabled}
				onclick={() => onChange(spec.const!)}>Use fixed value</Button
			>{/if}
	{:else if spec.enum !== undefined && kind.kind !== 'enum' && !composesJsonSchema(spec)}
		{@const selected = spec.enum.findIndex((v) => JSON.stringify(v) === JSON.stringify(value))}
		<Combobox
			id={controlId}
			value={selected >= 0 ? String(selected) : null}
			placeholder="Select a value"
			disabled={controls.disabled}
			readonly={locked}
			invalid={errors?.has(name)}
			options={spec.enum.map((option, index) => ({
				value: String(index),
				label: typeof option === 'string' ? option : JSON.stringify(option)
			}))}
			onChange={(v) => {
				if (v === null) return;
				const index = Number(v);
				if (index >= 0) onChange(spec.enum![index]!);
			}}
		/>
	{:else if kind.kind === 'object'}
		{#each jsonSchemaGroups(spec, document) as group, index (`${group.advanced}:${group.title}`)}
			{#if group.title === ''}
				{@render rows(group.fields)}
			{:else}
				<Section
					title={group.title}
					name={`${controlId}:${group.title}`}
					first={index === 0}
					defaultOpen={!group.advanced || group.fields.some((f) => hasError(path(f.name)))}
					collapsible={!group.fields.some((f) => hasError(path(f.name)))}
					summary={`${group.fields.filter((f) => Object.hasOwn(object, f.name)).length} / ${group.fields.length}`}
				>
					{@render rows(group.fields)}
				</Section>
			{/if}
		{/each}
		{#if extraErrors.length > 0 || Object.keys(object).some((key) => !Object.hasOwn(spec.properties ?? {}, key)) || Object.keys(spec.properties ?? {}).length === 0 || spec.additionalProperties !== false}
			<Section
				title="Additional properties"
				name={`${controlId}:properties`}
				defaultOpen={extraErrors.length > 0}
				collapsible={extraErrors.length === 0}
			>
				<!-- Only extra keys are edited here: declared fields retain their controls and read-only mode. -->
				<Editor
					kind={{ kind: 'json' }}
					value={extra}
					onChange={setExtra}
					{name}
					id={`${controlId}-properties`}
					disabled={controls.disabled}
					readonly={locked}
					{errors}
				/>
				{#if extraProblem}<p class="text-xs text-destructive" role="alert">{extraProblem}</p>{/if}
				{#each extraErrors as [key, message] (key)}<p class="text-xs text-destructive" role="alert">
						{key}: {message}
					</p>{/each}
			</Section>
		{/if}
	{:else if kind.kind === 'list' && spec.items !== undefined && columns !== null}
		{#if list.length > 0}
			<div class="min-w-0 overflow-x-auto rounded-md border border-border">
				<table class="w-full text-sm">
					<thead class="bg-muted/50 text-left text-muted-foreground">
						<tr>
							{#each columns as column (column.name)}
								<th
									class="px-2 py-1.5 font-medium whitespace-nowrap"
									title={specOf(column.schema).description}
									>{titleOf(column)}{#if column.required}{@render requiredMark()}{/if}</th
								>
							{/each}
							{#if !locked}<th class="w-px"><span class="sr-only">{t('remove')}</span></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each list as item, index (index)}
							{@const entries = entriesOf(item)}
							<tr class="border-t border-border align-top">
								{#each columns as column (column.name)}
									{@const cell = `${controlId}-${index}-${column.name}`}
									<td
										class={[
											'px-1 py-1',
											jsonSchemaKind(column.schema).kind !== 'bool' && 'min-w-32'
										]}
									>
										<label for={cell} class="sr-only">{titleOf(column)} {index + 1}</label>
										<Self
											schema={column.schema}
											value={(Object.hasOwn(entries, column.name) ? entries[column.name] : null) ??
												null}
											onChange={(next) =>
												setItem(index, assign(entries, column.name, column.schema, next))}
											name={path(`${index}.${column.name}`)}
											id={cell}
											disabled={controls.disabled}
											readonly={locked}
											{errors}
											root={document}
											depth={depth + 1}
										/>
									</td>
								{/each}
								{#if !locked}
									<td class="px-1 py-1">
										{@render removeButton(
											`${t('remove')} ${index + 1}`,
											list.length <= (kind.min ?? 0),
											() => onChange(list.filter((_, at) => at !== index))
										)}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if !locked}{@render addButton(kind.max !== undefined && list.length >= kind.max)}{/if}
	{:else if kind.kind === 'list' && spec.items !== undefined}
		{#if list.length > 0}
			<div class="grid min-w-0 divide-y divide-border">
				{#each list as item, index (index)}
					<div class="flex min-w-0 items-start gap-2 py-1.5">
						<span class="w-5 shrink-0 pt-2 text-meta tabular-nums">{index + 1}</span>
						<div class="min-w-0 flex-1">
							<label for={`${controlId}-${index}`} class="sr-only"
								>{spec.title ?? 'Item'} {index + 1}</label
							>
							<Self
								schema={spec.items}
								value={item}
								onChange={(next) => setItem(index, next)}
								name={path(index)}
								id={`${controlId}-${index}`}
								disabled={controls.disabled}
								readonly={locked}
								{errors}
								root={document}
								depth={depth + 1}
							/>
						</div>
						{#if !locked}
							{@render removeButton(
								`${t('remove')} ${index + 1}`,
								list.length <= (kind.min ?? 0),
								() => onChange(list.filter((_, at) => at !== index))
							)}
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		{#if !locked}{@render addButton(kind.max !== undefined && list.length >= kind.max)}{/if}
	{:else}
		<Editor
			{kind}
			{value}
			{onChange}
			{name}
			id={controlId}
			disabled={controls.disabled}
			readonly={locked}
			{errors}
		/>
	{/if}
	{#if !locked && nullableJsonSchema(spec) && value !== null}
		<Button
			variant="ghost"
			size="sm"
			class="justify-self-start"
			disabled={controls.disabled}
			onclick={() => onChange(null)}>Clear value</Button
		>
	{/if}
	{#if !locked && spec.default !== undefined && value === null}
		<Button
			variant="ghost"
			size="sm"
			class="justify-self-start text-muted-foreground"
			disabled={controls.disabled}
			onclick={() => onChange(spec.default!)}>Use default</Button
		>
	{/if}
	{#if errors?.get(name)}<p class="text-xs text-destructive" role="alert">
			{errors.get(name)}
		</p>{/if}
</div>
