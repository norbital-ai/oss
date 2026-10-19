<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Value } from '../kinds/kind.js';
	import type { Outcome, Row } from './draft.js';
	import type {
		ActionInputOf,
		ActionKey,
		CollectionKey,
		IdOf,
		InsertOf,
		RecordFieldOf,
		RecordOf
	} from '../collection/types.js';
	import type { FormState } from './form-state.svelte.js';
	import type { RecordSection } from './section.svelte';

	/**
	 * `Form of="<c>" mode="create" | "update"` edits a collection's allowlisted fields; `Form of={{ action: '<c>.<a>' }}`
	 * renders an action's `input` literal and calls it (§3.6). Generated from the collection's exposure: without
	 * `children` every allowlisted field renders in order; with `children` the page lays out its own `Field`s.
	 */
	/** What a form edits: a collection's row, or an action's input. */
	export type FormSource = CollectionKey | { [A in ActionKey]: { action: A } }[ActionKey];
	type Target<S> = S extends { action: `${infer C}.${string}` } ? C : S;
	/** The props of `Form`: what it edits (`of`), create or update, the row id, and the layout of its fields. */
	export type FormProps<S = FormSource> = {
		of: S;
		mode?: 'view' | 'edit' | 'create' | 'update';
		/** The row an update edits, or a record action's target. */
		id?: IdOf<Target<S>>;
		/** The stored row, when the page already reads it; else the enclosing `RecordShell`'s shown row (the scrubbed revision while one is picked) when it is this record, else the form reads it once. */
		record?: (S extends string ? RecordOf<S> : Row) | null;
		/** Create and action forms start from these values over the defaults. */
		values?: Partial<S extends { action: infer A } ? ActionInputOf<A> : InsertOf<S>>;
		/** A subset and order of the generated fields. */
		fields?: readonly (S extends string ? RecordFieldOf<S> : string)[];
		/** The generated fields grouped into collapsible `Section`s, in order; fields no section lists follow, untitled. */
		sections?: readonly RecordSection[];
		submit?: string;
		/**
		 * Every field shows its value as copyable text, no field chrome, and no submit: the form as a view of the row. It
		 * reaches every `Field` and input beneath through context (a `Field` or `Fieldset` may override it). An update the
		 * viewer cannot make (no update grant) is readonly whatever this says. A form never inherits an outer mode.
		 */
		readonly?: boolean;
		/** Every field stays an editor, muted and inert, and the submit is disabled; a `Field` or `Fieldset` may override it. */
		disabled?: boolean;
		onOutcome?(outcome: Outcome): void;
		children?: Snippet<[FormState]>;
		/** Extra buttons beside submit. */
		actions?: Snippet<[FormState]>;
		class?: string;
	};
</script>

<script lang="ts" generics="S extends FormSource">
	import { Effect } from 'effect';
	import { run } from '../effect/index.js';
	import Alert from '../primitives/alert/alert.svelte';
	import { uiText } from '../primitives/utils.js';
	import { useKinds } from '../kinds/context.js';
	import { provideCollection } from '../collection/context.js';
	import { useBolt } from '../client/context.js';
	import { useRecordView } from '../record/context.js';
	import { formSpec } from './draft.js';
	import FormBody from './form-body.svelte';

	let {
		of,
		mode,
		id,
		record,
		values = {},
		fields,
		sections,
		submit,
		readonly,
		disabled,
		onOutcome,
		children,
		actions,
		class: className
	}: FormProps<S> = $props();
	const bolt = useBolt();
	const host = useKinds();
	const t = uiText();
	const collection = $derived(
		typeof of === 'string' ? of : of.action.slice(0, of.action.lastIndexOf('.'))
	);
	const exposure = $derived(host.catalog?.[collection]);
	// its fields' labels and enum words read this collection's catalog keys
	provideCollection(() => collection);
	const resolved = $derived(
		mode === 'create'
			? 'create'
			: mode !== undefined
				? 'update'
				: id !== undefined && typeof of === 'string'
					? 'update'
					: 'create'
	);
	const readOnly = $derived(readonly === true || mode === 'view');
	const spec = $derived(formSpec(of, exposure, resolved, id));
	const updating = $derived(typeof of === 'string' && resolved === 'update');
	const act = (
		callable: string,
		input: Value,
		options?: { key?: string; observed?: Readonly<Record<string, number>> }
	) => bolt.act(callable, input, options);

	// an update needs its row: the page's, else the record shell's shown one (the scrubbed revision while one is picked),
	// else one read; a stale link shows "Not found or no access" (§5.10)
	const view = useRecordView();
	const shown = $derived.by(() => {
		const v = view?.current;
		return v !== undefined &&
			v !== null &&
			v.mode !== 'create' &&
			v.collection === collection &&
			id !== undefined &&
			v.record['id'] === id
			? (v.record as Row)
			: undefined;
	});
	const row = $derived(
		!updating
			? Effect.succeed(null)
			: record !== undefined
				? Effect.succeed(record)
				: shown !== undefined
					? Effect.succeed(shown)
					: id === undefined
						? Effect.succeed(undefined)
						: bolt.get<Row | null>(collection, id).pipe(Effect.catch(() => Effect.succeed(null)))
	);
	const parents = $derived.by(() => {
		if (typeof of !== 'string' || resolved !== 'create' || exposure === undefined) return [];
		const given = values;
		const own = Object.keys(exposure.fields).filter(
			(field) => exposure.fields[field]?.kind === 'currency' && given[field] == null
		);
		return Object.entries(exposure.relations ?? {}).flatMap(([field, relation]) => {
			const id = given[field];
			const target = relation.targets.length === 1 ? relation.targets[0] : undefined;
			const parent = target === undefined ? undefined : host.catalog?.[target];
			return typeof id !== 'string' || target === undefined || parent === undefined
				? []
				: [
						{
							of: target,
							id,
							fields: own.filter((name) => parent.fields[name]?.kind === 'currency')
						}
					];
		});
	});
	const prefill = $derived(
		Effect.forEach(
			parents,
			(parent) =>
				bolt.get<Row | null>(parent.of, parent.id).pipe(
					Effect.map((record) =>
						Object.fromEntries(parent.fields.map((field) => [field, record?.[field] ?? null]))
					),
					Effect.catch(() => Effect.succeed({}))
				),
			{ concurrency: 'unbounded' }
		).pipe(Effect.map((rows) => Object.assign({}, ...rows)))
	);
</script>

{#snippet loading()}
	<!-- the form's shape while its row loads : labels, fields and the submit -->
	<div class="grid gap-4" role="status" aria-busy="true" data-form-loading>
		{#each [0, 1, 2, 3] as i (i)}
			<div class="grid gap-1.5">
				<div class="bg-muted h-4 w-28 animate-pulse rounded motion-reduce:animate-none"></div>
				<div class="bg-muted h-9 animate-pulse rounded-sm motion-reduce:animate-none"></div>
			</div>
		{/each}
		<div
			class="bg-muted h-9 w-full animate-pulse justify-self-end rounded-sm border-t motion-reduce:animate-none sm:w-28"
		></div>
	</div>
{/snippet}

{#if spec === null}
	<Alert variant="secondary">{t('noAccess')}</Alert>
{:else}
	{#await run(row)}
		{@render loading()}
	{:then stored}
		{#if stored === undefined}
			{@render loading()}
		{:else if updating && stored === null}
			<Alert variant="secondary">{t('notFound')}</Alert>
		{:else}
			{#await run(prefill)}
				{@render loading()}
			{:then inherited}
				{#key `${spec.callable}:${id ?? ''}`}
					<FormBody
						{spec}
						record={stored}
						values={{ ...inherited, ...(values as Row) }}
						modelFields={exposure?.fields ?? {}}
						{act}
						{fields}
						{sections}
						{submit}
						readonly={readOnly}
						{disabled}
						{onOutcome}
						{children}
						{actions}
						class={className}
					/>
				{/key}
			{/await}
		{/if}
	{/await}
{/if}
