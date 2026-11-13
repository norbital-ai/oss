<!--
@component
Edits a model row or an automation's input from authorized metadata: permitted fields only, drafts kept until the
outcome, only changed values sent. Defaults, required checks, state moves and approval routing come from the
declaration; a save routed to approval answers a held outcome that the native approval panel decides, so add no second
approval control and repeat no declared default.
@example
<Form {ctx} of="invoice" id={row.id} fields={['customer', 'due_on']} />
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Snippet } from 'svelte';
	import type { Value } from '../kinds/kind.js';
	import type { Row } from './draft.js';
	import type { Outcome } from '../client/contract.js';
	import { by_id, first_of } from '../read/request.js';
	import type {
		AutomationInputOf,
		AutomationKey,
		ModelKey,
		IdOf,
		InsertOf,
		RecordFieldOf,
		RecordOf
	} from '../model/types.js';
	import type { FormState, SemanticIssue } from './form-state.svelte.js';
	import type { RecordSection } from './section.svelte';
	import type { ConfirmOptions } from '../primitives/dialog/confirm.js';

	/** What a form edits: a model's row, or a declared automation's input. */
	export type FormSource = ModelKey | { [A in AutomationKey]: { automation: A } }[AutomationKey];
	/**
	 * A save that asks first: given the draft (`values`) and what it was opened with (`before`), the confirmation to
	 * show — its title, body and the accept button's words — or `null` to save without asking.
	 */
	export type FormConfirm = (change: {
		readonly values: Readonly<Record<string, Value>>;
		readonly before: Readonly<Record<string, Value>>;
	}) => ConfirmOptions | null;
	/** The props of `Form`: what it edits (`of`), create or update, the row id, and the layout of its fields. */
	export type FormProps<S = FormSource> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** What it edits: a model handle, or `{ automation }` for an automation's input (a submit queues a run). */
		of: S;
		/** `create` inserts; `update`/`edit` save the row `id`; `view` is `readonly`. Default: `update` with a model `id`, else `create`. */
		mode?: 'view' | 'edit' | 'create' | 'update';
		/** The row a model update edits. */
		id?: S extends string ? IdOf<S> : never;
		/** The stored row, when the page already reads it; else the enclosing `RecordShell`'s shown row (the scrubbed revision while one is picked) when it is this record, else the form reads it once. */
		record?: (S extends string ? RecordOf<S> : never) | null;
		/** Create and automation forms start from these direct input values over the defaults. */
		values?: S extends { automation: infer A }
			? Partial<AutomationInputOf<A>>
			: Partial<InsertOf<S>>;
		/** A subset and order of the generated fields. */
		fields?: readonly (S extends { automation: infer A }
			? keyof AutomationInputOf<A> & string
			: RecordFieldOf<S>)[];
		/** The generated fields grouped into collapsible `Section`s, in order; fields no section lists follow, untitled. */
		sections?: readonly RecordSection[];
		/** The submit button's label; default the create/save word. */
		submit?: string;
		/**
		 * Every field shows its value as copyable text, no field chrome, and no submit: the form as a view of the row. It
		 * reaches every `Field` and input beneath through context (a `Field` may override it). An update the
		 * viewer cannot make (no update grant) is readonly whatever this says. A form never inherits an outer mode.
		 */
		readonly?: boolean;
		/** Every field stays an editor, muted and inert, and the submit is disabled; a `Field` may override it. */
		disabled?: boolean;
		/** An automation reports queue admission here; its retained run is followed separately by RunStatus. */
		on_outcome?(outcome: Outcome): void;
		/** Asks before a valid draft saves: the dialog to show for this change, or `null` to save without asking. */
		confirm?: FormConfirm;
		/** Pure semantic checks over the draft. Reuse this validator in the server's guarded write. */
		validate?: (values: Readonly<Record<string, Value>>) => readonly SemanticIssue[];
		/** The page's own layout of `Field`s, given the `FormState`; without it every permitted field renders in order. */
		children?: Snippet<[FormState]>;
		/** Extra buttons beside submit. */
		actions?: Snippet<[FormState]>;
		/** Classes on the form element. */
		class?: string;
	};
</script>

<script lang="ts" generics="S extends FormSource">
	import { Effect } from 'effect';
	import ReadOnce from '../read/ReadOnce.svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import { ui_text } from '../primitives/utils.js';
	import { provide_model, provide_field_text } from '../model/context.js';
	import { bolt_of } from '../client/context.js';
	import { use_record_view } from '../record/context.js';
	import { formSpec } from './draft.js';
	import FormBody from './form-body.svelte';

	let {
		ctx,
		of,
		mode,
		id,
		record,
		values,
		fields,
		sections,
		submit,
		readonly,
		disabled,
		on_outcome,
		confirm,
		validate,
		children,
		actions,
		class: className
	}: FormProps<S> = $props();
	const bolt = $derived(bolt_of(ctx));
	const host = $derived(ctx.ui.kinds);
	const t = ui_text();
	const model = $derived(typeof of === 'string' ? of : '');
	const exposure = $derived(host.catalog?.[model]);
	const automation = $derived(
		typeof of === 'string' ? undefined : host.automations?.[of.automation]
	);
	// its fields' labels and enum words read this model's catalog keys
	provide_model(() => model);
	provide_field_text(() => typeof of === 'string' ? `models.${of}` : `automations.${of.automation}.input`);
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
	const spec = $derived(formSpec(of, exposure, resolved, id, automation));
	const seeded = $derived.by((): Row => {
		const given: Readonly<Record<string, Value | undefined>> = values ?? {};
		return Object.fromEntries(
			Object.entries(given).flatMap<[string, Value]>(([name, value]) =>
				value === undefined ? [] : [[name, value]]
			)
		);
	});
	const updating = $derived(typeof of === 'string' && resolved === 'update');
	const act = (
		acts: Readonly<Record<string, Value>>,
		options?: { key?: string }
	) => bolt.act(acts, options);

	// an update needs its row: the page's, else the record shell's shown one (the scrubbed revision while one is picked),
	// else one read; a stale link shows "Not found or no access"
	const view = use_record_view();
	const shown = $derived.by(() => {
		const v = view?.current;
		return v !== undefined &&
			v !== null &&
			v.mode !== 'create' &&
			v.model === model &&
			id !== undefined &&
			v.record['id'] === id
			? v.record
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
						: bolt.query(by_id(model, id)).pipe(
								Effect.map((answer): Row | null => first_of(answer, model)),
								Effect.catch(() => Effect.succeed(null))
							)
	);
	const parents = $derived.by(() => {
		if (typeof of !== 'string' || resolved !== 'create' || exposure === undefined) return [];
		const given = seeded;
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
				bolt.query(by_id(parent.of, parent.id, parent.fields)).pipe(
					Effect.map((answer) => first_of(answer, parent.of)),
					Effect.map((record) =>
						Object.fromEntries(
							parent.fields.map((field): [string, Value] => [field, record?.[field] ?? null])
						)
					),
					Effect.catch(() => Effect.succeed({}))
				),
			{ concurrency: 'unbounded' }
		).pipe(Effect.map((rows) => Object.fromEntries(rows.flatMap((row) => Object.entries(row)))))
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
	<ReadOnce effect={row} pending={loading}>
		{#snippet ready(stored)}
			{#if stored === undefined}
				{@render loading()}
			{:else if updating && stored === null}
				<Alert variant="secondary">{t('not_found')}</Alert>
			{:else}
				<ReadOnce effect={prefill} pending={loading}>
					{#snippet ready(inherited)}
						{#key `${spec.callable}:${id ?? ''}`}
							<FormBody {ctx}
								{spec}
								record={stored}
								values={{ ...inherited, ...seeded }}
								model_fields={exposure?.fields ?? {}}
								{act}
								{fields}
								{sections}
								{submit}
								readonly={readOnly}
								{disabled}
								{on_outcome}
								{confirm}
								{validate}
								{children}
								{actions}
								class={className}
							/>
						{/key}
					{/snippet}
				</ReadOnce>
			{/if}
		{/snippet}
	</ReadOnce>
{/if}
