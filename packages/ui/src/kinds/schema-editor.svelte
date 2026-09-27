<!--
@component
Edits a structured value by its kind literal: an object's fields, a list's items, a tagged union's arm, a record's entries.
-->
<script lang="ts" module>
	import type { Json, Kind } from './kind.js';

	/**
	 * Edits a structured value by its kind literal (§3.6 `SchemaEditor`): an `object`'s fields, a `list`'s items (add,
	 * remove, reorder), a tagged `union` (the tag picks the arm) and a string-keyed `record`. Leaves are the kind
	 * editors, so a json `shape`, a custom field's `shape` and an action's `input` all edit the same way.
	 */
	export type SchemaEditorProps = {
		kind: Kind;
		value: Json;
		onChange(next: Json): void;
		/** This value's dotted path; problems are looked up under it (`lines.0.amount`). */
		name?: string;
		disabled?: boolean;
		errors?: ReadonlyMap<string, string>;
	};
</script>

<script lang="ts">
	import { humanize } from '../views/model.js';
	import Icon from '@iconify/svelte';
	import Button from '../primitives/button/button.svelte';
	import Input from '../primitives/input/input.svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Editor from './editor.svelte';
	import { armValue, initial, untag } from './kind.js';
	import Self from './schema-editor.svelte';

	let { kind, value, onChange, name = '', disabled = false, errors }: SchemaEditorProps = $props();
	const t = uiText();
	const v = $derived(untag(value));
	type Obj = { readonly [k: string]: Json };
	const obj = $derived<Obj>(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
	const list = $derived<readonly Json[]>(Array.isArray(v) ? v : []);
	const at = (key: string | number) => (name === '' ? String(key) : `${name}.${key}`);
	const title = (f: string, k: Kind) => k.label ?? humanize(f);
	const set = (key: string, next: Json) => onChange({ ...obj, [key]: next });
	let newKey = $state('');
</script>

{#snippet fields(spec: { readonly [f: string]: Kind }, skip?: string)}
	<div class="grid gap-3">
		{#each Object.entries(spec).filter(([f, k]) => !k.hidden && f !== skip) as [f, k] (f)}
			<div class="grid gap-1">
				<label for={at(f)} class="text-xs font-medium text-muted-foreground">
					{title(f, k)}{#if k.optional}<span class="ml-1 font-normal">({t('optional')})</span>{/if}
				</label>
				<Editor kind={k} value={obj[f] ?? null} onChange={(x) => set(f, x)} name={at(f)} id={at(f)} {disabled} {errors} row={obj} />
				{#if k.help}<p class="text-meta">{k.help}</p>{/if}
				{#if errors?.get(at(f))}<p class="text-xs text-destructive">{errors.get(at(f))}</p>{/if}
			</div>
		{/each}
	</div>
{/snippet}

<div class={cn('grid gap-2', name !== '' && kind.kind !== 'list' && 'rounded-sm border border-border p-3')}>
	{#if kind.kind === 'object'}
		{#if v === null && kind.optional}
			<Button variant="outline" size="sm" onclick={() => onChange(Object.fromEntries(Object.entries(kind.fields).map(([f, k]) => [f, initial(k)])))} {disabled}>
				<Icon icon="lucide:plus" class="size-3.5" />{t('add')}
			</Button>
		{:else}
			{@render fields(kind.fields)}
		{/if}
	{:else if kind.kind === 'union'}
		{@const tag = typeof obj[kind.by] === 'string' ? String(obj[kind.by]) : ''}
		<Combobox options={Object.keys(kind.arms).map((arm) => ({ value: arm, label: arm.replace(/_/g, ' ') }))} value={tag || null} onChange={(arm) => { if (arm !== null) onChange(armValue(kind, arm)); }} {disabled} aria-label={kind.by} />
		{#if kind.arms[tag]}{@render fields(kind.arms[tag], kind.by)}{/if}
	{:else if kind.kind === 'list'}
		{#each list as item, i (i)}
			<div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
				<div class="min-w-0">
					<Editor kind={kind.of} value={item} onChange={(x) => onChange(list.map((y, j) => (j === i ? x : y)))} name={at(i)} id={at(i)} {disabled} {errors} />
					{#if errors?.get(at(i))}<p class="text-xs text-destructive">{errors.get(at(i))}</p>{/if}
				</div>
				{#if !disabled}
					<div class="flex">
						<Button variant="ghost" size="icon" aria-label="↑" disabled={i === 0} onclick={() => onChange(list.map((y, j) => (j === i - 1 ? list[i]! : j === i ? list[i - 1]! : y)))}><Icon icon="lucide:arrow-up" class="size-3.5" /></Button>
						<Button variant="ghost" size="icon" aria-label={t('remove')} onclick={() => onChange(list.filter((_, j) => j !== i))}><Icon icon="lucide:trash-2" class="size-3.5" /></Button>
					</div>
				{/if}
			</div>
		{/each}
		{#if !disabled && (kind.max === undefined || list.length < kind.max)}
			<Button variant="outline" size="sm" class="justify-self-start" onclick={() => onChange([...list, initial(kind.of)])}><Icon icon="lucide:plus" class="size-3.5" />{t('add')}</Button>
		{/if}
	{:else if kind.kind === 'record'}
		{#each Object.entries(obj) as [key, item] (key)}
			<div class="grid grid-cols-[8rem_minmax(0,1fr)_auto] items-start gap-2">
				<span class="truncate pt-2 text-sm font-medium">{key}</span>
				<div class="min-w-0"><Editor kind={kind.of} value={item} onChange={(x) => set(key, x)} name={at(key)} {disabled} {errors} /></div>
				{#if !disabled}
					<Button variant="ghost" size="icon" aria-label={`${t('remove')} ${key}`} onclick={() => onChange(Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)))}><Icon icon="lucide:trash-2" class="size-3.5" /></Button>
				{/if}
			</div>
		{/each}
		{#if !disabled}
			<div class="flex gap-2">
				<Input value={newKey} oninput={(e) => (newKey = e.currentTarget.value)} placeholder={t('field')} class="max-w-48" />
				<Button variant="outline" size="sm" disabled={newKey.trim() === '' || newKey.trim() in obj} onclick={() => { set(newKey.trim(), initial(kind.of)); newKey = ''; }}>
					<Icon icon="lucide:plus" class="size-3.5" />{t('add')}
				</Button>
			</div>
		{/if}
	{:else if kind.kind === 'json' && kind.shape}
		<Self kind={kind.shape} {value} {onChange} {name} {disabled} {errors} />
	{:else}
		<Editor {kind} {value} {onChange} {name} id={name} {disabled} {errors} />
	{/if}
</div>
