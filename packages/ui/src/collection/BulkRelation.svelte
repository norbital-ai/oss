<!--
@component
A many-relation in "Edit selected", one level deep: new children for every selected record and, over one selected
record, existing children to link, unlink or delete. Explicit commands only (rule 22); its parent sends them in the one
`<c>.update` act.
-->
<script lang="ts" module>
	import type { ChildInput, KindsHost } from '../kinds/context.js';
	import type { Values } from './types.js';
	import { formSpec } from '../form/draft.js';

	/** A many-relation's bulk commands, as the update's relation actions name them. */
	export type Links = { create: Values[]; link: string[]; unlink: string[]; delete: string[] };
	export const NO_LINKS: Links = { create: [], link: [], unlink: [], delete: [] };
	/** The commands that need one selected record: an existing child belongs to exactly one parent. */
	export const SINGLE = ['link', 'unlink', 'delete'] as const;
	/** A new child's fields: the contract's create columns, kinded by the child's exposure (its parent key is implied). */
	export const childFields = (catalog: KindsHost['catalog'], child: ChildInput) => {
		const exposure = catalog?.[child.collection];
		return child.create === undefined || exposure === undefined
			? []
			: (
					formSpec(child.collection, { ...exposure, create: child.create }, 'create')?.fields ?? []
				).filter((field) => field.name !== child.parent && !field.kind.hidden);
	};
</script>

<script lang="ts">
	import { Button } from '../primitives/button/index.js';
	import Editor from '../kinds/editor.svelte';
	import Picker from '../kinds/picker.svelte';
	import Show from '../kinds/show.svelte';
	import { initial } from '../kinds/kind.js';
	import { useKinds } from '../kinds/context.js';
	import { useBolt } from '../client/context.js';
	import { label, msg } from '../text/messages.js';

	let {
		name,
		child,
		parentId,
		value,
		onChange,
		id,
		errors,
		disabled = false
	}: {
		/** The relation's name on the parent (the key the act's `set` carries). */
		name: string;
		child: ChildInput;
		/** The one selected record; `undefined` over several, when only new children apply. */
		parentId: string | undefined;
		value: Links;
		onChange(next: Links): void;
		id: string;
		errors: ReadonlyMap<string, string>;
		disabled?: boolean;
	} = $props();
	const kinds = useKinds(),
		bolt = useBolt();
	const fields = $derived(childFields(kinds.catalog, child));
	const ops = $derived(SINGLE.filter((op) => child[op] === true));
	const opText = (op: (typeof SINGLE)[number]) =>
		op === 'link'
			? msg(bolt, 'child.link', 'Link existing')
			: op === 'unlink'
				? msg(bolt, 'child.unlink', 'Unlink')
				: msg(bolt, 'child.delete', 'Delete row');
	const at = (i: number, field: string) => `${name}.create.${i}.${field}`;
</script>

<div class="grid min-w-0 gap-2" data-bulk-relation={name}>
	{#each value.create as row, i (i)}
		<div class="border-border grid min-w-0 gap-2 rounded-md border p-2" data-bulk-relation-new={i}>
			{#each fields as field (field.name)}
				<label class="text-sm font-medium" for={`${id}-${i}-${field.name}`}
					>{field.kind.label ?? label(bolt, child.collection, field.name)}</label
				>
				<Editor
					kind={field.kind}
					value={row[field.name] ?? null}
					onChange={(next) =>
						onChange({
							...value,
							create: value.create.map((r, j) => (j === i ? { ...r, [field.name]: next } : r))
						})}
					name={at(i, field.name)}
					id={`${id}-${i}-${field.name}`}
					{row}
					relation={field.relation}
					{errors}
					{disabled}
				/>
				{#if errors.get(at(i, field.name))}
					<p role="alert" class="text-destructive text-xs">
						{bolt.t(errors.get(at(i, field.name)) ?? '')}
					</p>
				{/if}
			{/each}
			<Button
				type="button"
				size="sm"
				variant="ghost"
				class="justify-self-start"
				{disabled}
				onclick={() => onChange({ ...value, create: value.create.filter((_, j) => j !== i) })}
			>
				{msg(bolt, 'view.removeNew', 'Remove')}
			</Button>
		</div>
	{/each}
	{#if fields.length > 0}
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="justify-self-start"
			{disabled}
			data-bulk-relation-add
			onclick={() =>
				onChange({
					...value,
					create: [
						...value.create,
						Object.fromEntries(fields.map((field) => [field.name, initial(field.kind)]))
					]
				})}
		>
			{msg(bolt, 'view.addEach', 'Add a new one to each selected record')}
		</Button>
	{/if}
	{#if parentId === undefined}
		{#if ops.length > 0}
			<p class="text-meta">
				{msg(
					bolt,
					'view.relationOne',
					'Select one record to link, unlink or delete existing ones.'
				)}
			</p>
		{/if}
	{:else}
		{#each ops as op (op)}
			<div class="grid min-w-0 gap-1.5" data-bulk-relation-op={op}>
				<label class="text-meta" for={`${id}-${op}`}>{opText(op)}</label>
				{#each value[op] as chosen (chosen)}
					<div class="flex min-w-0 items-center gap-2">
						<Show kind={{ kind: 'id', of: child.collection }} value={chosen} readonly />
						<Button
							type="button"
							size="sm"
							variant="ghost"
							{disabled}
							onclick={() => onChange({ ...value, [op]: value[op].filter((x) => x !== chosen) })}
						>
							{msg(bolt, 'view.removeNew', 'Remove')}
						</Button>
					</div>
				{/each}
				<Picker
					of={child.collection}
					value={null}
					onChange={(next) => {
						if (next !== null && !value[op].includes(next))
							onChange({ ...value, [op]: [...value[op], next] });
					}}
					where={op === 'link' ? undefined : { [child.parent]: parentId }}
					id={`${id}-${op}`}
					{disabled}
				/>
			</div>
		{/each}
	{/if}
</div>
