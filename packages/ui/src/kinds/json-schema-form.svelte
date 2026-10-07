<!--
@component
Edits JSON Schema inputs using the workspace datatype registry, segmented sections and JSON fallbacks.
-->
<script lang="ts" module>
	import type { Json } from './kind.js';
	import type { JsonSchema } from './json-schema.js';
	/** JSON Schema, draft value, edit callback and inherited controls for a generated input form. */
	export type JsonSchemaFormProps = {
		schema: JsonSchema; value: Json; onChange(next: Json): void;
		name?: string; id?: string; disabled?: boolean; readonly?: boolean;
		/** Server/validator errors by dotted path, matching Editor/Form. */
		errors?: ReadonlyMap<string, string>;
		/** Internal reference root; normally omitted. */
		root?: JsonSchema; depth?: number;
	};
</script>
<script lang="ts">
	import Self from './json-schema-form.svelte';
	import Editor from './editor.svelte';
	import Section from '../form/section.svelte';
	import Button from '../primitives/button/button.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import { humanize } from '../views/model.js';
	import { jsonSchemaGroups, jsonSchemaInitial, jsonSchemaKind, resolveJsonSchema } from './json-schema.js';
	let { schema, value, onChange, name = '', id, disabled, readonly, errors, root, depth = 0 }: JsonSchemaFormProps = $props();
	const uid = $props.id();
	const controlId = $derived(id ?? uid);
	const controls = provideControls(() => ({ disabled, readonly }));
	const t = uiText();
	const document = $derived(root ?? schema);
	const resolved = $derived(resolveJsonSchema(schema, document));
	const spec = $derived(typeof resolved === 'boolean' ? {} : resolved);
	const kind = $derived(depth >= 24 ? { kind: 'json' as const } : jsonSchemaKind(resolved));
	const object = $derived<Record<string, Json>>(value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {});
	const extra = $derived(Object.fromEntries(Object.entries(object).filter(([key]) => !Object.hasOwn(spec.properties ?? {}, key))));
	const list = $derived<readonly Json[]>(Array.isArray(value) ? value : []);
	const locked = $derived(controls.readonly || spec.readOnly === true);
	const path = (key: string | number) => name === '' ? String(key) : `${name}.${key}`;
	const set = (key: string, next: Json) => onChange({ ...object, [key]: next });
	let extraProblem = $state<string | null>(null);
	const extraErrors = $derived([...(errors?.entries() ?? [])].filter(([key]) => key !== name && (name === '' || key.startsWith(`${name}.`)) && !Object.keys(spec.properties ?? {}).some((field) => key === path(field) || key.startsWith(`${path(field)}.`))));
	function setExtra(next: Json) {
		if (next === null || typeof next !== 'object' || Array.isArray(next)) { extraProblem = 'Enter a JSON object of additional properties.'; return; }
		extraProblem = null;
		const known = Object.fromEntries(Object.entries(object).filter(([key]) => Object.hasOwn(spec.properties ?? {}, key)));
		const added = Object.fromEntries(Object.entries(next).filter(([key]) => !Object.hasOwn(spec.properties ?? {}, key)));
		onChange({ ...known, ...added });
	}
	const remove = (key: string) => onChange(Object.fromEntries(Object.entries(object).filter(([k]) => k !== key)));
	const hasError = (key: string) => [...(errors?.keys() ?? [])].some((p) => p === key || p.startsWith(`${key}.`));
</script>

<div class="grid min-w-0 gap-6" data-json-schema-form={name}>
	{#if spec.const !== undefined}
		<Editor kind={{ kind: 'json' }} value={spec.const} {onChange} {name} id={controlId} readonly />
		{#if !locked && JSON.stringify(value) !== JSON.stringify(spec.const)}<Button variant="outline" size="sm" disabled={controls.disabled} onclick={() => onChange(spec.const!)}>Use fixed value</Button>{/if}
	{:else if spec.enum !== undefined && kind.kind !== 'enum' && !['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'not', 'dependentSchemas', 'patternProperties', 'prefixItems'].some((key) => key in spec)}
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
			<Section title={group.title} name={`${controlId}:${group.title}`} first={index === 0}
				defaultOpen={!group.advanced || group.fields.some((f) => hasError(path(f.name)))}
				collapsible={!group.fields.some((f) => hasError(path(f.name)))}
				summary={`${group.fields.filter((f) => Object.hasOwn(object, f.name)).length} / ${group.fields.length}`}>
				<div class="grid min-w-0 gap-4 sm:grid-cols-2">
					{#each group.fields as field (field.name)}
						{@const child = typeof field.schema === 'boolean' ? {} : field.schema}
						{@const childKind = jsonSchemaKind(field.schema)}
						<div class={['grid min-w-0 content-start gap-1.5', ['object', 'list', 'json', 'custom'].includes(childKind.kind) && 'sm:col-span-2']} data-schema-field={path(field.name)}>
							<label for={`${controlId}-${field.name}`} class="text-sm font-medium">{child.title ?? humanize(field.name)}{#if field.required}<span class="ml-1 text-destructive" aria-label={t('required')}>*</span>{/if}</label>
							{#if child.description}<p class="text-meta">{child.description}</p>{/if}
							<Self schema={field.schema} value={(Object.hasOwn(object, field.name) ? object[field.name] : null) ?? null} onChange={(next) => set(field.name, next)} name={path(field.name)} id={`${controlId}-${field.name}`} disabled={controls.disabled} readonly={locked} {errors} root={document} depth={depth + 1} />
							{#if !field.required && Object.hasOwn(object, field.name) && !locked && child.readOnly !== true}
								<Button variant="ghost" size="sm" class="justify-self-start" disabled={controls.disabled} onclick={() => remove(field.name)}>{t('remove')}</Button>
							{/if}
						</div>
					{/each}
				</div>
			</Section>
		{/each}
		{#if extraErrors.length > 0 || Object.keys(object).some((key) => !Object.hasOwn(spec.properties ?? {}, key)) || Object.keys(spec.properties ?? {}).length === 0 || spec.additionalProperties !== false}
			<Section title="Additional properties" name={`${controlId}:properties`} defaultOpen={extraErrors.length > 0} collapsible={extraErrors.length === 0}>
				<!-- Only extra keys are edited here: declared fields retain their controls and read-only mode. -->
				<Editor kind={{ kind: 'json' }} value={extra} onChange={setExtra} {name} id={`${controlId}-properties`} disabled={controls.disabled} readonly={locked} {errors} />
				{#if extraProblem}<p class="text-xs text-destructive" role="alert">{extraProblem}</p>{/if}
				{#each extraErrors as [key, message] (key)}<p class="text-xs text-destructive" role="alert">{key}: {message}</p>{/each}
			</Section>
		{/if}
	{:else if kind.kind === 'list' && spec.items !== undefined}
		{#each list as item, index (index)}
			<fieldset class="grid min-w-0 gap-3 border-t pt-4" disabled={controls.disabled}>
				<legend class="text-sm font-medium"><label for={`${controlId}-${index}`}>{spec.title ?? 'Item'} {index + 1}</label></legend>
				<Self schema={spec.items} value={item} onChange={(next) => onChange(list.map((v, i) => i === index ? next : v))} name={path(index)} id={`${controlId}-${index}`} disabled={controls.disabled} readonly={locked} {errors} root={document} depth={depth + 1} />
				{#if !locked}<Button variant="ghost" size="sm" class="justify-self-start" disabled={controls.disabled || list.length <= (kind.min ?? 0)} onclick={() => onChange(list.filter((_, i) => i !== index))}>{t('remove')} {index + 1}</Button>{/if}
			</fieldset>
		{/each}
		{#if !locked}<Button variant="outline" size="sm" class="justify-self-start" disabled={controls.disabled || (kind.max !== undefined && list.length >= kind.max)} onclick={() => onChange([...list, jsonSchemaInitial(spec.items!, document)])}>{t('add')}</Button>{/if}
	{:else}
		<Editor {kind} {value} {onChange} {name} id={controlId} disabled={controls.disabled} readonly={locked} {errors} />
	{/if}
	{#if !locked && Array.isArray(spec.type) && spec.type.includes('null') && value !== null}
		<Button variant="ghost" size="sm" class="justify-self-start" disabled={controls.disabled} onclick={() => onChange(null)}>Clear value</Button>
	{/if}
	{#if !locked && spec.default !== undefined && value === null}
		<Button variant="outline" size="sm" class="justify-self-start" disabled={controls.disabled} onclick={() => onChange(spec.default!)}>Use default</Button>
	{/if}
	{#if errors?.get(name)}<p class="text-xs text-destructive" role="alert">{errors.get(name)}</p>{/if}
</div>
