<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import type { Json } from '../client/contract.js';
	import type { Row, Values } from './types.js';
	import type { Fields, Value } from '../kinds/kind.js';
	import type { ModelExposure, ParserExposure } from '../kinds/context.js';
	import { formSpec } from '../form/draft.js';
	import { presentation } from '../kinds/registry.js';
	import { edgesFrom } from '../kinds/kind.js';
	/**
	 * The fields "Edit selected" offers: the caller's update columns, each edited by its kind's editor. A state is edited
	 * as the states some edge moves into (the host judges each row's move); other derived kinds are never written.
	 */
	export const editableFields = (exposure: ModelExposure | undefined) =>
		(formSpec('', exposure, 'update')?.fields ?? []).flatMap((field) => {
			const kind = field.kind;
			if (field.readonly || kind.hidden) return [];
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
	export const editableRelations = (exposure: ModelExposure | undefined) =>
		Object.entries(exposure?.update?.with ?? {}).flatMap(([name, child]) =>
			child.create === undefined && !child.link && !child.unlink && !child.delete
				? []
				: [{ name, child }]
		);

	type IdIn<R> = R extends { readonly id: infer I extends string } ? I : string;
	/**
	 * An author's actions-menu item: an icon, a name, a line of description and the handler itself. The menu owns
	 * the rest: a promise the handler returns is the item's pending state, a rejection or a refused outcome its error (in
	 * place and as a toast), an `Outcome` (`ctx.act`) is toasted, and a run handle (`ctx.run`) shows its run under the
	 * toolbar. A handler that returns nothing closes the menu (it opened a sheet or a file picker of its own).
	 */
	export type ToolbarItem<R = Row> = {
		/** An Iconify id (`lucide:upload`). */
		icon: string;
		name: string;
		/** One line under the name. */
		description?: string;
		run: (selected: IdIn<R>[]) => Effect.Effect<unknown, Error> | void;
		/** Turns row selection on; the item is disabled until records are selected. */
		requires_selection?: true;
		/** Why the item cannot run now (over this selection), or null when it can; shown instead of `description`. */
		disabled?: (selected: IdIn<R>[]) => string | null;
	};
	/**
	 * A view's whole chrome, one shape on `Table`, `Board` and `Map`. Every key defaults from the model's
	 * declaration and the viewer's grants; `toolbar={false}` renders none. A model with a declared file sync gets
	 * Import, Export and Template automatically (the sync's parsers and `context`); do not wire file buttons again.
	 */
	export type Toolbar<R = Row> =
		| false
		| {
				/** Default: the model's label. */
				title?: string | false;
				/** A form group's semantic error: marks its title and replaces its info text until corrected. */
				error?: string;
				/** Behind the info icon. Default: the model's declared description, else its model's. */
				description?: string | false;
				/** Default on where the model declares search fields. */
				search?: boolean;
				/** The filter-and-sort popover. Default on. */
				filter?: boolean;
				/** Author items in the actions menu, in a group of their own; `false` hides the menu. */
				actions?: readonly ToolbarItem<R>[] | false;
				/** "Export CSV" of the rows in view. Default on; replaced by "Export" when the model's file sync exports. */
				export?: boolean;
				/** "Delete selected records" when the model declares delete and the viewer may delete (turns selection on). Default on. */
				delete?: boolean;
				/** Record checkboxes (`Table` and `Board`). Default: on for permitted bulk edits, deletes or selection actions. */
				select?: boolean;
				/** The New button: the record sheet in create mode, or the author's own (a prefilled create). Default: the viewer may create. */
				new?: boolean | (() => void);
				/** A view-local control (a grouping, a lane toggle), placed before search. The page scope (entity, period) is AppShell's `actions`; never actions. */
				controls?: Snippet;
				/** Compact task controls at the right edge, before New. */
				trailing?: Snippet;
				/**
				 * What the view is scoped to (`{ company_id, period }`), handed to the model's file syncs: the import, its
				 * template and the export decode it against the sync's `context` fields. It narrows and defaults; it never authorizes.
				 */
				context?: { readonly [field: string]: Json };
		  };
	/** Selection follows the same actionable catalogue and explicit opt-outs in every record view. */
	export function selectionEnabled<R>(
		config: Toolbar<R> | undefined,
		exposure: ModelExposure | undefined
	): boolean {
		if (config === false || config?.actions === false || config?.select === false) return false;
		return (
			config?.select === true ||
			(config?.delete !== false && exposure?.delete === true) ||
			editableFields(exposure).length > 0 ||
			editableRelations(exposure).length > 0 ||
			(config?.actions ?? []).some(
				(item) => item.requires_selection || typeof item.disabled === 'function'
			)
		);
	}
	const ACCEPT: { readonly [parser: string]: readonly string[] } = {
		xlsx: ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
		csv: ['.csv', 'text/csv'],
		tsv: ['.tsv', 'text/tab-separated-values'],
		json: ['.json', 'application/json'],
		ics: ['.ics', 'text/calendar'],
		txt: ['.txt', 'text/plain']
	};
	/** A file sync's picker `accept`: exactly its parsers' extensions and media types (default `xlsx`, `csv`). */
	export const acceptOf = (parser: readonly ParserExposure[] = ['xlsx', 'csv']): string =>
		parser
			.flatMap((p) => (typeof p === 'string' ? (ACCEPT[p] ?? []) : [p.type, ...p.extensions]))
			.join(',');
	type Exporter = {
		fields: readonly string[];
		labels: readonly string[];
		kinds?: Fields;
		read: () => Effect.Effect<readonly Values[], Error>;
	};
</script>

<script lang="ts" generics="R extends object = Row">
	import { FiberSet, Predicate, Schema } from 'effect';
	import { encode_wire } from '@norbital-ai/std/wire';
	import { fork, attach } from '../effect/index.js';
	import { by_id, first_of, page_of, request_json } from '../read/request.js';
	import { Button } from '../primitives/button/index.js';
	import { confirm_action } from '../primitives/dialog/confirm.js';
	import Checkbox from '../primitives/checkbox/checkbox.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import BulkRelation, { childFields, NO_LINKS, type Links } from './BulkRelation.svelte';
	import { getAllContexts, tick, untrack, onDestroy } from 'svelte';
	import Editor from '../kinds/editor.svelte';
	import { enum_text, initial, likeWhere, problems } from '../kinds/kind.js';
	import { cn, ui_text, stepActive } from '../primitives/utils.js';
	import { offerContexts, open_record } from '../record/navigation.js';
	import { bolt_of } from '../client/context.js';
	import { type Outcome, type ProtocolFailure, type RunHandle } from '../client/contract.js';
	import { complete } from '../filter/node.js';
	import { nodeParts, pathLabel, sortText } from '../filter/text.js';
	import { pathOf } from '../filter/catalog.js';
	import { CSV_BOM, csvCell } from '../table/csv.js';
	import { filesOf } from '../cell/value.js';
	import { humanize, label, msg, catalogText } from '../text/messages.js';
	import { actOutcome, notify, outcomeText } from '../actions/outcome.js';
	import { searchIndexes, SLASH, type SearchIndex } from '../table/model.js';
	import { and } from '../filter/scope.js';
	import { unref } from '../relations/select.js';
	import type { ViewState } from '../filter/view-state.svelte.js';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import RunStatus from '../runs/RunStatus.svelte';
	import ViewPopover from '../filter/ViewPopover.svelte';
	import FilterSummary from '../filter/FilterSummary.svelte';
	import ToolbarSearch from './toolbar/ToolbarSearch.svelte';
	import { download_text_files } from '../utilities/download.js';
	import { toast } from '../toast/toast.svelte.js';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { record_labels } from '../record/labels.svelte.js';
	import { watch as live } from '../read/live.svelte.js';
	import { watch } from 'runed';

	let {
		ctx,
		config = {},
		model,
		view,
		catalog,
		source = model,
		author,
		hidden_author,
		sortable = [],
		q = $bindable(''),
		searchable = false,
		selected,
		on_settled,
		exporter,
		on_add,
		on_probe
	}: {
		ctx: UiContext;
		config?: Toolbar<R> | undefined;
		/** The model the defaults come from; `''` for a source without one. */
		model: string;
		view?: ViewState;
		catalog: { readonly [c: string]: ModelExposure };
		/** The view popover's model (a local array's `$local`). */
		source?: string;
		author?: Json;
		/** A fixed scope included in the view's rows but never shown in the view popover. */
		hidden_author?: Json;
		sortable?: readonly string[];
		q?: string;
		searchable?: boolean;
		/** The selected ids when the view selects rows (then a record action runs over one of them). */
		selected?: readonly IdIn<R>[] | undefined;
		/** After an act over the selection settles. */
		on_settled?: () => void;
		exporter?: Exporter;
		/** A local array's "Add row", in New's place. */
		on_add?: () => void;
		/** A search index's search (`/<index>` and its input, `/semantic` and its text), or `null` back to the box's text; absent: the view shows no ranked rows. */
		on_probe?: (probe: { index: string; input: Json } | null) => void;
	} = $props();
	const bolt = $derived(bolt_of(ctx));
	const kinds = $derived(ctx.ui.kinds);
	const cfg = $derived(config === false ? null : (config ?? {}));
	const x = $derived(catalog[model] ?? kinds.catalog?.[model]);
	const title = $derived(
		cfg?.title === false ? '' : (cfg?.title ?? (model === '' ? '' : label(bolt, model)))
	);
	const about = $derived(
		cfg?.error ?? (cfg?.description === false ? '' : (cfg?.description ?? x?.description ?? ''))
	);
	const offered = $derived(searchable && cfg?.search !== false);
	// `/` at the start of the box lists the model's search modes; the picked one is a chip. `semantic` keeps
	// the box as its text, searched on Enter; a search index swaps the box for its input's editors (custom datatypes in
	// their own renderers) and hands the view its probe. Backspace on an empty box (or the chip's ×) is back to the text search.
	const t = ui_text();
	// the model's declared search fields, else its label's text fields (the Table searches those by `like`)
	const lexicalFields = $derived(
		(x?.search?.length ?? 0) > 0
			? (x?.search ?? [])
			: (x?.label ?? []).filter((f) => likeWhere(x, [f], 'x') !== undefined)
	);
	// a local array (a custom view's rows) searches its own columns, even when it names the model its menu acts on
	const local = $derived(model === '' || source !== model);
	const lexical = $derived(local || lexicalFields.length > 0);
	const indexes = $derived(
		offered && !local
			? searchIndexes(x, on_probe !== undefined, {
					meaning: t('searchMeaning'),
					raw: t('searchRaw'),
					view: t('searchView')
				})
			: []
	);
	// the search icon exists only over something searchable: the model's search fields or a declared index
	const canSearch = $derived(offered && (lexical || indexes.length > 0));
	// a model's declared search fields; a local array searches the columns it shows (the roster's people)
	const fieldsSearched = $derived(
		local
			? Object.keys(catalog[source]?.fields ?? {}).map((f) =>
					pathLabel(catalog, source, f, humanize)
				)
			: // `$label` is the record's generated label, which its own fields already name
				lexicalFields
					.filter((s) => !s.startsWith('$'))
					.map((s) => pathLabel(catalog, model, s, humanize))
	);
	let index = $state<string | null>(null);
	let text = $state(untrack(() => q));
	let values = $state<Values>({});
	let searchActive = $state(0);
	let box = $state<HTMLInputElement>();
	const chosen = $derived(indexes.find((i) => i.name === index));
	// a `/…` with no index chosen is the picker's, never a search term: the rows stay unfiltered
	const picking = $derived(index === null && SLASH.test(text));
	const menuOf = $derived(picking ? indexes.filter((i) => i.name.startsWith(text.slice(1))) : []);
	const ready = $derived(
		chosen?.input !== undefined &&
			Object.entries(chosen.input).every(([f, k]) => problems(k, values[f] ?? null).size === 0)
	);
	// what the view reads: the text, or nothing while a search mode or the `/` list holds the box
	const send = () => (q = index === null && lexical && !SLASH.test(text) ? text : '');
	/** `/semantic`: the box's text, nearest in meaning, on Enter. */
	const meaning = () =>
		on_probe?.(text.trim() === '' ? null : { index: 'semantic', input: text.trim() });
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
		if (index !== null) on_probe?.(null);
		index = null;
		send();
	}
	function typing(value: string) {
		text = value;
		searchActive = Math.max(
			0,
			menuOf.findIndex((i) => i.why === null)
		);
		const named = index === null ? /^\/(\S+)\s$/.exec(value)?.[1] : undefined;
		const i = indexes.find((x) => x.name === named);
		if (i !== undefined && i.why === null) return void pick(i);
		send();
	}
	function key(e: KeyboardEvent) {
		if (e.key === 'Backspace' && index !== null && text === '') {
			e.preventDefault();
			clear();
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (menuOf.length === 0) return;
			e.preventDefault();
			searchActive = stepActive(
				menuOf.length,
				searchActive,
				e.key === 'ArrowDown' ? 1 : -1,
				(i) => menuOf[i]?.why === null
			);
		} else if (e.key === 'Enter' && menuOf.length > 0) {
			e.preventDefault();
			const target = menuOf[searchActive];
			if (target !== undefined && target.why === null) void pick(target);
		}
	}
	const canFilter = $derived(view !== undefined && cfg?.filter !== false);
	const canNew = $derived(
		cfg?.new !== false &&
			(on_add !== undefined ||
				typeof cfg?.new === 'function' ||
				(model !== '' && x?.create !== undefined))
	);
	// the page's contexts ride into the shell's sheet, which mounts outside the page (its create scope)
	const contexts = getAllContexts();
	// svelte-ignore state_referenced_locally
	onDestroy(model === '' ? () => {} : offerContexts(model, contexts));
	const create = () =>
		on_add
			? on_add()
			: typeof cfg?.new === 'function'
				? cfg.new()
				: open_record(model, 'new', contexts);
	const searchHint = $derived.by(() => {
		const f = fieldsSearched.slice(0, 3);
		return f.length === 0
			? msg(bolt, 'table.search')
			: msg(bolt, 'table.searchIn', { fields: f.join(', ') });
	});

	// ── the actions menu: the model's syncs (Sync now; Import, Download template, Export), export, delete-selected, the author's items ──
	const picked = $derived(selected ?? []);
	const items = $derived(cfg?.actions === false || cfg?.actions === undefined ? [] : cfg.actions);
	// native sync controls: a remote read's Sync now; a file sync's import
	// (its picker accepting exactly its parsers), template and export in each declared format
	const syncs = $derived(cfg?.actions === false ? [] : Object.entries(x?.syncs ?? {}));
	const remotes = $derived(
		syncs.flatMap(([name, s]) => (s.kind === 'remote' ? [{ name, with: s.with }] : []))
	);
	// a file sync whose required context the view does not supply (a page-driven export) is the page's to start
	const files = $derived(
		syncs.flatMap(([name, s]) =>
			s.kind === 'file' && (s.context ?? []).every((f) => cfg?.context?.[f] !== undefined)
				? [
						{
							name,
							accept: acceptOf(s.parser),
							import: s.import === true && kinds.upload !== undefined,
							export: s.export ?? []
						}
					]
				: []
		)
	);
	const canExport = $derived(
		cfg?.actions !== false &&
			cfg?.export !== false &&
			exporter !== undefined &&
			!files.some((f) => f.export.length > 0)
	);
	// two syncs of one kind are told apart by name
	const told = (text: string, name: string, of: readonly unknown[]) =>
		of.length > 1 ? `${text} · ${humanize(name)}` : text;
	const importKey = (sync: string) => `import:${sync}`;
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
	type Group = 'bulk' | 'actions' | 'import' | 'general';
	// Every menu row carries its words and handler; bulk update opens its native editor inline.
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
		form?: { callable: string };
		/** A file sync's import: its run's progress and findings show on this row. */
		sync?: string;
	};
	const entries = $derived.by((): Entry[] => {
		const ids = [...picked];
		const selectFirst = msg(bolt, 'view.selectRows');
		const run = msg(bolt, 'view.run');
		return [
			...items.map((item): Entry => ({
				key: `item:${item.name}`,
				group: 'actions',
				glyph: 'play',
				icon: item.icon,
				text: item.name,
				why:
					item.disabled?.(ids) ??
					(item.requires_selection && picked.length === 0 ? selectFirst : null),
				button: run,
				act: () => item.run([...picked]),
				...(item.description === undefined ? {} : { hint: item.description })
			})),
			...remotes.map((r): Entry => ({
				key: `sync:${r.name}`,
				group: 'import',
				glyph: 'sync',
				text: told(msg(bolt, 'view.sync'), r.name, remotes),
				hint: msg(bolt, 'view.syncFrom', {
					source: humanize(r.with)
				}),
				why: null,
				button: msg(bolt, 'view.syncButton'),
				act: () => bolt.sync_control(model, r.name, {})
			})),
			...files.flatMap((f): Entry[] => [
				...(f.import
					? [
							{
								key: importKey(f.name),
								group: 'import',
								glyph: 'upload',
								text: told(msg(bolt, 'view.import'), f.name, files),
								why: null,
								button: msg(bolt, 'view.upload'),
								act: () => void pickers[f.name]?.click(),
								sync: f.name
							} satisfies Entry,
							// the import's sheet: an export of what the page shows, a run whose file RunStatus links
							{
								key: `template:${f.name}`,
								group: 'import',
								glyph: 'download',
								text: told(msg(bolt, 'view.template'), f.name, files),
								hint: msg(bolt, 'view.templateHint'),
								why: null,
								button: msg(bolt, 'view.download'),
								act: () => bolt.sync_control(model, f.name, { mode: 'template', ...scoped() })
							} satisfies Entry
						]
					: []),
				...f.export.map((to): Entry => ({
					key: `export:${f.name}:${to}`,
					group: 'import',
					glyph: 'download',
					text: told(
						f.export.length > 1
							? msg(bolt, 'view.exportAs', { format: to.toUpperCase() })
							: msg(bolt, 'view.export'),
						f.name,
						files
					),
					hint: msg(bolt, 'view.exportHint'),
					why: null,
					button: msg(bolt, 'view.download'),
					act: () => {
						const where = shown();
						return bolt.sync_control(model, f.name, {
							mode: 'export',
							to,
							...scoped(),
							...(where === undefined ? {} : { where })
						});
					}
				}))
			]),
			...(canExport
				? [
						{
							key: 'export',
							group: 'import',
							glyph: 'download',
							text: msg(bolt, 'table.export'),
							hint: msg(bolt, 'view.exportHint'),
							why: null,
							button: msg(bolt, 'view.download'),
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
							text: msg(bolt, 'view.editSelected'),
							hint: msg(bolt, 'view.editSelectedHint'
							),
							why: picked.length === 0 ? selectFirst : null,
							button: msg(bolt, 'view.editButton'),
							act: () => {
								if (form === `${model}.update`) form = null;
								else {
									editValues = {};
									editLinks = {};
									form = `${model}.update`;
								}
							},
							form: { callable: `${model}.update` }
						} satisfies Entry
					]
				: []),
			...(canDelete
				? [
						{
							key: 'delete',
							group: 'bulk',
							glyph: 'trash',
							text: msg(bolt, 'table.delete'),
							why: picked.length === 0 ? selectFirst : null,
							button: msg(bolt, 'view.deleteButton'),
							act: remove,
							danger: true
						} satisfies Entry
					]
				: [])
		];
	});
	const groups = $derived(
		(
			[
				['bulk', msg(bolt, 'view.group.bulk')],
				['actions', msg(bolt, 'view.group.actions')],
				['import', msg(bolt, 'view.group.import')],
				['general', msg(bolt, 'view.group.general')]
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
	let pickers = $state<{ [sync: string]: HTMLInputElement | undefined }>({});
	let form = $state<string | null>(null);
	watch(
		() => JSON.stringify([model, picked]),
		() => {
			form = null;
			editValues = {};
			editLinks = {};
		}
	);
	let runs = $state<{ automation: string; id: string }[]>([]);
	// each row's state, as a query's is: running, done (briefly), or failed with its message until it runs again
	type Status = { state: 'pending' } | { state: 'done' } | { state: 'failed'; message: string };
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
	const ok = (o: Outcome) => o.kind === 'committed' || o.kind === 'pending_approval';
	const isOutcome = (v: unknown): v is Outcome =>
		typeof v === 'object' &&
		v !== null &&
		'kind' in v &&
		['committed', 'pending_approval', 'refused', 'conflict', 'unknown', 'running'].includes(
			String(v.kind)
		);
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
				window.open(bolt.file_url(file), '_blank', 'noopener');
		if (ok(outcome)) on_settled?.();
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
			Effect.flatMap((output): Effect.Effect<void, E | ProtocolFailure> => {
				if (output === undefined) {
					menuOpen = false;
					return Effect.void;
				}
				mark(key, { state: 'pending' });
				const finish = (value: unknown) =>
					Effect.sync(() => {
						if (isOutcome(value)) {
							say(value, saved);
							// a running act is not a failure: its toast says it goes on in the background
							if (!ok(value) && value.kind !== 'running') {
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

	// ── a file sync's import: the file is uploaded to `<c>.$import.<s>` (refused unless one of its parsers reads it), then the
	// run reads it back and imports it in one step. Its run is watched to its end: pending, done with its counts and any
	// warnings, or refused with its findings (nothing written). A finding's `at` is the record's sheet row or line; 0 is the file as a whole.
	type Finding = { at: number; field: string | null; message: string; severity: 'warn' | 'refuse' };
	let imported = $state<{ sync: string; id: string } | null>(null);
	const importRun = live(() =>
		imported === null || bolt.runs === undefined
			? null
			: bolt.runs(`${model}.sync.${imported.sync}`, {
					where: { id: { eq: imported.id } },
					limit: 1
				})
	);
	const importRow = $derived(
		imported === null ? undefined : importRun.value?.rows.find((r) => r.id === imported?.id)
	);
	const importOut = $derived(
		importRow?.status === 'succeeded' && Predicate.isObject(importRow.result)
			? importRow.result
			: null
	);
	const findings = $derived(
		(Array.isArray(importOut?.['findings']) ? importOut['findings'] : []).flatMap((f): Finding[] =>
			Predicate.isObject(f)
				? [
						{
							at: typeof f['at'] === 'number' ? f['at'] : 0,
							field: typeof f['field'] === 'string' ? f['field'] : null,
							message: String(f['message'] ?? ''),
							severity: f['severity'] === 'warn' ? 'warn' : 'refuse'
						}
					]
				: []
		)
	);
	const importStatus = $derived.by((): Status | undefined => {
		if (imported === null) return undefined;
		const r = importRow;
		if (r === undefined || !['succeeded', 'failed', 'stopped', 'skipped'].includes(r.status))
			return { state: 'pending' };
		if (r.status !== 'succeeded')
			return {
				state: 'failed',
				message: r.error?.message ?? r.error?.code ?? catalogText(bolt, `run.status.${r.status}`, r.status)
			};
		if (importOut?.['applied'] === false)
			return {
				state: 'failed',
				message: msg(bolt, 'view.importRefused'
				)
			};
		return { state: 'done' };
	});
	/** The row the watched import shows on. */
	const watching = (e: Entry) => imported !== null && e.sync === imported.sync;
	const pending = $derived(
		Object.values(status).some((s) => s.state === 'pending') || importStatus?.state === 'pending'
	);
	const counts = $derived(
		importOut?.['applied'] === true
			? msg(bolt, 'view.imported', {
					created: Number(importOut['created'] ?? 0),
					updated: Number(importOut['updated'] ?? 0),
					deleted: Number(importOut['deleted'] ?? 0)
				})
			: ''
	);
	// the run ends while the menu is closed: say so, and open the menu on its findings (refusals, or the warnings of what it imported)
	watch(
		() => importStatus?.state,
		(now, before) => {
			if (now === undefined || now === 'pending' || now === before) return;
			if (now === 'done') {
				toast.success(counts);
				if (findings.length > 0) menuOpen = true;
			} else if (now === 'failed' && importStatus?.state === 'failed') {
				toast.error(importStatus.message);
				menuOpen = true;
			}
		}
	);
	const scoped = (): { readonly [k: string]: Json } =>
		cfg?.context === undefined ? {} : { context: cfg.context };
	/** What the page shows: the author's scope and the viewer's filter. */
	const shown = () => and(and(author, hidden_author), view?.where);
	function startImport(sync: string, file: string) {
		const h = bolt.sync_control(model, sync, { mode: 'import', file, ...scoped() });
		if (bolt.runs === undefined) return track(h); // no run reads here: RunStatus says so
		return h.pipe(
			Effect.map((outcome) => {
				if (!ok(outcome)) return outcome;
				imported = { sync, id: h.id };
				return undefined;
			})
		);
	}
	function importFile(sync: string, file: File | undefined) {
		const upload = kinds.upload;
		if (file === undefined || upload === undefined) return;
		imported = null;
		perform(importKey(sync), () =>
			upload(file, `${model}.$import.${sync}`).pipe(
				Effect.flatMap((ref) => startImport(sync, ref.id)),
				Effect.ensuring(
					Effect.sync(() => {
						const picker = pickers[sync];
						if (picker) picker.value = '';
					})
				)
			)
		);
	}

	/**
	 * Asks in-app first, then deletes each record on its own so one refusal keeps only that record: the outcome says how
	 * many were deleted and why the first kept one was refused ("3 deleted, 1 kept: …").
	 */
	/** An audited record is written at the revision it was read at; nothing else of the row is a target. */
	const stamp = $derived(x?.audit === false ? [] : ['revision']);
	const targetOf = (row: { readonly id: string; readonly [field: string]: Value }) => {
		const revision = row['revision'];
		return { id: row.id, ...(typeof revision === 'number' ? { revision } : {}) };
	};
	function remove(): void {
		const target = [...picked];
		fork(
			confirm_action({
				title: msg(bolt, 'table.confirmDelete', { n: target.length }),
				body: msg(bolt, 'view.deleteBody'),
				confirm_label: msg(bolt, 'view.deleteButton'),
				cancel_label: msg(bolt, 'record.cancel'),
				destructive: true
			}).pipe(
				Effect.tap((confirmed) =>
					Effect.sync(() => {
						if (confirmed)
							perform(
								'delete',
								() =>
									// ponytail: one act per record, in order; batch when bulk deletes outgrow it
									Effect.forEach(target, (id) =>
										bolt.query(by_id(model, id, stamp)).pipe(Effect.flatMap((answer) => {
											const row = first_of(answer, model);
											return row === null
												? Effect.succeed<Outcome>({ kind: 'refused', code: 'not_found', message: msg(bolt, 'record.not_found') })
												: actOutcome(bolt.act({ [`${model}.delete`]: [{ target: targetOf(row) }] }));
										}))
									).pipe(
										// some went: the view refreshes (and drops the selection) though the outcome is a refusal
										Effect.tap((outcomes) =>
											Effect.sync(() => {
												const kept = outcomes.filter((o) => !ok(o)).length;
												if (kept > 0 && kept < outcomes.length) on_settled?.();
											})
										),
										Effect.map((outcomes): Outcome => {
											const kept = outcomes.filter((o) => !ok(o));
											const first = kept[0];
											if (first === undefined)
												return (
													outcomes.find((o) => o.kind === 'pending_approval') ?? {
														kind: 'committed',
														output: null,
														records: []
													}
												);
											return {
												kind: 'refused',
												code: 'kept',
												message: msg(bolt, 'view.deleteKept',
													{
														deleted: outcomes.length - kept.length,
														kept: kept.length,
														reason: outcomeText(bolt, first)
													}
												)
											};
										})
									),
								msg(bolt, 'view.deleted', { n: target.length })
							);
					})
				)
			)
		);
	}

	function updateSelected() {
		if (!editReady) return;
		const target = [...picked],
			set = editSet;
		perform('update', () =>
			bolt.query(request_json({ [model]: { where: { id: { in: target } }, fields: stamp, limit: target.length } })).pipe(
					Effect.flatMap((answer) => {
						const rows = page_of(answer, model)?.rows ?? [];
						return rows.length !== target.length
							? Effect.succeed<Outcome>({ kind: 'refused', code: 'not_found', message: msg(bolt, 'record.not_found') })
							: actOutcome(bolt.act({ [`${model}.update`]: rows.map((row) => ({ target: targetOf(row), set })) }));
					}),
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
	// a download the browser builds: the rows in view, the view's columns; enums in their words, dates as ISO text,
	// behind a BOM so Excel reads UTF-8 (Chinese included)
	function exportCsv() {
		return Effect.gen(function* () {
			if (exporter === undefined) return;
			const rows = unref(kinds.catalog, model, exporter.fields, yield* exporter.read(), true);
			const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
			const kindOf = (f: string) =>
				exporter.kinds?.[f] ?? (kinds.catalog?.[model] ?? catalog[source])?.fields[f];
			const words = (f: string) => (v: string) =>
				enum_text(v, { t: (k) => bolt.t(k), model, field: f });
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
			download_text_files([{ name: `${model || 'rows'}.csv`, content: text }]);
		});
	}
	const named = record_labels(() => bolt, () => kinds.catalog ?? catalog);
	/** The catalogue's words for an operator on a path (the fallback is the machine operator). */
	const opWords = (op: string, path: string) =>
		view?.offers.find((o) => o.op === op && pathOf(o.path).endsWith(path))?.opLabel ?? op;
	const chips = $derived(
		view === undefined
			? []
			: view.rows.flatMap((n, i) =>
					// an incomplete row (a field, no value yet) stays in the builder; it is not applied, so it is no chip
					complete(n)
						? [{ i, parts: nodeParts(catalog, source, n, humanize, named, opWords, bolt.locale) }]
						: []
				)
	);
</script>

<span hidden {@attach lifetime}></span>
{#snippet menuRow(e: Entry)}
	{@const st =
		watching(e) && importStatus !== undefined && status[e.key]?.state !== 'failed'
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
			{:else if watching(e) && st?.state === 'done' && counts !== ''}<span
					class="text-muted-foreground block text-xs">{counts}</span
				>
			{:else if e.why ?? e.hint}<span class="text-muted-foreground block text-xs"
					>{e.why ?? e.hint}</span
				>{/if}
		</span>
		<Button
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
					label={msg(bolt, 'view.running')}
				/>
			{:else if st?.state === 'done'}<Glyph name="check" class="size-3.5" />{/if}
			{st?.state === 'done' ? msg(bolt, 'view.done') : e.button}
		</Button>
	</div>
	{#if watching(e) && imported !== null && findings.length > 0 && (st?.state === 'done' || st?.state === 'failed')}
		<!-- the import's findings: each sheet row's problem; refusals wrote nothing, warnings came with what it imported -->
		<div class="border-border mx-2 mb-1 grid gap-2 rounded-md border p-2" data-import-findings>
			<ul class="grid max-h-48 gap-1 overflow-y-auto text-xs">
				{#each findings as f, i (i)}
					{@const at = [
						f.at === 0 ? '' : msg(bolt, 'view.row', { row: f.at }),
						f.field === null ? '' : pathLabel(catalog, model, f.field, humanize)
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
		</div>
	{/if}
{/snippet}

{#if cfg !== null}
	<div class="@container flex min-w-0 flex-col gap-1.5" data-view-toolbar>
		{#each files.filter((f) => f.import) as f (f.name)}<input
				bind:this={pickers[f.name]}
				type="file"
				accept={f.accept}
				class="hidden"
				data-view-import={f.name}
				onchange={(e) => importFile(f.name, e.currentTarget.files?.[0])}
			/>{/each}
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			{#if title}<h2
					class={['min-w-0 truncate text-sm font-semibold', cfg.error && 'text-destructive']}
					data-view-title
				>
					{title}
				</h2>{/if}
			{#if about}
				<!-- a popover, not a hover tooltip: a tap on a phone opens it too -->
				<Popover.Root>
					<Popover.Trigger
						class={[
							'hover:bg-accent hover:text-foreground grid size-8 [--hit-target:2rem] shrink-0 place-items-center rounded-sm',
							cfg.error ? 'text-destructive' : 'text-muted-foreground'
						]}
						aria-label={msg(bolt, 'view.about', {
							what: title || label(bolt, model)
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
			<!-- view controls stay left; compact task controls and New share the right edge -->
			{#if cfg.controls}<div class="flex min-w-0 flex-wrap items-center gap-1" data-view-controls>
					{@render cfg.controls()}
				</div>{/if}
			{#if canSearch}
				<!-- the search is an icon: its popover opens with the box focused, and says what it searches and which
				     `/` commands the model offers -->
				<ToolbarSearch
					bind:open={searchOpen}
					active={searching}
					label={searchHint}
					panel_class={chosen?.input === undefined
						? 'w-[min(26rem,calc(100vw-1rem))]'
						: 'w-[min(36rem,calc(100vw-1rem))]'}
					on_open_auto_focus={(e) => {
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
							<!-- a search index: its input fields' own editors under the chip, two to a row (a custom datatype's editor
								     takes the row), run on submit as the view's `{ search: { <index>: input } }` read -->
							<form
								class="grid basis-full grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] items-start gap-2 pt-1 pb-2"
								data-similar-input={index}
								onsubmit={(e) => {
									e.preventDefault();
									if (ready) on_probe?.({ index: index ?? '', input: encode_wire(values) });
								}}
							>
								{#each Object.entries(chosen.input) as [f, k] (f)}
									<div
										class="grid min-w-0 gap-1 text-xs {k.kind === 'custom' ? 'col-span-full' : ''}"
										data-similar-field={f}
									>
										<span class="text-muted-foreground">{k.label ?? humanize(f)}</span>
										<Editor {ctx}
											kind={k}
											value={values[f] ?? null}
											on_change={(v) => (values = { ...values, [f]: v })}
											name={f}
										/>
									</div>
								{/each}
								<Button
									type="submit"
									class="col-span-full justify-self-end"
									disabled={!ready}
									data-similar-run><Glyph name="search" />{t('searchRun')}</Button
								>
							</form>
						{:else}
							{@const activeOption = menuOf[searchActive]}
							<input
								bind:this={box}
								class="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none"
								type="search"
								role="combobox"
								aria-autocomplete="list"
								aria-controls="search-indexes"
								aria-expanded={picking}
								aria-activedescendant={picking && activeOption !== undefined
									? `search-option-${activeOption.name}`
									: undefined}
								placeholder={index === 'semantic'
									? t('searchMeaning')
									: lexical
										? `${searchHint}${indexes.length > 0 ? ` · ${t('searchCommands')}` : ''}`
										: t('searchPick')}
								aria-label={searchHint}
								value={text}
								oninput={(e) => typing(e.currentTarget.value)}
								onkeydown={(e) => {
									if (e.key === 'Enter' && index === 'semantic') meaning();
									if (e.key === 'Enter' && !picking) searchOpen = false;
									else key(e);
								}}
								data-search
							/>
						{/if}
					</div>
					{#if picking}
						<div
							id="search-indexes"
							class="grid min-w-0 gap-0.5"
							role="listbox"
							data-search-indexes
						>
							{#if menuOf.length === 0}<p
									class="text-muted-foreground px-2 py-1.5 text-sm"
									data-search-none
								>
									{indexes.length === 0 ? t('searchNone') : t('noResults')}
								</p>{/if}
							{#each menuOf as i, at (i.name)}
								<button
									id={`search-option-${i.name}`}
									type="button"
									role="option"
									aria-selected={at === searchActive}
									class={cn(
										'hover:bg-accent min-w-0 rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60',
										at === searchActive && 'bg-accent'
									)}
									disabled={i.why !== null}
									title={i.why ?? i.hint}
									onmousemove={() => (searchActive = at)}
									onclick={() => pick(i)}
									data-active={at === searchActive ? 'true' : undefined}
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
				</ToolbarSearch>
			{/if}
			{#if canFilter && view !== undefined}<ViewPopover {ctx}
					{view}
					{catalog}
					model={source}
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
								hint={msg(bolt, 'view.actions')}
								aria-label={msg(bolt, 'view.actions')}
								aria-busy={pending}
								data-view-actions
							>
								{#if pending}<Spinner label={msg(bolt, 'view.running')} />{:else}<Glyph
										name="zap"
										class="size-3.5"
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
												{msg(bolt, 'table.selected', { n: picked.length })}.
												{msg(bolt, 'view.editOnlyChosen')}
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
															on_checked_change={(checked) => chooseEdit(field, checked)}
															data-bulk-update-choose={field.name}
														/>
														<label
															class="flex min-h-11 flex-1 items-center @xl:min-h-8"
															for={`${editorId}-${field.name}-choose`}
															id={`${editorId}-${field.name}-label`}
														>
															{field.kind.label ?? pathLabel(catalog, model, field.name, humanize)}
														</label>
													</div>
													{#if chosen}
														<label class="sr-only" for={`${editorId}-${field.name}`}
															>{field.kind.label ??
																pathLabel(catalog, model, field.name, humanize)}</label
														>
														<Editor {ctx}
															kind={field.kind}
															value={editValues[field.name] ?? null}
															on_change={(value) =>
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
																variant="ghost"
																class="justify-self-start"
																disabled={status['update']?.state === 'pending'}
																onclick={() => (editValues = { ...editValues, [field.name]: null })}
															>
																{msg(bolt, 'view.clearValue')}
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
															on_checked_change={(checked) => chooseLinks(name, checked)}
															data-bulk-update-choose={name}
														/>
														<label
															class="flex min-h-11 flex-1 items-center @xl:min-h-8"
															for={`${editorId}-${name}-choose`}
														>
															{pathLabel(catalog, model, name, humanize)}
														</label>
													</div>
													{#if chosen}
														<BulkRelation {ctx}
															{name}
															{child}
															parent_id={editParent}
															value={editLinks[name] ?? NO_LINKS}
															on_change={(next) => (editLinks = { ...editLinks, [name]: next })}
															id={`${editorId}-${name}`}
															errors={editProblems}
															disabled={status['update']?.state === 'pending'}
														/>
													{/if}
												</div>
											{/each}
											<Button
												type="submit"
												class="justify-self-end"
												disabled={!editReady || status['update']?.state === 'pending'}
												aria-busy={status['update']?.state === 'pending'}
												data-bulk-update-submit
											>
												{#if status['update']?.state === 'pending'}<Spinner
														label={msg(bolt, 'view.running')}
													/>{/if}
												{msg(bolt, 'view.applySelected', {
													n: picked.length
												})}
											</Button>
										</form>
									</div>
								{/if}
							{/each}
						{/each}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if cfg.trailing}<div class="ml-auto flex shrink-0 items-center gap-1" data-view-trailing>
					{@render cfg.trailing()}
				</div>{/if}
			{#if canNew}
				<Button
					size="default"
					class={cfg.trailing ? 'px-2.5 @xl:px-3' : 'ml-auto px-2.5 @xl:px-3'}
					aria-label={msg(bolt, 'table.new')}
					data-view-new
					onclick={create}
				>
					<Glyph name="plus" /><span class="hidden @xl:inline"
						>{on_add ? msg(bolt, 'table.add') : msg(bolt, 'table.new')}</span
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
						<FilterSummary parts={c.parts} />
						<button
							type="button"
							class="hover:bg-accent grid size-4 place-items-center rounded-full"
							aria-label={msg(bolt, 'view.removeFilter')}
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
							aria-label={msg(bolt, 'view.removeSort')}
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
		{#each runs as r (r.id)}<RunStatus {ctx} automation={r.automation} run={r.id} download />{/each}
	</div>
{/if}
