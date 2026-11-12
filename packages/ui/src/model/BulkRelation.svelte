<!--
@component
A many-relation in "Edit selected", one level deep: new children for every selected record and, over one selected
record, existing children to link, unlink or delete. Explicit commands only (rule 22); its parent sends them in the one
`<c>.update` act.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { ChildInput, KindsHost } from '../kinds/context.js';
	import type { Values } from './types.js';
	import { formSpec } from '../form/draft.js';

	/** A many-relation's bulk commands, as the update's relation actions name them. */
	export type Links = { create: Values[]; link: Values[]; unlink: Values[]; delete: Values[] };
	export const NO_LINKS: Links = { create: [], link: [], unlink: [], delete: [] };
	/** The commands that need one selected record: an existing child belongs to exactly one parent. */
	export const SINGLE = ['link', 'unlink', 'delete'] as const;
	/** A new child's fields: the contract's create columns, kinded by the child's exposure (its parent key is implied). */
	export const childFields = (catalog: KindsHost['catalog'], child: ChildInput) => {
		const exposure = catalog?.[child.model];
		return child.create === undefined || exposure === undefined
			? []
			: (
					formSpec(child.model, { ...exposure, create: child.create }, 'create')?.fields ?? []
				).filter((field) => field.name !== child.parent && !field.kind.hidden);
	};
</script>

<script lang="ts">
	import { Button } from '../primitives/button/index.js';
	import { Effect } from 'effect';
	import { fork } from '../effect/index.js';
	import { by_id, first_of } from '../read/request.js';
	import Editor from '../kinds/editor.svelte';
	import Picker from '../kinds/picker.svelte';
	import Show from '../kinds/show.svelte';
	import { initial } from '../kinds/kind.js';
	import { bolt_of } from '../client/context.js';
	import { label, msg } from '../text/messages.js';
	import { toast } from '../toast/toast.svelte.js';

	let {
		ctx,
		name,
		child,
		parent_id,
		value,
		on_change,
		id,
		errors,
		disabled = false
	}: {
		ctx: UiContext;
		/** The relation's name on the parent (the key the act's `set` carries). */
		name: string;
		child: ChildInput;
		/** The one selected record; `undefined` over several, when only new children apply. */
		parent_id: string | undefined;
		value: Links;
		on_change(next: Links): void;
		id: string;
		errors: ReadonlyMap<string, string>;
		disabled?: boolean;
	} = $props();
	const kinds = $derived(ctx.ui.kinds),
		bolt = $derived(bolt_of(ctx));
	const fields = $derived(childFields(kinds.catalog, child));
	const ops = $derived(SINGLE.filter((op) => child[op] === true));
	const opText = (op: (typeof SINGLE)[number]) =>
		op === 'link'
			? msg(bolt, 'child.link')
			: op === 'unlink'
				? msg(bolt, 'child.unlink')
				: msg(bolt, 'child.delete');
	const at = (i: number, field: string) => `${name}.create.${i}.${field}`;
</script>

<div class="grid min-w-0 gap-2" data-bulk-relation={name}>
	{#each value.create as row, i (i)}
		<div class="border-border grid min-w-0 gap-2 rounded-md border p-2" data-bulk-relation-new={i}>
			{#each fields as field (field.name)}
				<label class="text-sm font-medium" for={`${id}-${i}-${field.name}`}
					>{field.kind.label ?? label(bolt, child.model, field.name)}</label
				>
				<Editor {ctx}
					kind={field.kind}
					value={row[field.name] ?? null}
					on_change={(next) =>
						on_change({
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
				variant="ghost"
				class="justify-self-start"
				{disabled}
				onclick={() => on_change({ ...value, create: value.create.filter((_, j) => j !== i) })}
			>
				{msg(bolt, 'view.removeNew')}
			</Button>
		</div>
	{/each}
	{#if fields.length > 0}
		<Button
			type="button"
			variant="outline"
			class="justify-self-start"
			{disabled}
			data-bulk-relation-add
			onclick={() =>
				on_change({
					...value,
					create: [
						...value.create,
						Object.fromEntries(fields.map((field) => [field.name, initial(field.kind)]))
					]
				})}
		>
			{msg(bolt, 'view.addEach')}
		</Button>
	{/if}
	{#if parent_id === undefined}
		{#if ops.length > 0}
			<p class="text-meta">
				{msg(bolt, 'view.relationOne'
				)}
			</p>
		{/if}
	{:else}
		{#each ops as op (op)}
			<div class="grid min-w-0 gap-1.5" data-bulk-relation-op={op}>
				<label class="text-meta" for={`${id}-${op}`}>{opText(op)}</label>
				{#each value[op] as chosen (chosen.id)}
					<div class="flex min-w-0 items-center gap-2">
						<Show {ctx} kind={{ kind: 'ref', to: child.model }} value={chosen.id ?? null} readonly />
						<Button
							type="button"
							variant="ghost"
							{disabled}
							onclick={() => on_change({ ...value, [op]: value[op].filter((x) => x !== chosen) })}
						>
							{msg(bolt, 'view.removeNew')}
						</Button>
					</div>
				{/each}
				<Picker {ctx}
					of={child.model}
					value={null}
					on_change={(next) => {
						if (next === null || value[op].some((row) => row.id === next)) return;
						// an audited child is linked at the revision it was read at
						const stamp = kinds.catalog?.[child.model]?.audit === false ? [] : ['revision'];
						fork(bolt.query(by_id(child.model, next, stamp)).pipe(
							Effect.tap((answer) => Effect.sync(() => {
								const row = first_of(answer, child.model);
								if (row !== null && !value[op].some((chosen) => chosen.id === next))
									on_change({ ...value, [op]: [...value[op], row] });
							})),
							Effect.catch((error) => Effect.sync(() => {
								toast.error(bolt.t(error.message));
							}))
						));
					}}
					where={op === 'link' ? undefined : { [child.parent]: parent_id }}
					id={`${id}-${op}`}
					{disabled}
				/>
			</div>
		{/each}
	{/if}
</div>
