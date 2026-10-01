<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Json } from '../kinds/kind.js';
	import type { Outcome, Row } from './draft.js';
	import type { ActionInputOf, ActionKey, CollectionKey, IdOf, InsertOf, RecordFieldOf, RecordOf } from '../views/bolt.js';
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
		mode?: 'create' | 'update';
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

<script lang="ts">
	import Alert from '../primitives/alert/alert.svelte';
	import { uiText } from '../primitives/utils.js';
	import { useKinds } from '../kinds/context.js';
	import { provideCollection, useBolt, useRecordView } from '../views/bolt.js';
	import { formSpec } from './draft.js';
	import FormBody from './form-body.svelte';

	let { of, mode, id, record, values = {}, fields, sections, submit, readonly, disabled, onOutcome, children, actions, class: className }: FormProps = $props();
	const bolt = useBolt();
	const host = useKinds();
	const t = uiText();
	const collection = $derived(typeof of === 'string' ? of : of.action.slice(0, of.action.lastIndexOf('.')));
	const exposure = $derived(host.catalog?.[collection]);
	// its fields' labels and enum words read this collection's catalog keys
	provideCollection(() => collection);
	const resolved = $derived(mode ?? (id !== undefined && typeof of === 'string' ? 'update' : 'create'));
	const spec = $derived(formSpec(of, exposure, resolved, id));
	const updating = $derived(typeof of === 'string' && resolved === 'update');
	const act = (callable: string, input: Json, options?: { key?: string }) => bolt.act(callable, input, options) as Promise<Outcome>;

	// an update needs its row: the page's, else the record shell's shown one (the scrubbed revision while one is picked),
	// else one read; a stale link shows "Not found or no access" (§5.10)
	const view = useRecordView();
	const shown = $derived.by(() => {
		const v = view?.current;
		return v?.mode === 'update' && v.collection === collection && id !== undefined && v.record['id'] === id ? v.record as Row : undefined;
	});
	let loaded = $state<{ id: string; row: Row | null } | null>(null);
	$effect(() => {
		if (!updating || record !== undefined || shown !== undefined || id === undefined || loaded?.id === id) return;
		const want = id;
		bolt.get<Row | null>(collection, want).then((row) => (loaded = { id: want, row }), () => (loaded = { id: want, row: null }));
	});
	const row = $derived(!updating ? null : record !== undefined ? record : shown !== undefined ? shown : loaded?.id === id ? loaded!.row : undefined);

	// a create under its parent (a line's prefilled `quote_id`): a currency field both declare starts as the parent's, so
	// the line's money reads in it before the host stamps the line's own copy
	const parents = $derived.by(() => {
		if (typeof of !== 'string' || resolved !== 'create' || exposure === undefined) return '[]';
		const given = values as Row;
		const own = Object.keys(exposure.fields).filter((f) => exposure.fields[f]?.kind === 'currency' && given[f] == null);
		return JSON.stringify(Object.entries(exposure.relations ?? {}).flatMap(([fk, r]) => {
			const parent = r.targets.length === 1 ? r.targets[0]! : '', shared = own.filter((f) => host.catalog?.[parent]?.fields[f]?.kind === 'currency');
			return typeof given[fk] === 'string' && shared.length > 0 ? [{ of: parent, id: given[fk], fields: shared }] : [];
		}));
	});
	let inherited = $state<{ key: string; row: Row } | null>(null);
	$effect(() => {
		const key = parents;
		if (key === '[]' || inherited?.key === key) return;
		const reads = (JSON.parse(key) as { of: string; id: string; fields: string[] }[]).map((p) => Promise.resolve(bolt.get<Row | null>(p.of, p.id))
			.then((r) => Object.fromEntries(p.fields.map((f) => [f, r?.[f] ?? null])), () => ({})));
		Promise.all(reads).then((rows) => (inherited = { key, row: Object.assign({}, ...rows) }));
	});
	const prefill = $derived(parents === '[]' ? {} : inherited?.key === parents ? inherited.row : undefined);
</script>

{#if spec === null}
	<Alert variant="secondary">{t('noAccess')}</Alert>
{:else if row === undefined || prefill === undefined}
	<!-- the form's shape while its row loads (staging's skeleton): labels, fields and the submit -->
	<div class="grid gap-4" role="status" aria-busy="true" data-form-loading>
		{#each [0, 1, 2, 3] as i (i)}
			<div class="grid gap-1.5"><div class="bg-muted h-4 w-28 animate-pulse rounded motion-reduce:animate-none"></div><div class="bg-muted h-9 animate-pulse rounded-sm motion-reduce:animate-none"></div></div>
		{/each}
		<div class="bg-muted h-9 w-full animate-pulse justify-self-end rounded-sm border-t motion-reduce:animate-none sm:w-28"></div>
	</div>
{:else if updating && row === null}
	<Alert variant="secondary">{t('notFound')}</Alert>
{:else}
	{#key `${spec.callable}:${id ?? ''}`}
		<FormBody {spec} record={row} values={{ ...prefill, ...values as Row }} modelFields={exposure?.fields ?? {}} {act} {fields} {sections} {submit} {readonly} {disabled} {onOutcome} {children} {actions} class={className} />
	{/key}
{/if}
