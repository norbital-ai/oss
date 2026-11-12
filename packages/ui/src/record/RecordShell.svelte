<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Snippet } from 'svelte';
	import type { ModelKey, InsertOf, RecordOf, Row } from '../model/types.js';
	import type { Outcome } from '../client/contract.js';
	import type { FormProps } from '../form/form.svelte';
	import type { RunsForProps } from '../runs/RunsFor.svelte';
	import type { RecordSection } from '../form/section.svelte';
	import type { RecordHistoryConfig } from './history.js';
	import type { RecordView } from './types.js';
	export type { RecordHistoryConfig, RecordHistorySource } from './history.js';

	/** An authored tab; a `keep_alive` tab stays mounted while hidden, so a form inside it keeps its state. */
	export type RecordTab = {
		name: string;
		title: string;
		body: Snippet;
		icon?: string;
		keep_alive?: true;
	};
	/** The props of `RecordShell`, typed by the model `of`. */
	type RecordShellProps<C extends ModelKey = ModelKey> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		of: C;
		/** The stored row; absent with `mode="create"`. */
		id?: FormProps<C>['id'];
		mode?: 'view' | 'edit' | 'create';
		/** Create mode: the pre-filled values (a page's scope). */
		values?: Partial<InsertOf<C>>;
		/** Generated view: create offers these beyond `values`' keys; update shows only these, in this order (else every field). */
		fields?: FormProps<C>['fields'];
		/** Pure draft rules, shared with the model's guarded write. */
		validate?: FormProps<C>['validate'];
		/**
		 * Generated view (read, edit, create): the fields grouped into collapsible `Section`s, in order; fields no section
		 * lists follow in one untitled, always-open group. Titles and summaries arrive translated.
		 */
		sections?: readonly RecordSection[];
		/** The heading; default the record's label fields by kind (a create: "New <singular>"). */
		title?: string;
		/** Hide the model noun when the authored heading already identifies the record. */
		eyebrow?: boolean;
		/** A line under the heading: text, or field names shown by kind (`['customer', 'due_on']` → `Acme · Jan 2, 2026`). */
		subtitle?: string | readonly string[];
		/** Iconify id inside the state pill. */
		icon?: string;
		/** The state pill's text. */
		badge?: string;
		/** A UI-only lock reason: the footer shows a lock instead of Edit while the record is not in edit mode. */
		lock?: string;
		/** One sentence behind the pill. */
		hint?: string;
		/** Placed in the record header (e.g. an "Approve" action). */
		actions?: Snippet;
		/** Beside the label in the chrome (e.g. a timeline trigger). */
		trailing?: Snippet;
		/** Beside Edit / Save in the footer (lifecycle actions: promote, transfer, terminate). */
		footer_actions?: Snippet;
		/**
		 * A short line at the start of the footer, opposite Edit / Save (a status, what saving does). While a draft has
		 * unsaved changes the footer says so instead.
		 */
		footer?: string | Snippet;
		tabs?: readonly RecordTab[];
		/** Related records included in the native History popover, scoped by read queries. */
		history?: RecordHistoryConfig;
		/** Runs whose subject is this record, shown as a Runs tab. */
		runs?: readonly RunsForProps[];
		/**
		 * The representation's body; absent → the representation registered for `of`, else the generated view. It receives
		 * the record shown — the scrubbed revision while one is picked — as `use_record_view()` also does beneath. A model's
		 * `+representation.svelte` takes `{ view: RecordView<C> }` or reads `use_record_view()`, never `$props().row`/`record`.
		 */
		children?: Snippet<[RecordView<C>]>;
		on_done?: (outcome: Outcome) => void;
	};
	// the tab each record was last on, for this page's life: reopening a record after a child record closes (a trial
	// opened from its project's Trials tab) lands where the person left it, not back on the first tab
	const lastTab = new Map<string, string>();
</script>

<script lang="ts" generics="C extends ModelKey">
	import { Effect } from 'effect';
	import { fork, observe_once } from '../effect/index.js';
	import { contentMotion } from '../form/content-motion.js';
	// The record frame (X-20): label, state pill, actions, the UI tab, authored tabs and Runs. One tab row: a nested
	// shell shows its body only, and a tab a page's own strip already shows is not repeated. The record's header carries
	// the record/approval toggle for native proposals and the history scrubber: a past revision shows
	// read-only in the body. Without a body it renders the model's `+representation.svelte` or the generated view.
	import Icon from '@iconify/svelte';
	import { getContext, onDestroy, setContext, untrack } from 'svelte';
	import Badge from '../primitives/badge/badge.svelte';
	import Tooltip from '../primitives/tooltip/tooltip.svelte';
	import { Button } from '../primitives/button/index.js';
	import { confirm_action } from '../primitives/dialog/confirm.js';
	import { TAB_LEVEL, Tabs, type TabItem } from '../primitives/tabs/index.js';
	import Form from '../form/form.svelte';
	import FormBody from '../form/form-body.svelte';
	import ChildGrid from '../relations/ChildGrid.svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import { fields_text, format, recordText, type Value as FieldValue } from '../kinds/kind.js';
	import { open_record } from './navigation.js';
	import { provide_model } from '../model/context.js';
	import { provideRecordView, representations } from './context.js';
	import { bolt_of } from '../client/context.js';
	import { type RestorePreview } from './types.js';
	import * as Dialog from '../primitives/dialog/index.js';
	import Value from '../cell/Value.svelte';
	import type { HistorySnapshot } from '../client/contract.js';
	import { humanize } from '../text/messages.js';
	import { actOutcome, notify } from '../actions/outcome.js';
	import ApprovalPanel from '../approval/ApprovalPanel.svelte';
	import { approvalOf, lockText } from '../approval/row.js';
	import { matchesLock } from './lock.js';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { ui_text } from '../primitives/utils.js';
	import { watch as changes } from 'runed';
	import {
		FormState,
		provideRecordController,
		use_record_controller
	} from '../form/form-state.svelte.js';
	import { draftKey, formSpec, locked } from '../form/draft.js';
	import { pendingUnload } from '../form/unload.js';
	import { mapped, queryState } from '../read/state.js';
	import { checkpoints, historicalFields, historicalValue, skipText, type Checkpoint } from './history.js';
	import { label, lowerLead, singular, msg } from '../text/messages.js';
	import { listRequest, refLabel, refOf, unref, type Refs } from '../relations/select.js';
	import { by_id, first_of, request_json } from '../read/request.js';
	import { RUNS_GROUP } from '../runs/RunsFor.svelte';
	import RecordTimeline from './RecordTimeline.svelte';
	import RunsFor from '../runs/RunsFor.svelte';

	let {
		ctx,
		of,
		id,
		mode = 'view',
		values,
		fields = [],
		validate,
		sections = [],
		title,
		eyebrow = true,
		subtitle,
		icon,
		badge,
		lock,
		hint,
		actions,
		trailing,
		footer,
		footer_actions,
		tabs = [],
		history: historyOptions,
		runs = [],
		children,
		on_done
	}: RecordShellProps<C> = $props();
	// `of` and `id` are re-read whenever the parent updates (the shell's sheet list builds fresh entries on every URL
	// change); what loads (the read, the representation, the approvals) keys on their values, so an unchanged record
	// never drops to its skeleton and back
	const readOf = $derived(of),
		readId = $derived(id);
	const bolt = $derived(bolt_of(ctx));
	const kinds = $derived(ctx.ui.kinds);
	const formText = ui_text();
	provide_model(() => of);

	// a representation that renders <RecordShell of={same}> without a body gets the generated view, not itself again;
	// a shell inside a framed shell (a record within a record's tab) shows its body only: a record view has one tab row
	const INSIDE = 'ui.views.record';
	// The native read feeds both the record view and Form's model-specific record contract.
	type StoredRecord = RecordOf<C> & Row;
	type Scrub = { readonly past: StoredRecord | null };
	type Decoration = {
		head: Snippet;
		foot: Snippet;
		readonly eyebrow: string | null;
		readonly name: string;
	};
	type FormSubmit = {
		readonly label: string | undefined;
		readonly writable: boolean;
		readonly disabled: boolean;
	};
	type NativeSubmit = {
		readonly entries: readonly FormSubmit[];
		add(entry: FormSubmit): () => void;
	};
	const parent = getContext<
		| {
				readonly of: string;
				readonly id: string | undefined;
				scrub?: Scrub;
				history?: { set(config: RecordHistoryConfig): void };
				decorate?: (entry: Decoration) => () => void;
		  }
		| undefined
	>(INSIDE);
	const inside = $derived(parent?.of);
	const nested = parent !== undefined;
	const framed = !nested;
	const sameRecord = $derived(inside === of && parent?.id === id);
	// A representation can decorate its record, but the outer shell always owns the bounded native frame.
	let decorations = $state.raw<readonly Decoration[]>([]);
	const decoration = $derived(decorations.at(-1));
	function decorate(entry: Decoration): () => void {
		decorations = [...decorations, entry];
		return () => {
			decorations = decorations.filter((item) => item !== entry);
		};
	}
	const FORM_SUBMIT = Symbol.for('ui.record.form.submit');
	const inheritedSubmit = getContext<NativeSubmit | undefined>(FORM_SUBMIT);
	let formSubmits = $state.raw<readonly FormSubmit[]>([]);
	const nativeSubmit: NativeSubmit | undefined = framed
		? {
				get entries() {
					return formSubmits;
				},
				add(entry) {
					formSubmits = [...formSubmits, entry];
					return () => {
						formSubmits = formSubmits.filter((item) => item !== entry);
					};
				}
		  }
		: untrack(() => sameRecord) ? inheritedSubmit : undefined;
	setContext(FORM_SUBMIT, nativeSubmit);
	// the outermost shell of a stored record owns its header chrome: the toggle, the scrubber and the revision shown;
	// its own representation's shell (same model) shows that revision too
	const owner = untrack(() => mode !== 'create' && id !== undefined && framed);
	const scrub: Scrub | undefined = owner
		? {
				get past() {
					return past;
				}
			}
		: untrack(() => sameRecord)
			? parent?.scrub
			: undefined;
	let historyConfig = $state<RecordHistoryConfig>({});
	changes(
		() => {
			if (historyOptions === undefined) return null;
			if (owner) return { config: historyOptions, history: undefined };
			return sameRecord ? { config: historyOptions, history: parent?.history } : null;
		},
		(next) => {
			if (next === null) return;
			if (owner) historyConfig = next.config;
			else next.history?.set(next.config);
		}
	);
	setContext(INSIDE, {
		get of() {
			return of;
		},
		get id() {
			return id;
		},
		scrub,
		history: owner
			? {
					set(config: RecordHistoryConfig) {
						historyConfig = config;
					}
				}
			: untrack(() => sameRecord) ? parent?.history : undefined,
		decorate: framed
			? decorate
			: untrack(() => sameRecord) ? parent?.decorate : undefined
	});
	// the tab strips around this record (a page's own tabs): an authored tab they already show is not repeated
	const around = getContext<{ shown: readonly string[] } | undefined>(TAB_LEVEL);
	const registry = representations();
	// the representation's module loads on first use, so importing it (and `$bolt`) waits for a record to show
	const Representation = $derived(
		inside === readOf || children !== undefined
			? undefined
			: registry?.[readOf]?.().then((m) => m.default)
	);

	// read in this component, the query is live: it follows the record's revisions until the shell unmounts
	const record = $derived(
		mode !== 'create' && readId !== undefined
			? mapped(bolt.query(by_id(readOf, readId)), (answer) =>
					first_of(answer, readOf)
				)
			: null
	);
	const loaded = $derived(queryState(record));
	const live = $derived(loaded.kind === 'ready' ? loaded.value : null);
	const complete = $derived(live === null ? null : bolt.project_record(readOf, live));
	// ── the scrubber (owner only): the revision the body shows, read as of that revision; null is live ──
	let viewing = $state<number | null>(null);
	let past = $state<StoredRecord | null>(null);
	let historical = $state<HistorySnapshot | null>(null);
	let historyError = $state<string | null>(null);
	let asked = 0;
	const latest = $derived(typeof live?.['revision'] === 'number' ? live['revision'] : 0);
	function pick(r: number | null) {
		const n = ++asked;
		historyError = null;
		if (r === null || r >= latest || id === undefined) {
			viewing = null;
			past = null;
			historical = null;
			return;
		}
		viewing = r;
		const back = () => {
			if (n === asked) {
				viewing = null;
				past = null;
				historical = null;
			}
		};
		fork(
			bolt.history(of, id, { at: { revision: r }, view: true }).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (n !== asked) return;
						if (value === null) back();
						else {
							historical = value;
							// an invalid revision's captured data is shown, never projected into the representation
							past = value.incompatible.length === 0 ? value.projection : null;
						}
					})
				)
			),
			() => {
				if (n !== asked) return;
				back();
				historyError = msg(bolt, 'record.historyFailed'
				);
			}
		);
	}
	// ── per-record restore: the viewed revision's own fields as a new latest revision, never a rollback ──
	// the preview is read when the person asks for it, not on every scrub step (each one is an act)
	const canRestore = $derived(
		owner && viewing !== null && historical !== null && historical.incompatible.length === 0 && id !== undefined && bolt.restore !== undefined
	);
	let previewOf = $state<number | null>(null);
	const restorable = observe_once(() => {
		void latest;
		return canRestore &&
			previewOf !== null &&
			previewOf === viewing &&
			id !== undefined &&
			bolt.restore
			? bolt.restore.preview(of, id, previewOf)
			: null;
	});
	const restoring = $derived(
		restorable.current !== undefined && restorable.current?.revision === viewing
			? restorable.current
			: null
	);
	let confirming = $state(false);
	let restorePending = $state(false);
	function restore(p: RestorePreview) {
		const client = bolt.restore;
		if (client === undefined) return;
		restorePending = true;
		fork(
			actOutcome(client.run(p.model, p.record, p.revision, p.live)).pipe(
				Effect.tap((o) =>
					Effect.sync(() => {
						restorePending = false;
						confirming = false;
						notify(
							bolt,
							o,
							msg(bolt, 'record.restored', { n: p.revision })
						);
						if (o.kind === 'pending_approval')
							submitted = { model: of, record: id, request_id: o.request_id };
						if (o.kind === 'committed' || o.kind === 'pending_approval') pick(null);
					})
				),
				Effect.ensuring(Effect.sync(() => { restorePending = false; }))
			),
			(error) => { historyError = bolt.t(error.message); }
		);
	}
	// the revisions' details load on the scrubber's first hover or focus, and again once the record moves on
	let wanted = $state(false);
	const history = $derived.by<Effect.Effect<readonly Checkpoint[], Error> | null>(() => {
		if (!wanted || id === undefined) return null;
		void latest;
		return bolt.history(of, id).pipe(Effect.map(checkpoints));
	});
	const shownPast = $derived(owner ? past : (scrub?.past ?? null));
	// a valid past revision projects into the representation; an invalid one renders only its captured data
	const row = $derived(live);
	const shown = $derived(shownPast ?? row);
	const typedShown = $derived(shownPast ?? complete);
	// the generated form is a model form: its props are read at the model-key domain, which `C` narrows
	const formOf: ModelKey = $derived(of);
	const view = $derived.by<RecordView<C> | null>(() =>
		mode === 'create'
			? { model: of, mode: 'create', values: values ?? {} }
			: typedShown === null
				? null
				: {
						model: of,
						mode: shownPast !== null ? 'view' : controller?.mode === 'edit' ? 'edit' : 'view',
						record: typedShown,
						...(shownPast !== null || controller?.capabilities == null
							? {}
							: { capabilities: controller.capabilities })
					}
	);
	let submitted = $state<{
		model: string;
		record: string | undefined;
		request_id: string;
	} | null>(null);
	const submittedId = $derived(
		submitted?.model === of && submitted.record === id ? submitted.request_id : null
	);
	const requests = observe_once(() => {
		void latest;
		if (submittedId !== null)
			return bolt.approvals
				.get(submittedId)
				.pipe(Effect.map((request) => (request === null ? [] : [request])));
		if (mode !== 'create' && loaded.kind !== 'ready') return null;
		return readId === undefined
			? Effect.succeed([])
			: bolt.approvals.list({ model: readOf, records: [readId], all: true });
	});
	const openRequest = $derived(
		(requests.current ?? []).find(
			(request) => request.status === 'Pending' || request.status === 'ChangesRequested'
		) ?? null
	);
	const approvalId = $derived(submittedId ?? openRequest?.id ?? requests.current?.[0]?.id ?? null);
	const pending_approval = $derived(openRequest !== null);
	// A create rolled back by rejection or withdrawal has no row any more; its request remains readable.
	const createRequest = $derived(
		mode !== 'create' &&
			live === null &&
			(requests.current ?? []).some(
				(request) => request.action === 'create' && request.model === of && request.record === id
			)
	);
	/** The header switches between the stored record and its native proposal. */
	let pane = $state<'record' | 'approval'>('record');
	const onApproval = $derived(pane === 'approval');
	// A history scrub shows its selected record throughout nested forms.
	provideRecordView({
		get current() {
			return view;
		}
	});
	// One native frame claims the sheet even while loading or rendering a raw custom representation.
	const SHEET = Symbol.for('ui.sheet.header');
	const EYEBROW = Symbol.for('ui.sheet.eyebrow');
	const NAME = Symbol.for('ui.sheet.name');
	// the owner's toggle and scrubber sit in the sheet's title bar beside full screen and close; no shell below claims them
	const CHROME = Symbol.for('ui.sheet.chrome');
	const toChrome = getContext<((c: { tools: Snippet } | null) => void) | undefined>(CHROME);
	const aroundSheet = getContext<((s: Snippet | null) => void) | undefined>(SHEET);
	const aroundEyebrow = getContext<((text: string | null) => void) | undefined>(EYEBROW);
	const aroundName = getContext<((text: string | null) => void) | undefined>(NAME);
	// a page-level record (no sheet around it) frames itself the way a sheet does: an eyebrow row, then the heading the
	// framed shell claims beside the owner's toggles
	const page = framed && aroundSheet === undefined && toChrome === undefined;
	let pageHead = $state<Snippet | null>(null);
	let pageEyebrow = $state<string | null>(null);
	const toSheet = page ? (s: Snippet | null) => (pageHead = s) : aroundSheet;
	const toEyebrow = page ? (text: string | null) => (pageEyebrow = text) : aroundEyebrow;
	setContext(SHEET, toSheet);
	setContext(EYEBROW, toEyebrow);
	changes(
		() => toSheet === undefined || !framed ? null : { publish: toSheet, head: frameHead },
		(next) => {
			if (next === null) return;
			next.publish(next.head);
			return () => next.publish(null);
		}
	);
	changes(
		() => toEyebrow === undefined || !framed ? null : {
			publish: toEyebrow,
			text: decoration === undefined
				? eyebrow && heading ? singular(bolt, of) : null
				: decoration.eyebrow
		},
		(next) => {
			if (next === null) return;
			next.publish(next.text);
			return () => next.publish(null);
		}
	);
	const authoredDecoration: Decoration = {
		head,
		foot,
		get eyebrow() {
			return eyebrow && heading ? singular(bolt, of) : null;
		},
		get name() {
			return sheetName;
		}
	};
	changes(
		() => nested && sameRecord ? parent?.decorate : undefined,
		(publish) => publish?.(authoredDecoration)
	);
	setContext(CHROME, undefined);
	changes(
		() => toChrome === undefined || !owner ? null : { publish: toChrome, tools },
		(next) => {
			if (next === null) return;
			next.publish({ tools: next.tools });
			return () => next.publish(null);
		}
	);

	// ── the generated view: a display grid by the catalog's kinds (else the row's own keys); edits and creates are `Form` ──
	const exposure = $derived(kinds.catalog?.[of]);
	// a section naming a field the model does not have is ignored, said once to the author
	untrack(() => {
		const e = exposure;
		if (e === undefined) return;
		for (const s of sections)
			for (const f of s.fields)
				if (e.fields[f] === undefined && e.relations?.[f] === undefined)
					console.warn(
						`[ui] RecordShell ${of}: section ${s.name} names unknown field ${f}; ignored`
					);
	});
	const inheritedController = use_record_controller();
	let localController = $state<FormState | null>(null);
	const sharedController = $derived.by(() => {
		const current = inheritedController?.current;
		return sameRecord &&
			current?.spec.target.of === 'model' &&
			current.spec.target.model === of &&
			current.spec.target.id === id
			? current
			: null;
	});
	const controller = $derived(sharedController ?? localController);
	// the approval lock (the host's `under_approval` restriction): editing is refused, and the row says who may edit
	const under_approval = $derived(
		controller?.capabilities?.update.reasons.includes('under_approval') === true
	);
	// a model's own-field lock is the declaration's, not a per-template callback: the page shows a lock, never Edit
	const modelLocked = $derived(live !== null && (exposure?.locks ?? []).some((rule) => (rule.except?.length ?? 0) === 0 && matchesLock(live, rule.where)));
	const lockReason = $derived(
		lock ??
			(modelLocked
				? msg(bolt, 'record.locked')
				: lockText(bolt, approvalOf(row)))
	);

	let capabilityRequest = 0;
	let permissionError = $state<string | null>(null);
	provideRecordController({
		get current() {
			return controller;
		},
		get historical() {
			return shownPast !== null || viewing !== null;
		}
	});
	changes([() => of, () => id, () => live, () => exposure, () => modelLocked], () => {
		if (sharedController) return;
		const spec = formSpec(of, exposure, mode === 'create' ? 'create' : 'update', id);
		if (spec === null || (mode !== 'create' && live === null)) return;
		const current = localController;
		if (
			current?.spec.target.of !== 'model' ||
			current.spec.target.model !== of ||
			current.spec.target.id !== id
		) {
			const given: Readonly<Record<string, FieldValue | undefined>> = values ?? {};
			const prefill = Object.fromEntries(
				Object.entries(given).flatMap(([field, value]): [string, FieldValue][] =>
					value === undefined ? [] : [[field, value]])
			);
			localController = new FormState(
				spec,
				live,
				prefill,
				(acts, options) => bolt.act(acts, options),
				{
					pending_approval: formText('pending_approval'),
					conflict: formText('conflict'),
					unknown: formText('unknown'),
					running: formText('running')
				},
				(field) => locked(exposure?.fields ?? {}, live, exposure?.locks)(field),
				undefined,
				draftKey(bolt.actor, spec, prefill)
			);
			localController.on_outcome(done);
			if (mode !== 'create' && (mode !== 'edit' || spec.readonly || modelLocked)) {
				// a draft left on this record reopens in edit, unless the record has locked since: then it can never be saved
				if (!localController.restored) localController.mode = 'view';
				else if (modelLocked) localController.view();
			}
		} else {
			current.spec = spec;
			if (live !== null) current.refresh(live);
		}
		if (mode === 'create' || id === undefined || bolt.record_capabilities === undefined) return;
		const target = localController;
		if (target === null) return;
		const request = ++capabilityRequest;
		const revision = live?.['revision'];
		target.expect_capabilities();
		permissionError = null;
		fork(
			bolt.record_capabilities(of, id).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (request !== capabilityRequest || target !== localController) return;
						if (
							value !== null &&
							(value.model !== of || value.id !== id || value.revision !== revision)
						) {
							permissionError = formText('conflict');
							return;
						}
						target.capabilities = value;
					})
				)
			),
			() => {
				if (request === capabilityRequest && target === localController)
					permissionError = msg(bolt, 'record.permissionsFailed'
					);
			}
		);
	});
	const beforeUnload = pendingUnload(() => localController?.pending === true);
	const editing = $derived(controller?.mode === 'edit');
	function done(o: Outcome) {
		notify(bolt, o);
		if (o.kind !== 'committed' && o.kind !== 'pending_approval') return;
		// the created record is this model's; an act's other writes (a transform's side rows) come first or last
		const mine = o.records.find((r) => r.model === of);
		if (o.kind === 'pending_approval') {
			submitted = { model: of, record: id ?? mine?.id, request_id: o.request_id };
			pane = 'approval';
		}
		controller?.view();
		if (on_done) on_done(o);
		else if (mode === 'create' && mine !== undefined) open_record(of, mine.id);
	}

	// the heading: the author's title, else the record's label fields by kind, else the record id (a create keeps the model's label); above a record's own heading, the singular model label
	// a relation in the heading or subtitle reads as its target's label (a table cell's rule): one read of the record with
	// those targets' labels nested, never its id (blank until it arrives)
	const labelled = $derived(
		[
			...(exposure?.label_paths ?? exposure?.label ?? []),
			...(typeof subtitle === 'object' ? subtitle : [])
		].filter((f) => refLabel(kinds.catalog, of, f.split('.')[0] ?? f).length > 0)
	);
	const related = $derived(
		mode !== 'create' && id !== undefined && labelled.length > 0
			? mapped(
					bolt.query(
						request_json(
							listRequest(kinds.catalog, of, { where: { id: { eq: id } }, limit: 1 }, [], labelled)
						)
					),
					(answer) => first_of(answer, of)
				)
			: null
	);
	const refs = $derived.by<Refs>(() => {
		const r = related?.current ?? null;
		if (r === null) return {};
		const resolved = unref(kinds.catalog, of, labelled, [r])[0];
		return resolved === undefined
			? {}
			: Object.fromEntries(
					labelled.flatMap((field) => {
						const ref = refOf(resolved, field);
						return ref === undefined ? [] : [[field, ref]];
					})
				);
	});
	const shownAs = (fs: readonly string[]) =>
		row === null || exposure === undefined
			? ''
			: fields_text(
					exposure.fields,
					{ ...row, ...Object.fromEntries(labelled.map((f) => [f, refs[f]?.text ?? null])) },
					fs,
					{
						locale: kinds.locale ?? bolt.locale,
						zone: kinds.zone,
						currency: kinds.currency,
						t: (k) => bolt.t(k),
						model: of
					}
				);
	const heading = $derived(
		title ??
			(mode !== 'create'
				? row !== null && typeof row['$label'] === 'string' && row['$label'].trim() !== ''
					? row['$label']
					: exposure?.record_label !== undefined && row !== null
						? recordText(exposure, { ...row, ...related?.current })
						: shownAs(exposure?.label ?? []) || row?.id || id || ''
				: '')
	);
	const subline = $derived(
		typeof subtitle === 'string' ? subtitle : subtitle === undefined ? '' : shownAs(subtitle)
	);
	// the heading the header shows: the author's title, else the record's label, else the model noun
	const titled = $derived(
		heading ||
			(mode === 'create'
				? msg(bolt, 'record.new', { what: lowerLead(singular(bolt, of)) })
				: label(bolt, of))
	);
	// the sheet's accessible name is the heading this frame claims; while the record loads, or before its representation
	// claims the header, the owner names it with the model noun
	const sheetName = $derived(
		mode === 'create' || loaded.kind === 'ready' ? titled : singular(bolt, of)
	);
	changes(
		() => aroundName === undefined || nested || !(framed || owner) ? null : {
			publish: aroundName,
			name: decoration?.name ?? sheetName
		},
		(next) => {
			if (next === null) return;
			next.publish(next.name);
			return () => next.publish(null);
		}
	);
	// a Runs tab says "No runs yet" once, when none of its automations has a run
	let runCounts = $state<{ [automation: string]: number }>({});
	setContext(RUNS_GROUP, (automation: string, n: number) => {
		runCounts[automation] = n;
	});
	const noRuns = $derived(runs.every((r) => runCounts[r.automation] === 0));

	const tabItems = $derived<TabItem[]>([
		{
			name: 'ui',
			title: msg(bolt, 'record.tab.record'),
			icon: 'lucide:file-text',
			body,
			keep_alive: true
		},
		...tabs.filter((t) => !around?.shown.includes(t.name) && !around?.shown.includes(t.title)),
		...(runs.length > 0
			? [
					{
						name: 'runs',
						title: msg(bolt, 'record.tab.runs'),
						icon: 'lucide:play',
						body: runsTab
					}
				]
			: [])
	]);
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet head()}
	<div class="flex min-w-0 flex-col" data-record-head>
		{#if eyebrow && heading && toEyebrow === undefined}<span
				class="text-micro text-muted-foreground truncate leading-4">{singular(bolt, of)}</span
			>{/if}
		<div class="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
			<div class="mr-auto flex min-w-0 flex-col gap-0.5">
				<div class="flex min-w-0 items-center gap-2">
					<h2 class="min-w-0 truncate text-sm leading-5 font-semibold">
						{titled}
					</h2>
					{#if badge || icon}<Badge variant="outline" title={hint}
							>{#if icon}<Icon {icon} class="size-3" />{/if}{badge ?? ''}</Badge
						>{/if}
					{#if pending_approval || under_approval}
						{@const rfc = openRequest?.status === 'ChangesRequested'}
						{@const full = rfc
							? msg(bolt, 'approval.requestForChange')
							: lockReason}
						<Tooltip text={full}>
							{#snippet trigger({ props })}
								<Badge
									{...props}
									variant="outline"
									class="shrink-0 whitespace-nowrap border-warning/25 bg-warning/10 text-warning-foreground hover:bg-warning/15 dark:text-warning"
									tabindex={0}
									role="status"
									aria-label={full}
									data-view="approval-badge"
									>{rfc ? 'RFC' : msg(bolt, 'record.pending')}</Badge
								>
							{/snippet}
						</Tooltip>
					{/if}
					{#if trailing}{@render trailing()}{/if}
				</div>
				{#if subline}<p class="text-muted-foreground truncate text-sm">{subline}</p>{/if}
			</div>
			{#if actions}{@render actions()}{/if}
		</div>
	</div>
{/snippet}

{#snippet frameHead()}
	{@render (decoration?.head ?? head)()}
{/snippet}

{#snippet foot()}
	<!-- The frame owns this footer; a same-record representation supplies its authored note and actions. -->
	{@const draft = controller}
	{@const target = draft?.spec.target.of === 'model' ? draft.spec.target : undefined}
	{@const matches = target !== undefined && target.model === of && target.id === id}
	{@const current =
		shownPast === null && viewing === null && live !== null &&
		exposure?.update !== undefined && matches && target?.mode === 'update'}
	{@const lockedHere =
		current && draft?.mode === 'view' && (lock !== undefined || modelLocked || under_approval)}
	{@const canEdit = current && draft?.mode === 'view' && !lockedHere && draft.can_submit}
	{@const inEdit = current && draft?.mode === 'edit'}
	{@const formEntries = nativeSubmit?.entries ?? []}
	{@const formDisabled = formEntries.some((entry) => entry.writable && entry.disabled)}
	{@const creating =
		mode === 'create' && matches && target?.mode === 'create' && draft?.mode === 'create' &&
		!draft.spec.readonly && (formEntries.length === 0 || formEntries.some((entry) => entry.writable))}
	<span class="text-meta mr-auto min-w-0 truncate" role="status">
		{#if inEdit && draft?.dirty && !draft.pending}{formText('unsaved')}
		{:else if typeof footer === 'string'}{footer}{:else}{@render footer?.()}{/if}
	</span>
	{@render footer_actions?.()}
	{#if lockedHere}
		<Tooltip text={lockReason}>
			{#snippet trigger({ props })}
				<Button {...props} variant="outline" disabled aria-label={lockReason} data-record-lock>
					<Icon icon="lucide:lock" class="size-3.5" />
				</Button>
			{/snippet}
		</Tooltip>
	{:else if canEdit}
		<Button
			variant="outline"
			class="min-w-[4.25rem] justify-center"
			onclick={() => draft?.edit()}>{msg(bolt, 'record.edit')}</Button
		>
	{:else if inEdit && draft !== null}
		{@const saving = draft.pending
			? formText('saving')
			: draft.resubmitting
				? msg(bolt, 'record.resubmit')
				: draft.requesting_approval
					? msg(bolt, 'record.requestApproval')
					: formText('save')}
		<div
			class="inline-flex shrink-0 items-center gap-2"
			role="group"
			aria-label={msg(bolt, 'record.editing')}
		>
			<Button
				variant="ghost"
				disabled={draft.pending}
				onclick={() => {
					if (!draft.dirty) return void draft.view();
					fork(
						confirm_action({
							title: formText('discardDraft'),
							confirm_label: formText('discard'),
								cancel_label: formText('cancel'),
								destructive: true
						}).pipe(
							Effect.tap((confirmed) =>
								Effect.sync(() => {
									if (confirmed) draft.view();
								})
							)
						)
					);
				}}
			>
				<Icon icon="lucide:undo-2" class="size-3.5" />{msg(bolt, 'record.cancel')}
			</Button>
			<Button
				disabled={!draft.can_save || !draft.dirty || formDisabled}
				onclick={() => fork(draft.submit())}
				data-record-save
			>
				{#if draft.pending}<Icon icon="lucide:loader-circle" class="size-3.5 animate-spin" />{/if}{saving}
			</Button>
		</div>
	{:else if creating && draft !== null}
		<div class="inline-flex shrink-0 items-center gap-2" role="group" aria-label={formText('create')}>
			<Button variant="outline" disabled={draft.pending || formDisabled} onclick={() => draft.reset()}>
				{formText('clear')}
			</Button>
			<Button disabled={!draft.can_save || formDisabled} onclick={() => fork(draft.submit())} data-record-save>
				{#if draft.pending}<Icon icon="lucide:loader-circle" class="size-3.5 animate-spin" />{formText('saving')}
				{:else if draft.resubmitting}{msg(bolt, 'record.resubmit')}
				{:else if draft.requesting_approval}{formText('requestApproval')}
				{:else}{formEntries.find((entry) => entry.writable && entry.label !== undefined)?.label ?? formText('create')}{/if}
			</Button>
		</div>
	{/if}
{/snippet}

{#snippet recordForm(props: Pick<FormProps<ModelKey>, 'mode' | 'id' | 'record' | 'values' | 'readonly'>)}
	<Form {ctx}
		of={formOf}
		{...props}
		{validate}
		{...fields.length > 0 ? { fields } : {}}
		{sections}
		class="shrink-0"
	/>
{/snippet}

{#snippet generated()}
	<!-- the form fills the body; a child grid follows below it, where the body scrolls -->
	{#if mode === 'create'}
		{@render recordForm({ mode: 'create', values })}
	{:else if typedShown !== null && editing && id !== undefined && shownPast === null}
		{@render recordForm({ mode: 'update', id, record: typedShown })}
	{:else if typedShown !== null}
		<div class="contents" data-view="record-generated">
			{#key shownPast}{@render recordForm({ mode: 'update', id, record: typedShown, readonly: true })}{/key}
		</div>
	{:else if controller !== null && shown !== null && exposure !== undefined}
		<!-- Narrow outputs keep their real native draft; only complete records enter an authored representation. -->
		<FormBody {ctx}
			spec={controller.spec}
			record={shown}
			values={{}}
			model_fields={exposure.fields}
			act={(acts, options) => bolt.act(acts, options)}
			{validate}
			{...fields.length > 0 ? { fields } : {}}
			{sections}
			readonly={!editing}
			class="shrink-0"
		/>
	{/if}
	{#key controller}{#each Object.keys(controller?.spec.children ?? {}) as relation (relation)}
			<ChildGrid {ctx} {of} {id} {relation} save="parent" />
		{/each}{/key}
{/snippet}

{#snippet body()}
	<!-- the body fits the record: a section or table inside scrolls itself; past their floors, the body scrolls -->
	<div
		class="-mx-1 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-1 [overflow-wrap:anywhere]"
		data-record-body
	>
		{#if children && view}{#key shownPast}{@render children(view)}{/key}
		{:else}{@render generated()}{/if}
	</div>
{/snippet}

{#snippet approval()}
	{#if requests.error}<Alert variant="destructive" role="alert"
			>{msg(bolt, 'approval.loadFailed')}</Alert
		>{/if}
	{#if (requests.current?.length ?? 0) > 0}<ApprovalPanel {ctx}
			requests={requests.current ?? []}
			on_outcome={() => {
				fork(requests.refetch());
			}}
		/>
	{:else if !requests.loading}<EmptyState
			icon="shield"
			read="empty"
			title={msg(bolt, 'record.no_approval')}
			hint={msg(bolt, 'record.noApprovalHint'
			)}
		/>{/if}
{/snippet}

{#snippet tools()}
	<!-- record / approval: which body the record shows; icon toggles beside full screen, not content tabs -->
	{#if live !== null}
		<div
			class="flex items-center gap-0.5"
			role="group"
			aria-label={msg(bolt, 'record.show')}
			data-record-toggle
		>
			{#each [{ key: 'record', glyph: 'file', text: msg(bolt, 'record.tab.record') }, { key: 'approval', glyph: 'shield', text: msg(bolt, 'record.tab.approval') }] as const as t (t.key)}
				<button
					type="button"
					aria-pressed={pane === t.key}
					aria-label={t.text}
					title={t.text}
					data-record-pane={t.key}
					onclick={() => (pane = t.key)}
					class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 aria-pressed:bg-muted aria-pressed:text-foreground relative grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
				>
					<Glyph name={t.glyph} class="size-4" />
					{#if t.key === 'approval' && pending_approval}<span
							class="bg-brand ring-popover absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2"
							aria-hidden="true"
						></span>{/if}
				</button>
			{/each}
			{#if latest >= 1}<RecordTimeline {ctx}
					{of}
					{latest}
					{viewing}
					{history}
					config={historyConfig}
					onload={() => (wanted = true)}
					onpick={pick}
				/>{/if}
		</div>
	{/if}
{/snippet}

{#snippet pastPill(revision: number)}
	<!-- a past revision is read-only; back to current is the live, editable record -->
	<div
		class="border-brand/25 bg-brand/10 text-brand-text flex w-fit max-w-full items-center gap-2 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
		role="status"
		data-record-past={revision}
	>
		<Glyph name="history" class="size-3.5 shrink-0" />
		<span class="truncate"
			>{msg(bolt, 'record.viewingRevision', {
				n: String(revision),
				when: format({ kind: 'instant' }, String(historical?.at ?? ''), {
					locale: bolt.locale,
					zone: kinds.zone
				})
			})}</span
		>
		{#if historical !== null && historical.incompatible.length > 0}<Badge variant="warning"
				>{msg(bolt, 'record.historyInvalid')}</Badge
			>{/if}
		<button
			type="button"
			class="hover:bg-brand/15 focus-visible:ring-ring/40 shrink-0 rounded-full px-2 py-0.5 font-medium focus-visible:ring-2 focus-visible:outline-none"
			data-record-back
			onclick={() => pick(null)}>{msg(bolt, 'record.backToCurrent')}</button
		>
		{#if canRestore}<button
				type="button"
				class="bg-brand/15 hover:bg-brand/25 focus-visible:ring-ring/40 shrink-0 rounded-full px-2 py-0.5 font-medium focus-visible:ring-2 focus-visible:outline-none"
				data-record-restore
				onclick={() => {
					previewOf = viewing;
					confirming = true;
				}}>{msg(bolt, 'record.restore')}</button
			>{/if}
	</div>
	{#if restoring !== null}{@render restoreDialog(restoring)}{/if}
{/snippet}

{#snippet historicalRecord(snapshot: HistorySnapshot)}
	{#if snapshot.incompatible.length > 0}<Alert data-history-invalid
			>{msg(bolt, 'record.historyInvalidRaw'
			)}</Alert
		>{/if}
	<section
		class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2"
		aria-label={msg(bolt, 'record.historicalRecord')}
		data-history-schema={snapshot.schema_version}
	>
		{#each historicalFields(snapshot) as [field, value] (field)}
			{@const archived = historicalValue(snapshot.fields[field], value)}
			<div class="flex min-w-0 flex-col gap-1" data-history-field={field} data-field={field}>
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-muted-foreground text-xs"
						>{snapshot.fields[field]?.label ?? humanize(field)}</span
					>
					{#if snapshot.incompatible.includes(field)}<Badge
							variant="warning"
							data-history-incompatible={field}
							>{msg(bolt, 'record.historyUncompatible')}</Badge
						>{/if}
				</div>
				<Value {ctx}
					value={archived.value}
					kind={archived.kind}
					row={snapshot.values}
					name={field}
					link={false}
				/>
			</div>
		{/each}
	</section>
{/snippet}

{#snippet restoreDialog(p: RestorePreview)}
	<!-- the preview: each own field it writes (current → this version) and each it leaves, with why -->
	<Dialog.Root bind:open={confirming}>
		<Dialog.Content class="max-w-lg" data-restore-preview={p.revision}>
			<Dialog.Header>
				<Dialog.Title
					>{msg(bolt, 'record.restoreTitle', {
						n: p.revision
					})}</Dialog.Title
				>
				<Dialog.Description
					>{msg(bolt, 'record.restoreHint'
					)}</Dialog.Description
				>
			</Dialog.Header>
			{#if p.changes.length === 0}<p class="text-muted-foreground text-sm" data-restore-nothing>
					{msg(bolt, 'record.restoreNothing'
					)}
				</p>{/if}
			<ul class="flex flex-col gap-2 text-sm" data-restore-changes>
				{#each p.changes as c (c.field)}<li
						class="grid grid-cols-[8rem_1fr] items-baseline gap-2"
						data-restore-field={c.field}
					>
						<span class="text-muted-foreground truncate">{label(bolt, of, c.field)}</span>
						<span class="flex min-w-0 flex-wrap items-baseline gap-1.5">
							<span class="text-muted-foreground line-through"
								><Value {ctx}
									value={c.current}
									kind={exposure?.fields[c.field]}
									name={c.field}
									dense
								/></span
							>
							<Glyph name="right" class="size-3 shrink-0" />
							<Value {ctx} value={c.restored} kind={exposure?.fields[c.field]} name={c.field} dense />
							{#if c.approval}<Badge variant="warning"
									>{msg(bolt, 'record.restoreApproval')}</Badge
								>{/if}
						</span>
					</li>{/each}
			</ul>
			{#if p.skipped.length > 0}
				<p class="text-muted-foreground text-xs font-medium">
					{msg(bolt, 'record.restoreSkipped')}
				</p>
				<ul class="flex flex-col gap-1 text-xs" data-restore-skipped>
					{#each p.skipped as c (c.field)}<li
							class="grid grid-cols-[8rem_1fr] gap-2"
							data-restore-skip={c.field}
							data-reason={c.reason}
						>
							<span class="text-muted-foreground truncate">{label(bolt, of, c.field)}</span>
							<span class="flex min-w-0 flex-wrap items-center gap-2">
								{#if c.reason === 'incompatible' || c.reason === 'definition_changed'}<Badge
										variant="warning">{skipText(bolt, c.reason)}</Badge
									><Value {ctx} value={c.restored} dense />
								{:else}{skipText(bolt, c.reason)}{/if}
							</span>
						</li>{/each}
				</ul>
			{/if}
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (confirming = false)}
					>{msg(bolt, 'record.cancel')}</Button
				>
				{#if p.changes.length > 0}<Button
						disabled={restorePending}
						data-restore-confirm
						onclick={() => restore(p)}>{msg(bolt, 'record.restore')}</Button
					>{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/snippet}

{#snippet skeleton()}
	<!-- the record's shape while it loads : a header, the tab strip and a grid of fields -->
	<div
		class="flex flex-col gap-4"
		role="status"
		aria-busy="true"
		aria-label={msg(bolt, 'view.loading')}
		data-read="loading"
	>
		<div class="bg-muted h-5 w-48 animate-pulse rounded motion-reduce:animate-none"></div>
		<div class="flex gap-4 border-b pb-2">
			{#each [16, 14, 12] as w (w)}<div
					class="bg-muted h-3.5 animate-pulse rounded motion-reduce:animate-none"
					style="width:{w * 4}px"
				></div>{/each}
		</div>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{#each [0, 1, 2, 3, 4, 5] as i (i)}<div class="flex flex-col gap-1.5">
					<div class="bg-muted h-3 w-20 animate-pulse rounded motion-reduce:animate-none"></div>
					<div class="bg-muted h-4 w-3/4 animate-pulse rounded motion-reduce:animate-none"></div>
				</div>{/each}
		</div>
	</div>
{/snippet}

{#snippet failure(text: string)}
	<Alert variant="destructive" data-read="error"
		><Glyph name="alert" class="size-4" />
		<p class="text-sm break-words">{text}</p></Alert
	>
{/snippet}

{#snippet runsTab()}
	<div class="flex flex-col gap-3">
		{#each runs as r (r.automation)}<RunsFor {...r} />{/each}
		{#if noRuns}<p class="text-muted-foreground text-sm" data-read="empty">
				{msg(bolt, 'run.none')}
			</p>{/if}
	</div>
{/snippet}

{#snippet content()}
	{#if createRequest}
		{@render approval()}
	{:else if mode !== 'create' && live === null && requests.loading}
		{@render skeleton()}
	{:else if shownPast === null && controller?.capabilities === null && bolt.record_capabilities !== undefined}
		<EmptyState
			icon="lock"
			read="not_found"
			title={msg(bolt, 'record.not_found')}
		/>
	{:else if (mode === 'create' || live !== null) && controller === null && exposure !== undefined}
		{@render skeleton()}
	{:else if Representation && view}
		<!-- a representation chunk that fails to load says which model's view and why -->
		{#await Representation}{@render skeleton()}{:then R}{#key shownPast}<R
					{view}
					{ctx}
				/>{/key}{:catch e}{@render failure(
				msg(bolt, 'record.viewFailed', {
					model: of,
					cause: e instanceof Error ? e.message : String(e)
				})
			)}{/await}
	{:else if mode !== 'create' && loaded.kind === 'loading'}
		{@render skeleton()}
	{:else if (mode !== 'create' && loaded.kind === 'ready' && row === null) || loaded.kind === 'noAccess'}
		<EmptyState
			icon="lock"
			read="not_found"
			title={msg(bolt, 'record.not_found')}
		/>
	{:else if loaded.kind === 'error'}
		{@render failure(loaded.message)}
	{:else}
		{#if mode === 'create' || tabItems.length === 1}{@render body()}
		{:else if nested && !sameRecord}{@render body()}{#if approvalId !== null}{@render approval()}{/if}
		{:else}<Tabs
				tabs={tabItems}
				value={lastTab.get(`${of}/${id}`)}
				on_value_change={(v) => lastTab.set(`${of}/${id}`, v)}
			/>{/if}
	{/if}
{/snippet}

{#if framed}
	<article
		class="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden"
		data-view="record"
		use:contentMotion
		data-model={of}
		data-held={approvalId ?? undefined}
	>
		{#if page}
			<!-- Page and sheet headers use the same authored contribution; neither belongs to the scrollable body. -->
			<header class="flex shrink-0 flex-col" data-record-chrome>
				{#if pageEyebrow}<span class="text-micro text-muted-foreground truncate leading-4">{pageEyebrow}</span>{/if}
				<div class="flex flex-wrap items-center gap-x-2">
					<div class="min-w-0 flex-1">{@render pageHead?.()}</div>
					{#if owner}{@render tools()}{/if}
				</div>
			</header>
		{:else if toSheet === undefined}<header class="shrink-0">{@render frameHead()}</header>{/if}
		{#if owner && viewing !== null}<div class="shrink-0">{@render pastPill(viewing)}</div>{/if}
		{#if owner && historyError !== null}<Alert variant="destructive" class="shrink-0" role="alert">{historyError}</Alert>{/if}
		{#if onApproval}
			<!-- Approval decisions remain independent of a selected historical record. -->
			<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-record-main>
				{@render approval()}
			</div>
		{/if}
		<!-- Keep record forms mounted across the approval toggle, and disable every historical record action. -->
		<fieldset
			disabled={viewing !== null || shownPast !== null}
			class={onApproval ? 'hidden' : 'm-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto border-0 p-0'}
			data-record-main={onApproval ? undefined : ''}
		>
			{#if permissionError}<Alert variant="destructive" role="alert">{permissionError}</Alert>{/if}
			{#if owner && historical !== null && (historical.incompatible.length > 0 || past === null)}{@render historicalRecord(historical)}
			{:else}{@render content()}{/if}
		</fieldset>
		<footer class="flex min-h-12 shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-3" data-record-foot>
			<fieldset disabled={viewing !== null || shownPast !== null} class="contents">
				{#if !onApproval && !createRequest && (mode === 'create' || live !== null)}{@render (decoration?.foot ?? foot)()}{/if}
			</fieldset>
		</footer>
	</article>
{:else}
	<!-- A nested shell supplies body/tabs and contributes chrome, without another native frame or footer. -->
	<div class="flex h-full min-h-0 min-w-0 flex-col gap-3">
		{#if permissionError}<Alert variant="destructive" role="alert">{permissionError}</Alert>{/if}
		{#if onApproval}{@render approval()}{:else}{@render content()}{/if}
	</div>
{/if}
