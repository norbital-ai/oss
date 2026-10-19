<script lang="ts" module>
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import type { Json } from '../client/contract.js';
	import type { Row, Values } from './types.js';
	import type { Fields, Value } from '../kinds/kind.js';
	import type { CollectionExposure } from '../kinds/context.js';
	import { formSpec } from '../form/draft.js';
	import { presentation } from '../kinds/registry.js';
	import { edgesFrom } from '../kinds/kind.js';
	/**
	 * The fields "Edit selected" offers: the caller's update columns, each edited by its kind's editor. A state is edited
	 * as the states some edge moves into (the host judges each row's move); other derived kinds are never written.
	 */
	export const editableFields = (exposure: CollectionExposure | undefined) =>
		(formSpec('', exposure, 'update')?.fields ?? []).flatMap((field) => {
			const kind = field.kind;
			if (field.readonly || kind.hidden || exposure?.masked?.includes(field.name)) return [];
			if (kind.kind !== 'state') return presentation(kind).derived ? [] : [field];
			const to = [...new Set(Object.keys(kind.states).flatMap((s) => edgesFrom(kind, s)))];
			return to.length === 0
				? []
				: [
						{
							...field,
							kind: {
								kind: 'enum' as const,
								values: to,
								...(kind.label === undefined ? {} : { label: kind.label })
							}
						}
					];
		});
	/** The many-relations "Edit selected" offers, one level deep: those the caller's update contract (`update.with`) admits. */
	export const editableRelations = (exposure: CollectionExposure | undefined) =>
		Object.entries(exposure?.update?.with ?? {}).flatMap(([name, child]) =>
			exposure?.masked?.includes(name) ||
			(child.create === undefined && !child.link && !child.unlink && !child.delete)
				? []
				: [{ name, child }]
		);

	type IdIn<R> = R extends { readonly id: infer I extends string } ? I : string;
	/**
	 * An author's actions-menu item (§3.6): an icon, a name, a line of description and the handler itself. The menu owns
	 * the rest: a promise the handler returns is the item's pending state, a rejection or a refused outcome its error (in
	 * place and as a toast), an `Outcome` (`bolt.act`) is toasted, and a run handle (`bolt.start`) shows its run under the
	 * toolbar. A handler that returns nothing closes the menu (it opened a sheet or a file picker of its own).
	 */
	export type ToolbarItem<R = Row> = {
		/** An Iconify id (`lucide:upload`). */
		icon: string;
		name: string;
		/** One line under the name. */
		description?: string;
		run: (selected: IdIn<R>[]) => Effect.Effect<unknown, Error> | void;
		/** Turns row selection on and lists the item under Bulk; it is disabled until rows are selected. */
		requiresSelection?: true;
		/** Why the item cannot run now (over this selection), or null when it can; shown instead of `description`. */
		disabled?: (selected: IdIn<R>[]) => string | null;
	};
	/**
	 * A view's whole chrome, one shape on `Table`, `Board`, `Map` and `Pivot`. Every key defaults from the collection's
	 * declaration and the viewer's grants; `toolbar={false}` renders none.
	 */
	export type Toolbar<R = Row> =
		| false
		| {
				/** Default: the collection's label. */
				title?: string | false;
				/** Behind the info icon. Default: the collection's declared description, else its model's. */
				description?: string | false;
				/** Default on where the collection declares search fields. */
				search?: boolean;
				/** The filter-and-sort popover (rule 16b). Default on. */
				filter?: boolean;
				/** Author items in the actions menu, after the collection's callables; `false` hides the menu. */
				actions?: readonly ToolbarItem<R>[] | false;
				/** "Export CSV" of the rows in view. Default on; replaced by "Export" when the collection declares an export pipeline. */
				export?: boolean;
				/** "Delete selected" when the viewer may delete (turns selection on). Default: the viewer may delete. */
				delete?: boolean;
				/** Record checkboxes (`Table` and `Board`). Default: on for permitted bulk edits, deletes or selection actions. */
				select?: boolean;
				/** The New button: the record sheet in create mode, or the author's own (a prefilled create). Default: the viewer may create. */
				new?: boolean | (() => void);
				/** The page's own scope controls (a period picker, an entity picker), placed in the toolbar before search. Never actions. */
				controls?: Snippet;
				/**
				 * What the view is scoped to (`{ company_id, period }`), handed to the collection's pipeline: the import and
				 * its template decode it against the pipeline's `context` fields. It narrows and defaults; it never authorizes.
				 */
				context?: { readonly [field: string]: Json };
		  };
	/** Selection follows the same actionable catalogue and explicit opt-outs in every record view. */
	export function selectionEnabled<R>(
		config: Toolbar<R> | undefined,
		exposure: CollectionExposure | undefined
	): boolean {
		if (config === false || config?.actions === false || config?.select === false) return false;
		return (
			config?.select === true ||
			(config?.delete !== false && exposure?.delete === true) ||
			editableFields(exposure).length > 0 ||
			editableRelations(exposure).length > 0 ||
			Object.values(exposure?.actions ?? {}).some((action) => action.target === 'record') ||
			(config?.actions ?? []).some(
				(item) => item.requiresSelection || typeof item.disabled === 'function'
			)
		);
	}
	type Exporter = {
		fields: readonly string[];
		labels: readonly string[];
		kinds?: Fields;
		read: () => Effect.Effect<unknown, Error>;
	};
</script>

<script lang="ts" generics="R extends object = Row">
	import { FiberSet, Schema } from 'effect';
	import { encodeWire } from '@norbital-ai/std/wire';
	import { fork, attach } from '../effect/index.js';
	import { Button } from '../primitives/button/index.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { useKinds } from '../kinds/context.js';
	import FormView from '../form/form.svelte';
	import BulkRelation, { childFields, NO_LINKS, type Links } from './BulkRelation.svelte';
	import { getAllContexts, tick, untrack, onDestroy } from 'svelte';
	import Editor from '../kinds/editor.svelte';
	import { enumText, initial, likeWhere, problems } from '../kinds/kind.js';
	import { uiText } from '../primitives/utils.js';
	import { offerContexts, openRecord } from '../record/navigation.js';
	import { useBolt } from '../client/context.js';
	import { type Outcome, type RunHandle } from '../client/contract.js';
	import { nodeText, pathLabel, pathOf, sortText } from '../filter/filter.js';
	import { CSV_BOM, csvCell } from '../table/csv.js';
	import { filesOf } from '../cell/value.js';
	import { humanize, label, msg } from '../text/messages.js';
	import { isRow, objectsOf, rowsOf } from '../read/results.js';
	import { outcomeText } from '../actions/outcome.js';
	import { searchIndexes, SEMANTIC_SEARCH, SLASH, type SearchIndex } from '../table/model.js';
	import { unref } from '../relations/select.js';
	import type { ViewState } from '../filter/view-state.svelte.js';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import RunStatus from '../runs/RunStatus.svelte';
	import ViewPopover from '../filter/ViewPopover.svelte';
	import { notify } from '../actions/notify.js';
	import { downloadTextFiles } from '../utilities/download.js';
	import { toast } from '../toast/toast.svelte.js';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { recordLabels } from '../record/labels.svelte.js';
	import { watch as live } from '../read/live.svelte.js';
	import { watch } from 'runed';

	let {
		config = {},
		collection,
		view,
		catalog,
		source = collection,
		author,
		sortable = [],
		q = $bindable(''),
		searchable = false,
		selected,
		onSettled,
		exporter,
		onAdd,
		onProbe
	}: {
		config?: Toolbar<R> | undefined;
		/** The collection the defaults come from; `''` for a source without one. */
		collection: string;
		view?: ViewState;
		catalog: { readonly [c: string]: CollectionExposure };
		/** The view popover's collection (a local array's `$local`). */
		source?: string;
		author?: Json;
		sortable?: readonly string[];
		q?: string;
		searchable?: boolean;
		/** The selected ids when the view selects rows (then a record action runs over one of them). */
		selected?: readonly IdIn<R>[] | undefined;
		/** After an act over the selection settles. */
		onSettled?: () => void;
		exporter?: Exporter;
		/** A local array's "Add row", in New's place. */
		onAdd?: () => void;
		/** A typed index's search (`/<similarity>` or `/<query>` and its input), or `null` back to the box's text; absent: the view shows no ranked rows. */
		onProbe?: (probe: { name: string; via: 'similar' | 'query'; input: Json } | null) => void;
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const cfg = $derived(config === false ? null : (config ?? {}));
	const x = $derived(catalog[collection] ?? kinds.catalog?.[collection]);
	const title = $derived(
		cfg?.title === false ? '' : (cfg?.title ?? (collection === '' ? '' : label(bolt, collection)))
	);
	const about = $derived(
		cfg?.description === false ? '' : (cfg?.description ?? x?.description ?? '')
	);
	const offered = $derived(searchable && cfg?.search !== false);
	// L-BOLT-495: `/` at the start of the box lists the collection's search indexes; the picked one is a chip. `semantic`
	// keeps the box as its text (`/semantic <text>`, rule 16); a typed similarity swaps the box for its input's editors and
	// hands the view its probe. Backspace on an empty box (or the chip's ×) is back to the lexical search.
	const t = uiText();
	// the collection's declared search fields, else its label's text fields (the Table searches those by `like`)
	const lexicalFields = $derived(
		(x?.search?.length ?? 0) > 0
			? (x?.search ?? [])
			: (x?.label ?? []).filter((f) => likeWhere(x, [f], 'x') !== undefined)
	);
	// a local array (a custom view's rows) searches its own columns, even when it names the collection its menu acts on
	const local = $derived(collection === '' || source !== collection);
	const lexical = $derived(local || lexicalFields.length > 0);
	const indexes = $derived(
		offered && !local
			? searchIndexes(x, onProbe !== undefined, {
					meaning: t('searchMeaning'),
					raw: t('searchRaw'),
					view: t('searchView')
				})
			: []
	);
	// the search icon exists only over something searchable: the collection's search fields or a declared index
	const canSearch = $derived(offered && (lexical || indexes.length > 0));
	// a collection's declared search fields; a local array searches the columns it shows (the roster's people)
	const fieldsSearched = $derived(
		local
			? Object.keys(catalog[source]?.fields ?? {}).map((f) =>
					pathLabel(catalog, source, f, humanize)
				)
			: lexicalFields.map((s) => pathLabel(catalog, collection, s, humanize))
	);
	let index = $state<string | null>(untrack(() => (SEMANTIC_SEARCH.test(q) ? 'semantic' : null)));
	let text = $state(untrack(() => q.replace(SEMANTIC_SEARCH, '')));
	let values = $state<Values>({});
	let box = $state<HTMLInputElement>();
	const chosen = $derived(indexes.find((i) => i.name === index));
	// a `/…` with no index chosen is the picker's, never a search term: the rows stay unfiltered
	const picking = $derived(index === null && SLASH.test(text));
	const menuOf = $derived(picking ? indexes.filter((i) => i.name.startsWith(text.slice(1))) : []);
	const ready = $derived(
		chosen?.input !== undefined &&
			Object.entries(chosen.input).every(([f, k]) => problems(k, values[f] ?? null).size === 0)
	);
	// what the view reads: the text, `/semantic <text>`, or nothing while a typed index or the `/` list holds the box
	const send = () =>
		(q =
			index === 'semantic'
				? text.trim() === ''
					? ''
					: `/semantic ${text}`
				: index === null && lexical && !SLASH.test(text)
					? text
					: '');
	// repository-health:allow EFF3 -- D13: this selection helper only updates presentation state and focuses the rendered input.
	async function pick(i: SearchIndex) {
		if (i.why !== null) return;
		index = i.name;
		text = '';
		values = Object.fromEntries(Object.entries(i.input ?? {}).map(([f, k]) => [f, initial(k)]));
		send();
		// repository-health:allow EFF3 -- Wait for the presentation update before moving DOM focus.
		await tick();
		box?.focus();
	}
	function clear() {
		if (chosen?.input !== undefined) onProbe?.(null);
		index = null;
		send();
	}
	function typing(value: string) {
		text = value;
		const named = index === null ? /^\/(\S+)\s$/.exec(value)?.[1] : undefined;
		const i = indexes.find((x) => x.name === named);
		if (i !== undefined && i.why === null) return void pick(i);
		send();
	}
	function key(e: KeyboardEvent) {
		if (e.key === 'Backspace' && index !== null && text === '') {
			e.preventDefault();
			clear();
		} else if (e.key === 'Enter' && menuOf.length > 0) {
			e.preventDefault();
			const first = menuOf.find((i) => i.why === null);
			if (first !== undefined) void pick(first);
		}
	}
	const canFilter = $derived(view !== undefined && cfg?.filter !== false);
	const canNew = $derived(
		cfg?.new !== false &&
			(onAdd !== undefined ||
				typeof cfg?.new === 'function' ||
				(collection !== '' && x?.create !== undefined))
	);
	// the page's contexts ride into the shell's sheet, which mounts outside the page (its create scope)
	const contexts = getAllContexts();
	// svelte-ignore state_referenced_locally
	onDestroy(collection === '' ? () => {} : offerContexts(collection, contexts));
	const create = () =>
		onAdd
			? onAdd()
			: typeof cfg?.new === 'function'
				? cfg.new()
				: openRecord(collection, 'new', contexts);
	const searchHint = $derived.by(() => {
		const f = fieldsSearched.slice(0, 3);
		return f.length === 0
			? msg(bolt, 'table.search', 'Search')
			: msg(bolt, 'table.searchIn', 'Search {fields}', { fields: f.join(', ') });
	});

	// ── the actions menu: callables, the integration's run, the pipeline's import and export, export, delete-selected, the author's items ──
	const callables = $derived(
		cfg?.actions === false
			? []
			: Object.entries(x?.actions ?? {}).flatMap(([name, a]) =>
					a.target === 'record' && selected === undefined ? [] : [{ name, ...a }]
				)
	);
	const picked = $derived(selected ?? []);
	const items = $derived(cfg?.actions === false || cfg?.actions === undefined ? [] : cfg.actions);
	const sync = $derived(cfg?.actions === false ? undefined : x?.integration);
	// the collection's `+pipeline.ts` import and export the viewer may run, each a `<c>.pipeline` run (§3.3.5)
	const pipeline = $derived(cfg?.actions === false ? undefined : x?.pipeline);
	const canImport = $derived(pipeline?.import !== undefined && kinds.upload !== undefined);
	const canExport = $derived(
		cfg?.actions !== false &&
			cfg?.export !== false &&
			exporter !== undefined &&
			pipeline?.export === undefined
	);
	const canDelete = $derived(
		selected !== undefined && cfg?.actions !== false && cfg?.delete !== false && x?.delete === true
	);
	const editFields = $derived(editableFields(x));
	const editRelations = $derived(editableRelations(x));
	const canUpdate = $derived(
		selected !== undefined &&
			cfg?.actions !== false &&
			(editFields.length > 0 || editRelations.length > 0)
	);
	let editValues = $state<Values>({});
	let editLinks = $state<Readonly<Record<string, Links>>>({});
	// the one selected record, the only parent existing children may be linked to, unlinked from or deleted under
	const editParent = $derived(picked.length === 1 ? picked[0] : undefined);
	const editSet = $derived(
		Object.fromEntries<Value>([
			...editFields.flatMap<readonly [string, Value]>((field) =>
				Object.hasOwn(editValues, field.name) ? [[field.name, editValues[field.name] ?? null]] : []
			),
			...editRelations.flatMap<readonly [string, Value]>(({ name }) => {
				const links = editLinks[name];
				if (links === undefined) return [];
				const actions = Object.fromEntries(
					Object.entries(links).filter(
						([op, list]) => list.length > 0 && (op === 'create' || editParent !== undefined)
					)
				);
				return Object.keys(actions).length === 0 ? [] : [[name, actions]];
			})
		])
	);
	const editProblems = $derived(
		new Map([
			...editFields.flatMap((field) =>
				Object.hasOwn(editSet, field.name)
					? [...problems(field.kind, editSet[field.name], field.name)]
					: []
			),
			...editRelations.flatMap(({ name, child }) => {
				const fields = childFields(kinds.catalog, child);
				return (editLinks[name]?.create ?? []).flatMap((row, i) =>
					fields.flatMap((field) => [
						...problems(field.kind, row[field.name], `${name}.create.${i}.${field.name}`)
					])
				);
			})
		])
	);
	const editReady = $derived(
		canUpdate && picked.length > 0 && Object.keys(editSet).length > 0 && editProblems.size === 0
	);
	const editorId = $props.id();
	function chooseEdit(field: (typeof editFields)[number], chosen: boolean) {
		editValues = chosen
			? { ...editValues, [field.name]: initial(field.kind) }
			: Object.fromEntries(Object.entries(editValues).filter(([name]) => name !== field.name));
	}
	function chooseLinks(name: string, chosen: boolean) {
		editLinks = chosen
			? { ...editLinks, [name]: NO_LINKS }
			: Object.fromEntries(Object.entries(editLinks).filter(([rel]) => rel !== name));
	}
	type Group = 'bulk' | 'import' | 'general';
	// every row of the menu, each in its group: an icon, its words, and the button that runs `act` (a callable's opens its form inline)
	type Entry = {
		key: string;
		group: Group;
		glyph: GlyphName;
		icon?: string;
		text: string;
		hint?: string;
		why: string | null;
		button: string;
		act: () => Effect.Effect<unknown, Error> | void;
		saved?: string;
		danger?: true;
		form?: { callable: string; target: string | undefined };
	};
	const entries = $derived.by((): Entry[] => {
		const ids = [...picked];
		const integration = sync;
		const selectFirst = msg(bolt, 'view.selectRows', 'Select rows first');
		const run = msg(bolt, 'view.run', 'Run');
		return [
			...callables.map((c): Entry => {
				const callable = `${collection}.${c.name}`;
				return {
					key: callable,
					group: c.target === 'record' ? 'bulk' : 'general',
					glyph: 'play',
					text: humanize(c.name),
					hint: c.description,
					why:
						c.target === 'record' && picked.length !== 1
							? msg(bolt, 'view.selectOne', 'Select one row')
							: null,
					button: run,
					act: () => {
						form = form === callable ? null : callable;
					},
					form: { callable, target: c.target }
				};
			}),
			...items.map((item): Entry => ({
				key: `item:${item.name}`,
				group: item.requiresSelection ? 'bulk' : 'general',
				glyph: 'play',
				icon: item.icon,
				text: item.name,
				why:
					item.disabled?.(ids) ??
					(item.requiresSelection && picked.length === 0 ? selectFirst : null),
				button: run,
				act: () => item.run([...picked]),
				...(item.description === undefined ? {} : { hint: item.description })
			})),
			...(integration !== undefined
				? [
						{
							key: 'sync',
							group: 'import',
							glyph: 'sync',
							text: msg(bolt, 'view.sync', 'Sync now'),
							hint: msg(bolt, 'view.syncHint', 'Pull the latest records from the source'),
							why: null,
							button: msg(bolt, 'view.syncButton', 'Sync'),
							act: () => bolt.start(integration, {})
						} satisfies Entry
					]
				: []),
			...(canImport
				? [
						{
							key: 'import',
							group: 'import',
							glyph: 'upload',
							text: msg(bolt, 'view.import', 'Import…'),
							hint: pipeline?.import,
							why: null,
							button: msg(bolt, 'view.upload', 'Upload'),
							act: () => void picker?.click()
						} satisfies Entry
					]
				: []),
			// the import's sheet, from its declared fields (and its template rows): a run whose file RunStatus links
			...(canImport
				? [
						{
							key: 'template',
							group: 'import',
							glyph: 'download',
							text: msg(bolt, 'view.template', 'Download template'),
							hint: msg(bolt, 'view.templateHint', "The import's columns as a spreadsheet"),
							why: null,
							button: msg(bolt, 'view.download', 'Download'),
							act: () => bolt.start(`${collection}.pipeline`, { mode: 'template', ...scoped() })
						} satisfies Entry
					]
				: []),
			...(pipeline?.export !== undefined
				? [
						{
							key: 'export-pipeline',
							group: 'import',
							glyph: 'download',
							text: msg(bolt, 'view.exportPipeline', 'Export'),
							hint: pipeline.export,
							why: null,
							button: msg(bolt, 'view.download', 'Download'),
							act: () => bolt.start(`${collection}.pipeline`, { mode: 'export' })
						} satisfies Entry
					]
				: []),
			...(canExport
				? [
						{
							key: 'export',
							group: 'import',
							glyph: 'download',
							text: msg(bolt, 'table.export', 'Export CSV'),
							hint: msg(bolt, 'view.exportHint', 'The rows in view, as shown'),
							why: null,
							button: msg(bolt, 'view.download', 'Download'),
							act: exportCsv
						} satisfies Entry
					]
				: []),
			...(canUpdate
				? [
						{
							key: 'update',
							group: 'bulk',
							glyph: 'play',
							text: msg(bolt, 'view.editSelected', 'Edit selected'),
							hint: msg(
								bolt,
								'view.editSelectedHint',
								'Choose the fields to change on every selected record'
							),
							why: picked.length === 0 ? selectFirst : null,
							button: msg(bolt, 'view.editButton', 'Edit'),
							act: () => {
								if (form === `${collection}.update`) form = null;
								else {
									editValues = {};
									editLinks = {};
									form = `${collection}.update`;
								}
							},
							form: { callable: `${collection}.update`, target: 'selection' }
						} satisfies Entry
					]
				: []),
			...(canDelete
				? [
						{
							key: 'delete',
							group: 'bulk',
							glyph: 'trash',
							text: msg(bolt, 'table.delete', 'Delete selected'),
							why: picked.length === 0 ? selectFirst : null,
							button: msg(bolt, 'view.deleteButton', 'Delete'),
							act: remove,
							saved: msg(bolt, 'outcome.deleted', 'Deleted'),
							danger: true
						} satisfies Entry
					]
				: [])
		];
	});
	const groups = $derived(
		(
			[
				['bulk', msg(bolt, 'view.group.bulk', 'Bulk')],
				['import', msg(bolt, 'view.group.import', 'Import & export')],
				['general', msg(bolt, 'view.group.general', 'General')]
			] as const
		)
			.map(([g, title]) => ({ g, title, of: entries.filter((e) => e.group === g) }))
			.filter((x) => x.of.length > 0)
	);
	const menu = $derived(entries.length > 0);

	let searchOpen = $state(false),
		menuOpen = $state(false);
	// the icon reads as on while a search holds the view
	const searching = $derived(text !== '' || index !== null);
	let picker = $state<HTMLInputElement>();
	let form = $state<string | null>(null);
	watch(
		() => JSON.stringify([collection, picked]),
		() => {
			form = null;
			editValues = {};
			editLinks = {};
		}
	);
	let runs = $state<{ automation: string; id: string }[]>([]);
	// each row's state, as a query's is: running, done (briefly), or failed with its message until it runs again
	type Status =
		| { state: 'pending' }
		| { state: 'done' }
		| { state: 'review' }
		| { state: 'failed'; message: string };
	let status = $state<{ [key: string]: Status }>({});
	const mark = (key: string, s: Status) => {
		status = { ...status, [key]: s };
		if (s.state === 'done')
			if (fibers !== null)
				fork(
					FiberSet.run(
						fibers,
						Effect.sleep('2500 millis').pipe(
							Effect.andThen(
								Effect.sync(() => {
									if (status[key] === s)
										status = Object.fromEntries(
											Object.entries(status).filter(([name]) => name !== key)
										);
								})
							)
						)
					)
				);
	};
	const ok = (o: Outcome) => o.kind === 'committed' || o.kind === 'pendingApproval';
	const isOutcome = (v: unknown): v is Outcome =>
		typeof v === 'object' &&
		v !== null &&
		'kind' in v &&
		['committed', 'pendingApproval', 'refused', 'conflict', 'unknown'].includes(String(v.kind));
	const isRun = (value: unknown): value is RunHandle =>
		Effect.isEffect(value) &&
		'id' in value &&
		typeof value.id === 'string' &&
		'automation' in value &&
		typeof value.automation === 'string' &&
		'ids' in value &&
		Array.isArray(value.ids);
	const say = (outcome: Outcome, saved?: string) => {
		notify(bolt, outcome, saved);
		if (outcome.kind === 'committed')
			for (const file of filesOf(outcome.output))
				window.open(bolt.fileUrl(file), '_blank', 'noopener');
		if (ok(outcome)) onSettled?.();
	};
	const track = (handle: RunHandle) =>
		Effect.suspend(() => {
			runs = [...runs, ...handle.ids.map((id) => ({ automation: handle.automation, id }))];
			menuOpen = false;
			return handle.pipe(Effect.map((outcome) => (ok(outcome) ? undefined : outcome)));
		});
	class ToolbarActionFailed extends Schema.TaggedError<ToolbarActionFailed>()(
		'ToolbarActionFailed',
		{ message: Schema.String, cause: Schema.Unknown }
	) {}
	let fibers: FiberSet.FiberSet<void, never> | null = null;
	const lifetime = attach(() =>
		Effect.gen(function* () {
			const owned = yield* FiberSet.make<void, never>();
			fibers = owned;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					if (fibers === owned) fibers = null;
				})
			);
			yield* Effect.never;
		})
	);
	/** Every menu action is a native Effect owned by this toolbar's mounted element. */
	const errorTag = (error: Error): string | undefined =>
		'_tag' in error && typeof error._tag === 'string' ? error._tag : undefined;
	function perform<A, E extends Error>(
		key: string,
		action: () => Effect.Effect<A, E> | void,
		saved?: string
	): void {
		if (status[key]?.state === 'pending' || fibers === null) return;
		const owned = fibers;
		const work = Effect.try({
			try: action,
			catch: (cause) =>
				new ToolbarActionFailed({
					cause,
					message: cause instanceof Error ? cause.message : String(cause)
				})
		}).pipe(
			Effect.flatMap((output) => {
				if (output === undefined) {
					menuOpen = false;
					return Effect.void;
				}
				mark(key, { state: 'pending' });
				const finish = (value: unknown) =>
					Effect.sync(() => {
						if (isOutcome(value)) {
							say(value, saved);
							if (!ok(value)) {
								mark(key, { state: 'failed', message: outcomeText(bolt, value) });
								return;
							}
						}
						mark(key, { state: 'done' });
					});
				return isRun(output)
					? track(output).pipe(Effect.tap(finish), Effect.asVoid)
					: output.pipe(Effect.tap(finish), Effect.asVoid);
			}),
			Effect.catch((error) =>
				Effect.sync(() => {
					const tag = errorTag(error);
					const message =
						tag === 'ActConflict'
							? outcomeText(bolt, { kind: 'conflict' })
							: tag === 'ActUnknown'
								? outcomeText(bolt, { kind: 'unknown' })
								: bolt.t(error.message);
					toast.error(message);
					mark(key, { state: 'failed', message });
				})
			)
		);
		fork(FiberSet.run(owned, work));
	}

	// ── the import: the file is uploaded to `<c>.$import` (the member's own), then the run reads it back as the import's input.
	// Its run is watched to its end: pending, done with its counts, its findings to review (warnings to accept), or its error.
	type Finding = {
		row: number | null;
		column: string;
		message: string;
		severity: 'warn' | 'refuse';
	};
	let imported = $state<{ id: string; file: string } | null>(null);
	const importRun = live(() =>
		imported === null || bolt.runs === undefined
			? null
			: bolt.runs(`${collection}.pipeline`, { where: { id: { eq: imported.id } }, limit: 1 })
	);
	const importRow = $derived(
		imported === null ? undefined : importRun.value?.rows.find((r) => r.id === imported?.id)
	);
	const importOut = $derived(
		importRow?.status === 'succeeded' && isRow(importRow.result) ? importRow.result : null
	);
	const findings = $derived(
		(Array.isArray(importOut?.['findings']) ? importOut['findings'] : []).flatMap((f): Finding[] =>
			typeof f === 'object' && f !== null && !Array.isArray(f)
				? [
						{
							row: typeof f['row'] === 'number' ? f['row'] : null,
							column: String(f['column'] ?? ''),
							message: String(f['message'] ?? ''),
							severity: f['severity'] === 'warn' ? 'warn' : 'refuse'
						}
					]
				: []
		)
	);
	const blocked = $derived(findings.some((f) => f.severity === 'refuse'));
	const importStatus = $derived.by((): Status | undefined => {
		if (imported === null) return undefined;
		const r = importRow;
		if (r === undefined || !['succeeded', 'failed', 'stopped', 'skipped'].includes(r.status))
			return { state: 'pending' };
		if (r.status !== 'succeeded')
			return {
				state: 'failed',
				message: r.error?.message ?? r.error?.code ?? msg(bolt, `run.status.${r.status}`, r.status)
			};
		if (importOut?.['applied'] === false)
			return blocked
				? {
						state: 'failed',
						message: msg(
							bolt,
							'view.importRefused',
							'Nothing was imported: fix the rows below and upload the file again.'
						)
					}
				: { state: 'review' };
		return { state: 'done' };
	});
	const pending = $derived(
		Object.values(status).some((s) => s.state === 'pending') || importStatus?.state === 'pending'
	);
	const counts = $derived(
		importOut?.['applied'] === true
			? msg(bolt, 'view.imported', '{created} created, {updated} updated, {deleted} deleted', {
					created: Number(importOut['created'] ?? 0),
					updated: Number(importOut['updated'] ?? 0),
					deleted: Number(importOut['deleted'] ?? 0)
				})
			: ''
	);
	// the run ends while the menu is closed: say so, and open the menu on findings to review
	watch(
		() => importStatus?.state,
		(now, before) => {
			if (now === undefined || now === 'pending' || now === before) return;
			if (now === 'done') toast.success(counts);
			else if (now === 'failed' && importStatus?.state === 'failed') {
				toast.error(importStatus.message);
				menuOpen = true;
			} else if (now === 'review') menuOpen = true;
		}
	);
	const scoped = (): { readonly [k: string]: Json } =>
		cfg?.context === undefined ? {} : { context: cfg.context };
	function startImport(file: string, accept: boolean) {
		const h = bolt.start(`${collection}.pipeline`, {
			mode: 'import',
			file,
			...(accept ? { accept } : {}),
			...scoped()
		});
		if (bolt.runs === undefined) return track(h); // no run reads here: RunStatus says so
		return h.pipe(
			Effect.map((outcome) => {
				if (!ok(outcome)) return outcome;
				imported = { id: h.id, file };
				return undefined;
			})
		);
	}
	function importFile(file: File | undefined) {
		const upload = kinds.upload;
		if (file === undefined || upload === undefined) return;
		imported = null;
		perform('import', () =>
			upload(file, `${collection}.$import`).pipe(
				Effect.flatMap((ref) => startImport(ref.id, false)),
				Effect.ensuring(
					Effect.sync(() => {
						if (picker) picker.value = '';
					})
				)
			)
		);
	}

	const accept = (file: string) => perform('import', () => startImport(file, true));
	const remove = () =>
		confirm(msg(bolt, 'table.confirmDelete', 'Delete {n} rows?', { n: picked.length }))
			? bolt.act(`${collection}.delete`, { target: [...picked] })
			: undefined;
	function updateSelected() {
		if (!editReady) return;
		const target = [...picked],
			set = editSet;
		perform('update', () =>
			bolt.act(`${collection}.update`, { target, set }).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						if (ok(outcome)) {
							form = null;
							editValues = {};
							editLinks = {};
							menuOpen = false;
						}
					})
				)
			)
		);
	}
	// a download the browser builds (§3.6): the rows in view, the view's columns; enums in their words, dates as ISO text,
	// behind a BOM so Excel reads UTF-8 (Chinese included)
	function exportCsv() {
		return Effect.gen(function* () {
			if (exporter === undefined) return;
			const rows = unref(
				kinds.catalog,
				collection,
				exporter.fields,
				objectsOf(yield* exporter.read()),
				bolt.locale,
				true
			);
			const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
			const kindOf = (f: string) =>
				exporter.kinds?.[f] ?? (kinds.catalog?.[collection] ?? catalog[source])?.fields[f];
			const words = (f: string) => (v: string) =>
				enumText(v, { t: (k) => bolt.t(k), collection, field: f });
			const text =
				CSV_BOM +
				[
					exporter.labels,
					...rows.map((r) =>
						exporter.fields.map((f) => csvCell(r, f, kindOf(f), words(f), bolt.locale))
					)
				]
					.map((line) => line.map(cell).join(','))
					.join('\r\n');
			downloadTextFiles([{ name: `${collection || 'rows'}.csv`, content: text }]);
		});
	}
	const named = recordLabels(bolt, () => kinds.catalog ?? catalog);
	/** The catalogue's words for an operator on a path (the fallback is the machine operator). */
	const opWords = (op: string, path: string) =>
		view?.offers.find((o) => o.op === op && pathOf(o.path).endsWith(path))?.opLabel ?? op;
	const chips = $derived(
		view === undefined
			? []
			: view.rows.map((n, i) => ({
					i,
					text: nodeText(catalog, source, n, humanize, named, opWords)
				}))
	);
</script>

<span hidden {@attach lifetime}></span>
{#snippet menuRow(e: Entry)}
	{@const st =
		e.key === 'import' && importStatus !== undefined && status['import']?.state !== 'failed'
			? importStatus
			: status[e.key]}
	{@const open = e.form !== undefined && form === e.form.callable}
	<!-- one row: the icon in its tile, the name over its description (or why it cannot run, or its error), its button -->
	<div
		class="flex min-w-0 items-center gap-3 rounded-md px-2 py-2"
		data-menu-item={e.key}
		data-status={st?.state}
	>
		<span
			class="bg-muted grid size-8 shrink-0 place-items-center rounded-md {e.danger
				? 'text-destructive'
				: 'text-muted-foreground'}"
		>
			{#if e.icon}<Icon name={e.icon} class="size-4" />{:else}<Glyph
					name={e.glyph}
					class="size-4"
				/>{/if}
		</span>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-sm font-medium {e.danger ? 'text-destructive' : ''}"
				>{e.text}</span
			>
			{#if st?.state === 'failed'}<span
					role="alert"
					class="text-destructive block text-xs"
					data-menu-error>{st.message}</span
				>
			{:else if e.key === 'import' && st?.state === 'review'}<span
					class="text-warning-foreground dark:text-warning block text-xs"
					data-menu-review
					>{msg(bolt, 'view.importReview', 'Review {n} warnings before importing', {
						n: findings.length
					})}</span
				>
			{:else if e.key === 'import' && st?.state === 'done' && counts !== ''}<span
					class="text-muted-foreground block text-xs">{counts}</span
				>
			{:else if e.why ?? e.hint}<span class="text-muted-foreground block text-xs"
					>{e.why ?? e.hint}</span
				>{/if}
		</span>
		<Button
			size="sm"
			variant={e.danger ? 'destructive' : open ? 'secondary' : 'outline'}
			class="shrink-0 px-2.5"
			aria-label={e.text}
			aria-expanded={e.form === undefined ? undefined : open}
			aria-busy={st?.state === 'pending'}
			disabled={e.why !== null || st?.state === 'pending'}
			title={e.why ?? undefined}
			onclick={() => (e.form === undefined ? perform(e.key, e.act, e.saved) : e.act())}
		>
			{#if st?.state === 'pending'}<Spinner
					class="size-3.5"
					label={msg(bolt, 'view.running', 'Running')}
				/>
			{:else if st?.state === 'done'}<Glyph name="check" class="size-3.5" />{/if}
			{st?.state === 'done' ? msg(bolt, 'view.done', 'Done') : e.button}
		</Button>
	</div>
	{#if e.key === 'import' && imported !== null && findings.length > 0 && (st?.state === 'review' || st?.state === 'failed')}
		<!-- the import's findings: each sheet row's problem; with only warnings, accepting re-submits the same file -->
		<div class="border-border mx-2 mb-1 grid gap-2 rounded-md border p-2" data-import-findings>
			<ul class="grid max-h-48 gap-1 overflow-y-auto text-xs">
				{#each findings as f, i (i)}
					{@const at = [
						f.row === null ? '' : msg(bolt, 'view.row', 'Row {row}', { row: f.row }),
						f.column
					]
						.filter((x) => x !== '')
						.join(' · ')}
					<li class="flex items-start gap-1.5" data-finding={f.severity}>
						<Glyph
							name="alert"
							class="mt-px size-3.5 shrink-0 {f.severity === 'refuse'
								? 'text-destructive'
								: 'text-warning-foreground dark:text-warning'}"
						/>
						<span class="min-w-0"
							>{#if at !== ''}<span class="font-medium">{at}:</span>{' '}{/if}{f.message}</span
						>
					</li>
				{/each}
			</ul>
			{#if !blocked}
				<Button
					size="sm"
					class="justify-self-end"
					onclick={() => accept(imported?.file ?? '')}
					data-import-accept>{msg(bolt, 'view.acceptImport', 'Accept and import')}</Button
				>
			{/if}
		</div>
	{/if}
{/snippet}

{#if cfg !== null}
	<div class="@container flex min-w-0 flex-col gap-1.5" data-view-toolbar>
		{#if canImport}<input
				bind:this={picker}
				type="file"
				accept=".json,.xlsx,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				class="hidden"
				data-view-import
				onchange={(e) => importFile(e.currentTarget.files?.[0])}
			/>{/if}
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			{#if title}<h2 class="min-w-0 truncate text-sm font-semibold" data-view-title>
					{title}
				</h2>{/if}
			{#if about}
				<!-- a popover, not a hover tooltip: a tap on a phone opens it too -->
				<Popover.Root>
					<Popover.Trigger
						class="text-muted-foreground hover:bg-accent hover:text-foreground grid size-9 max-sm:size-11 shrink-0 place-items-center rounded-sm"
						aria-label={msg(bolt, 'view.about', 'About {what}', {
							what: title || label(bolt, collection)
						})}
						title={about}
						data-view-about><Glyph name="info" /></Popover.Trigger
					>
					<Popover.Content
						align="start"
						class="w-[min(22rem,calc(100vw-1rem))] p-3 text-sm leading-relaxed"
						data-view-description>{about}</Popover.Content
					>
				</Popover.Root>
			{/if}
			<!-- the owner's toolbar: title, ⓘ and every widget flush left; New alone pushed right (and to the end of a wrapped row) -->
			{#if cfg.controls}<div class="flex min-w-0 flex-wrap items-center gap-1" data-view-controls>
					{@render cfg.controls()}
				</div>{/if}
			{#if canSearch}
				<!-- the search is an icon: its popover opens with the box focused, and says what it searches and which
				     `/` commands the collection offers -->
				<Popover.Root bind:open={searchOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								size="icon"
								variant="ghost"
								class={searching ? 'bg-accent' : ''}
								hint={searchHint}
								aria-label={searchHint}
								data-search-toggle
							>
								<Glyph name="search" />
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						align="start"
						class="flex {chosen?.input === undefined
							? 'w-[min(26rem,calc(100vw-1rem))]'
							: 'w-[min(36rem,calc(100vw-1rem))]'} flex-col gap-2 p-2"
						data-search-panel
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							box?.focus();
						}}
					>
						<div
							class="border-input bg-background focus-within:ring-ring/50 flex min-h-8 flex-wrap items-center gap-1 rounded-sm border px-2 shadow-xs focus-within:ring-[3px]"
						>
							<Glyph name="search" class="text-muted-foreground size-4 shrink-0" />
							{#if index !== null}
								<span
									class="bg-accent inline-flex h-6 shrink-0 items-center gap-1 rounded-full pr-1 pl-2 text-xs"
									title={chosen?.hint}
									data-search-index={index}
								>
									/{index}<button
										type="button"
										class="hover:bg-background grid size-4 place-items-center rounded-full"
										aria-label={t('searchClear')}
										onclick={clear}><Glyph name="x" class="size-3" /></button
									>
								</span>
							{/if}
							{#if chosen?.input !== undefined}
								<!-- a typed similarity: its input fields' own editors under the chip, two to a row (a custom editor takes
								     the row), run on submit through the view's similar read -->
								<form
									class="grid basis-full grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-2 pt-1 pb-2"
									data-similar-input={index}
									onsubmit={(e) => {
										e.preventDefault();
										if (ready)
											onProbe?.({
												name: index ?? '',
												via: chosen?.via ?? 'similar',
												input: encodeWire(values)
											});
									}}
								>
									{#each Object.entries(chosen.input) as [f, k] (f)}
										<div
											class="grid min-w-0 gap-1 text-xs {k.kind === 'custom'
												? 'col-span-full'
												: ''}"
											data-similar-field={f}
										>
											<span class="text-muted-foreground">{k.label ?? humanize(f)}</span>
											<Editor
												kind={k}
												value={values[f] ?? null}
												onChange={(v) => (values = { ...values, [f]: v })}
												name={f}
											/>
										</div>
									{/each}
									<Button
										type="submit"
										size="sm"
										class="col-span-full justify-self-end"
										disabled={!ready}
										data-similar-run><Glyph name="search" />{t('searchRun')}</Button
									>
								</form>
							{:else}
								<input
									bind:this={box}
									class="h-8 min-w-0 flex-1 bg-transparent text-base outline-none @xl:text-sm"
									type="search"
									placeholder={index === 'semantic'
										? t('searchMeaning')
										: lexical
											? `${searchHint}${indexes.length > 0 ? ` · ${t('searchCommands')}` : ''}`
											: t('searchPick')}
									aria-label={searchHint}
									value={text}
									oninput={(e) => typing(e.currentTarget.value)}
									onkeydown={(e) => {
										if (e.key === 'Enter' && !picking) searchOpen = false;
										else key(e);
									}}
									data-search
								/>
							{/if}
						</div>
						{#if picking}
							<div class="grid min-w-0 gap-0.5" role="listbox" data-search-indexes>
								{#if menuOf.length === 0}<p
										class="text-muted-foreground px-2 py-1.5 text-sm"
										data-search-none
									>
										{indexes.length === 0 ? t('searchNone') : t('noResults')}
									</p>{/if}
								{#each menuOf as i (i.name)}
									<button
										type="button"
										role="option"
										aria-selected="false"
										class="hover:bg-accent min-w-0 rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
										disabled={i.why !== null}
										title={i.why ?? i.hint}
										onclick={() => pick(i)}
										data-search-option={i.name}
									>
										<span class="block font-medium">/{i.name}</span><span
											class="text-muted-foreground block truncate text-xs">{i.why ?? i.hint}</span
										>
									</button>
								{/each}
							</div>
						{:else if index === null && text === ''}
							<!-- what this box searches, and the commands `/` offers -->
							<div
								class="text-muted-foreground grid min-w-0 gap-1.5 px-1 pb-1 text-xs"
								data-search-help
							>
								{#if lexical && fieldsSearched.length > 0}
									<p data-search-fields>
										{t('searchFields').replace('{fields}', fieldsSearched.join(', '))}
									</p>
								{/if}
								{#if indexes.length > 0}
									<p class="font-medium">{t('searchCommands')}</p>
									{#each indexes as i (i.name)}
										<button
											type="button"
											class="hover:bg-accent hover:text-foreground -mx-1 flex min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
											disabled={i.why !== null}
											title={i.why ?? i.hint}
											onclick={() => pick(i)}
											data-search-command={i.name}
										>
											<span class="text-foreground shrink-0 font-mono">/{i.name}</span><span
												class="min-w-0 flex-1 truncate">{i.why ?? i.hint}</span
											>
										</button>
									{/each}
								{/if}
							</div>
						{/if}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if canFilter && view !== undefined}<ViewPopover
					{view}
					{catalog}
					collection={source}
					{author}
					{sortable}
				/>{/if}
			{#if menu}
				<Popover.Root bind:open={menuOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								size="icon"
								variant="ghost"
								hint={msg(bolt, 'view.actions', 'Actions')}
								aria-label={msg(bolt, 'view.actions', 'Actions')}
								aria-busy={pending}
								data-view-actions
							>
								{#if pending}<Spinner label={msg(bolt, 'view.running', 'Running')} />{:else}<Glyph
										name="zap"
									/>{/if}
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						align="start"
						class="flex max-h-[min(70dvh,36rem)] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-y-auto p-1.5"
						data-view-menu
					>
						{#each groups as grp, gi (grp.g)}
							<p
								class={[
									'text-overline text-muted-foreground px-2 pb-1',
									gi === 0 ? 'pt-1' : 'mt-1 border-t pt-2'
								]}
								data-menu-group={grp.g}
							>
								{grp.title}
							</p>
							{#each grp.of as e (e.key)}
								{@render menuRow(e)}
								{#if e.form !== undefined && form === e.form.callable}
									<div class="border-border mx-1 mb-1 rounded-md border p-2">
										{#if e.form.target === 'selection'}
											<form
												class="grid gap-3"
												data-bulk-update
												onsubmit={(event) => {
													event.preventDefault();
													if (event.currentTarget.querySelector('[aria-invalid="true"]') === null)
														updateSelected();
												}}
											>
												<p class="text-meta" data-bulk-update-count>
													{msg(bolt, 'table.selected', '{n} selected', { n: picked.length })}.
													{msg(bolt, 'view.editOnlyChosen', 'Only checked fields will change.')}
												</p>
												{#each editFields as field (field.name)}
													{@const chosen = Object.hasOwn(editValues, field.name)}
													<div class="grid min-w-0 gap-1.5" data-bulk-update-field={field.name}>
														<div
															class="flex min-h-11 items-center gap-2 text-sm font-medium @xl:min-h-8"
														>
															<Checkbox
																id={`${editorId}-${field.name}-choose`}
																checked={chosen}
																disabled={status['update']?.state === 'pending'}
																onCheckedChange={(checked) => chooseEdit(field, checked)}
																data-bulk-update-choose={field.name}
															/>
															<label
																class="flex min-h-11 flex-1 items-center @xl:min-h-8"
																for={`${editorId}-${field.name}-choose`}
																id={`${editorId}-${field.name}-label`}
															>
																{field.kind.label ??
																	pathLabel(catalog, collection, field.name, humanize)}
															</label>
														</div>
														{#if chosen}
															<label class="sr-only" for={`${editorId}-${field.name}`}
																>{field.kind.label ??
																	pathLabel(catalog, collection, field.name, humanize)}</label
															>
															<Editor
																kind={field.kind}
																value={editValues[field.name] ?? null}
																onChange={(value) =>
																	(editValues = { ...editValues, [field.name]: value })}
																name={field.name}
																id={`${editorId}-${field.name}`}
																labelledby={`${editorId}-${field.name}-label`}
																row={editSet}
																relation={field.relation}
																errors={editProblems}
																disabled={status['update']?.state === 'pending'}
															/>
															{#if field.kind.optional}
																<Button
																	type="button"
																	size="sm"
																	variant="ghost"
																	class="justify-self-start"
																	disabled={status['update']?.state === 'pending'}
																	onclick={() =>
																		(editValues = { ...editValues, [field.name]: null })}
																>
																	{msg(bolt, 'view.clearValue', 'Clear value')}
																</Button>
															{/if}
															{#if editProblems.get(field.name)}
																<p role="alert" class="text-destructive text-xs">
																	{bolt.t(editProblems.get(field.name) ?? '')}
																</p>
															{/if}
														{/if}
													</div>
												{/each}
												{#each editRelations as { name, child } (name)}
													{@const chosen = Object.hasOwn(editLinks, name)}
													<div class="grid min-w-0 gap-1.5" data-bulk-update-field={name}>
														<div
															class="flex min-h-11 items-center gap-2 text-sm font-medium @xl:min-h-8"
														>
															<Checkbox
																id={`${editorId}-${name}-choose`}
																checked={chosen}
																disabled={status['update']?.state === 'pending'}
																onCheckedChange={(checked) => chooseLinks(name, checked)}
																data-bulk-update-choose={name}
															/>
															<label
																class="flex min-h-11 flex-1 items-center @xl:min-h-8"
																for={`${editorId}-${name}-choose`}
															>
																{pathLabel(catalog, collection, name, humanize)}
															</label>
														</div>
														{#if chosen}
															<BulkRelation
																{name}
																{child}
																parentId={editParent}
																value={editLinks[name] ?? NO_LINKS}
																onChange={(next) => (editLinks = { ...editLinks, [name]: next })}
																id={`${editorId}-${name}`}
																errors={editProblems}
																disabled={status['update']?.state === 'pending'}
															/>
														{/if}
													</div>
												{/each}
												<Button
													type="submit"
													size="sm"
													class="justify-self-end"
													disabled={!editReady || status['update']?.state === 'pending'}
													aria-busy={status['update']?.state === 'pending'}
													data-bulk-update-submit
												>
													{#if status['update']?.state === 'pending'}<Spinner
															label={msg(bolt, 'view.running', 'Running')}
														/>{/if}
													{msg(bolt, 'view.applySelected', 'Apply to {n} selected', {
														n: picked.length
													})}
												</Button>
											</form>
										{:else}
											<FormView
												of={{ action: e.form.callable }}
												{...e.form.target === 'record' ? { id: picked[0] } : {}}
												onOutcome={(o) => {
													say(o);
													if (o.kind === 'committed') {
														form = null;
														menuOpen = false;
													}
												}}
											/>
										{/if}
									</div>
								{/if}
							{/each}
						{/each}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if canNew}
				<Button
					size="default"
					class="ml-auto px-2.5 @xl:px-3"
					aria-label={msg(bolt, 'table.new', 'New')}
					data-view-new
					onclick={create}
				>
					<Glyph name="plus" /><span class="hidden @xl:inline"
						>{onAdd ? msg(bolt, 'table.add', 'Add row') : msg(bolt, 'table.new', 'New')}</span
					>
				</Button>
			{/if}
		</div>
		{#if chips.length > 0 || (view?.order.length ?? 0) > 0}
			<div class="flex flex-wrap items-center gap-1 text-xs" data-view-chips>
				{#each chips as c (c.i)}
					<span
						class="bg-muted/60 inline-flex h-6 max-w-full items-center gap-1 rounded-full border pr-1 pl-2"
						data-filter-chip
					>
						<span class="truncate">{c.text}</span>
						<button
							type="button"
							class="hover:bg-accent grid size-4 place-items-center rounded-full"
							aria-label={msg(bolt, 'view.removeFilter', 'Remove filter')}
							onclick={() => view?.setRows(view.rows.filter((_, j) => j !== c.i))}
							><Glyph name="x" class="size-3" /></button
						>
					</span>
				{/each}
				{#each view?.order ?? [] as k, i (k.field)}
					<span
						class="bg-muted/60 inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2"
						data-sort-chip
					>
						<span
							>{k.near === undefined
								? `${pathLabel(catalog, source, k.field, humanize)} ${k.dir === 'asc' ? '↑' : '↓'}`
								: sortText(catalog, source, k, humanize)}</span
						>
						<button
							type="button"
							class="hover:bg-accent grid size-4 place-items-center rounded-full"
							aria-label={msg(bolt, 'view.removeSort', 'Remove sort')}
							onclick={() => view?.setOrder(view.order.filter((_, j) => j !== i))}
							><Glyph name="x" class="size-3" /></button
						>
					</span>
				{/each}
			</div>
		{/if}
		{#if view?.notice}<p role="status" class="text-muted-foreground text-xs" data-view-notice>
				{view.notice}
			</p>{/if}
		{#each runs as r (r.id)}<RunStatus automation={r.automation} run={r.id} />{/each}
	</div>
{/if}
