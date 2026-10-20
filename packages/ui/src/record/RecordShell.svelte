<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { CollectionKey, Row } from '../collection/types.js';
	import type { Outcome } from '../client/contract.js';
	import type { FormProps } from '../form/form.svelte';
	import type { RunsForProps } from '../runs/RunsFor.svelte';
	import type { RecordSection } from '../form/section.svelte';
	import type { RecordHistoryConfig } from './history.js';
	export type { RecordHistoryConfig, RecordHistorySource } from './history.js';

	/** An authored tab; a `keepAlive` tab stays mounted while hidden, so a form inside it keeps its state. */
	export type RecordTab = {
		name: string;
		title: string;
		body: Snippet;
		icon?: string;
		keepAlive?: true;
	};
	/** The props of `RecordShell`, typed by the collection `of`. */
	export type RecordShellProps<C = CollectionKey> = {
		of: C;
		/** The stored row; absent with `mode="create"`. */
		id?: FormProps<C>['id'];
		mode?: 'view' | 'edit' | 'create';
		/** Create mode: the pre-filled values (`{ [row], [col] }` from a Matrix cell, a page's scope). */
		values?: FormProps<C>['values'];
		/** Generated view: create offers these beyond `values`' keys; update shows only these, in this order (else every field). */
		fields?: FormProps<C>['fields'];
		/**
		 * Generated view (read, edit, create): the fields grouped into collapsible `Section`s, in order; fields no section
		 * lists follow in one untitled, always-open group. Titles and summaries arrive translated.
		 */
		sections?: readonly RecordSection[];
		/** The heading; default the record's label fields by kind (a create: "New <singular>"). */
		title?: string;
		/** A line under the heading: text, or field names shown by kind (`['customer', 'due_on']` → `Acme · Jan 2, 2026`). */
		subtitle?: string | readonly string[];
		/** Iconify id inside the state pill. */
		icon?: string;
		/** The state pill's text. */
		badge?: string;
		/** One sentence behind the pill. */
		hint?: string;
		/** Placed in the record header (serial-pcn's "Approve as FAE"). */
		actions?: Snippet;
		/** Beside the label in the chrome (color-matching's timeline trigger). */
		trailing?: Snippet;
		tabs?: readonly RecordTab[];
		/** Related records included in the native History popover, scoped by read queries. */
		history?: RecordHistoryConfig;
		/** Runs whose subject is this record, shown as a Runs tab. */
		runs?: readonly RunsForProps[];
		/**
		 * The representation's body; absent → the representation registered for `of`, else the generated view. It receives
		 * the record shown — the scrubbed revision while one is picked — as `useRecordView()` also does beneath.
		 */
		children?: Snippet<[RecordView]>;
		onDone?: (outcome: Outcome) => void;
	};
	// the tab each record was last on, for this page's life: reopening a record after a child record closes (a trial
	// opened from its project's Trials tab) lands where the person left it, not back on the first tab
	const lastTab = new Map<string, string>();
</script>

<script lang="ts" generics="C extends CollectionKey">
	import { Effect } from 'effect';
	import { fork, query } from '../effect/index.js';
	import { contentMotion } from '../form/content-motion.js';
	// The record frame (§3.6, X-20): label, state pill, actions, the UI tab, authored tabs and Runs. One tab row: a nested
	// shell shows its body only, and a tab a page's own strip already shows is not repeated. The record's header carries
	// the record/approval toggle for native proposals and the history scrubber (rule 17): a past revision shows
	// read-only in the body. Without a body it renders the collection's `+representation.svelte` or the generated view.
	import Icon from '@iconify/svelte';
	import { getContext, onDestroy, setContext, untrack } from 'svelte';
	import { SHEET_GUARD, type SheetGuard } from '../primitives/sheet/dismiss.js';
	import { Badge } from '../primitives/badge/index.js';
	import { Button } from '../primitives/button/index.js';
	import { TAB_LEVEL, Tabs, type TabItem } from '../primitives/tabs/index.js';
	import Form from '../form/form.svelte';
	import ChildGrid from '../relations/ChildGrid.svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import { useKinds } from '../kinds/context.js';
	import { fieldsText, format } from '../kinds/kind.js';
	import { openRecord } from './navigation.js';
	import { provideCollection } from '../collection/context.js';
	import { provideRecordView, representations } from './context.js';
	import { useBolt } from '../client/context.js';
	import { type RecordView, type RestorePreview } from './types.js';
	import * as Dialog from '../primitives/dialog/index.js';
	import Value from '../cell/Value.svelte';
	import { actOutcome } from '../actions/outcome.js';
	import ApprovalPanel from '../approval/ApprovalPanel.svelte';
	import { approvalOf, lockText } from '../approval/row.js';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { notify } from '../actions/notify.js';
	import { uiText } from '../primitives/utils.js';
	import { watch as changes } from 'runed';
	import {
		FormState,
		provideRecordController,
		useRecordController
	} from '../form/form-state.svelte.js';
	import { formSpec, locked } from '../form/draft.js';
	import { watch } from '../read/live.svelte.js';
	import { checkpoints, skipText, type Checkpoint } from './history.js';
	import { label, lowerLead, msg, singular } from '../text/messages.js';
	import { listSelect, refLabel, refOf, unref, type Refs } from '../relations/select.js';
	import { RUNS_GROUP } from '../runs/RunsFor.svelte';
	import RecordTimeline from './RecordTimeline.svelte';
	import RunsFor from '../runs/RunsFor.svelte';

	let {
		of,
		id,
		mode = 'view',
		values = {},
		fields = [],
		sections = [],
		title,
		subtitle,
		icon,
		badge,
		hint,
		actions,
		trailing,
		tabs = [],
		history: historyOptions,
		runs = [],
		children,
		onDone
	}: RecordShellProps<C> = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const formText = uiText();
	provideCollection(() => of);

	// a representation that renders <RecordShell of={same}> without a body gets the generated view, not itself again;
	// a shell inside a framed shell (a record within a record's tab) shows its body only: a record view has one tab row
	const INSIDE = 'ui.views.record';
	type StoredRecord = NonNullable<FormProps<C>['record']> & Row;
	type Scrub = { readonly past: StoredRecord | null };
	const parent = getContext<
		| {
				of: string;
				framed: boolean;
				scrub?: Scrub;
				history?: { set(config: RecordHistoryConfig): void };
		  }
		| undefined
	>(INSIDE);
	const inside = parent?.of;
	const nested = $derived(parent?.framed === true);
	// the outermost shell of a stored record owns its header chrome: the toggle, the scrubber and the revision shown;
	// its own representation's shell (same collection) shows that revision too
	const owner = untrack(
		() => mode !== 'create' && id !== undefined && inside !== of && parent?.framed !== true
	);
	const scrub: Scrub | undefined = owner
		? {
				get past() {
					return past;
				}
			}
		: inside === untrack(() => of)
			? parent?.scrub
			: undefined;
	let historyConfig = $state<RecordHistoryConfig>({});
	$effect(() => {
		if (historyOptions === undefined) return;
		if (owner) historyConfig = historyOptions;
		else if (inside === of) parent?.history?.set(historyOptions);
	});
	setContext(INSIDE, {
		of: untrack(() => of),
		get framed() {
			return framed;
		},
		scrub,
		history: owner
			? {
					set(config: RecordHistoryConfig) {
						historyConfig = config;
					}
				}
			: parent?.history
	});
	// the tab strips around this record (a page's own tabs): an authored tab they already show is not repeated
	const around = getContext<{ shown: readonly string[] } | undefined>(TAB_LEVEL);
	const registry = representations();
	// the representation's module loads on first use, so importing it (and `$bolt`) waits for a record to show
	const Representation = $derived(
		inside === of || children !== undefined ? undefined : registry?.[of]?.().then((m) => m.default)
	);

	const record = watch(() =>
		mode !== 'create' && id !== undefined ? bolt.live(bolt.get<StoredRecord | null>(of, id)) : null
	);
	const live = $derived(record.state.kind === 'ready' ? record.state.value : null);
	// ── the scrubber (owner only): the revision the body shows, read as of that revision (L-BOLT-181); null is live ──
	let viewing = $state<number | null>(null);
	let past = $state<StoredRecord | null>(null);
	let asked = 0;
	const latest = $derived(typeof live?.['revision'] === 'number' ? live['revision'] : 0);
	function pick(r: number | null) {
		const n = ++asked;
		if (r === null || r >= latest || id === undefined) {
			viewing = null;
			past = null;
			return;
		}
		viewing = r;
		const back = () => {
			if (n === asked) {
				viewing = null;
				past = null;
			}
		};
		// a pruned create folds to null: there is nothing to show, so the live record stays
		fork(
			bolt.get<StoredRecord | null>(of, id, undefined, { revision: r }).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (n !== asked) return;
						if (value === null) back();
						else past = value;
					})
				)
			),
			back
		);
	}
	// ── per-record restore (rule 17): the viewed revision's own fields as a new latest revision, never a rollback ──
	// the preview is read when the person asks for it, not on every scrub step (each one is an act)
	const canRestore = $derived(
		owner && viewing !== null && past !== null && id !== undefined && bolt.restore !== undefined
	);
	let previewOf = $state<number | null>(null);
	const restorable = query(() => {
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
			actOutcome(client.run(p.collection, p.record, p.revision, p.live)).pipe(
				Effect.tap((o) =>
					Effect.sync(() => {
						restorePending = false;
						confirming = false;
						notify(
							bolt,
							o,
							msg(bolt, 'record.restored', 'Restored revision {n}', { n: p.revision })
						);
						if (o.kind === 'pendingApproval')
							submitted = { collection: of, record: id, requestId: o.requestId };
						if (o.kind === 'committed' || o.kind === 'pendingApproval') pick(null);
					})
				)
			)
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
	const row = $derived(shownPast ?? live);
	const view = $derived.by<RecordView | null>(() =>
		mode === 'create'
			? { collection: of, mode: 'create', values }
			: row === null
				? null
				: {
						collection: of,
						mode: shownPast !== null ? 'view' : controller?.mode === 'edit' ? 'edit' : 'view',
						record: row,
						...(shownPast !== null || controller?.capabilities == null
							? {}
							: { capabilities: controller.capabilities })
					}
	);
	let submitted = $state<{
		collection: string;
		record: string | undefined;
		requestId: string;
	} | null>(null);
	const submittedId = $derived(
		submitted?.collection === of && submitted.record === id ? submitted.requestId : null
	);
	const requests = query(() => {
		void latest;
		if (submittedId !== null)
			return (bolt.approvals.get?.(submittedId) ?? Effect.succeed(null)).pipe(
				Effect.map((request) => (request === null ? [] : [request]))
			);
		if (mode !== 'create' && record.state.kind !== 'ready') return null;
		return id === undefined
			? Effect.succeed([])
			: (bolt.approvals.list?.({ collection: of, records: [id], all: true }) ?? Effect.succeed([]));
	});
	const approvalId = $derived(submittedId ?? requests.current?.[0]?.id ?? null);
	const openRequest = $derived(
		(requests.current ?? []).find(
			(request) => request.status === 'ONGOING' || request.status === 'CHANGES_REQUESTED'
		) ?? null
	);
	const pendingApproval = $derived(openRequest !== null);
	// A create rolled back by rejection or withdrawal has no row any more; its request remains readable.
	const createRequest = $derived(
		mode !== 'create' &&
			live === null &&
			(requests.current ?? []).some(
				(request) =>
					request.action === 'create' && request.collection === of && request.record === id
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
	// Inside a sheet the record's label, pills and actions are the sheet's header (one header, not two); only the frame
	// that renders the article claims it, so a representation's own `RecordShell` does and the one around it does not.
	const framed = $derived(
		createRequest ||
			(!(Representation && view) &&
				!(mode !== 'create' && (record.state.kind !== 'ready' || row === null)))
	);
	const SHEET = Symbol.for('ui.sheet.header');
	const toSheet = getContext<((s: Snippet | null) => void) | undefined>(SHEET);
	setContext(
		SHEET,
		toSheet === undefined
			? undefined
			: (s: Snippet | null) => {
					if (!framed) toSheet(s);
				}
	);
	$effect(() => {
		if (toSheet === undefined || !framed) return;
		toSheet(head);
		return () => toSheet(null);
	});
	// the owner's toggle and scrubber sit in the sheet's title bar beside full screen and close; no shell below claims them
	const CHROME = Symbol.for('ui.sheet.chrome');
	const toChrome = getContext<((c: { tools: Snippet } | null) => void) | undefined>(CHROME);
	setContext(CHROME, undefined);
	$effect(() => {
		if (toChrome === undefined || !owner) return;
		toChrome({ tools });
		return () => toChrome(null);
	});

	// ── the generated view: a display grid by the catalog's kinds (else the row's own keys); edits and creates are `Form` ──
	const exposure = $derived(kinds.catalog?.[of]);
	// a section naming a field the collection does not have is ignored, said once to the author
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
	const inheritedController = useRecordController();
	let localController = $state<FormState | null>(null);
	const sharedController = $derived(
		inside === of &&
			inheritedController?.current?.spec.target.collection === of &&
			inheritedController.current.spec.target.id === id
	);
	const controller = $derived(
		sharedController ? (inheritedController?.current ?? localController) : localController
	);
	// the approval lock (the host's `underApproval` restriction): editing is refused, and the row says who may edit
	const underApproval = $derived(
		controller?.capabilities?.update.reasons.includes('underApproval') === true
	);
	const lockReason = $derived(lockText(bolt, approvalOf(row)));

	let capabilityRequest = 0;
	let permissionError = $state<string | null>(null);
	onDestroy(
		getContext<SheetGuard | undefined>(SHEET_GUARD)?.(
			() => localController !== null && (localController.dirty || localController.pending)
		) ?? (() => {})
	);
	provideRecordController({
		get current() {
			return controller;
		},
		get historical() {
			return shownPast !== null;
		}
	});
	changes([() => of, () => id, () => live, () => exposure], () => {
		if (sharedController) return;
		const spec = formSpec(of, exposure, mode === 'create' ? 'create' : 'update', id);
		if (spec === null || (mode !== 'create' && live === null)) return;
		const current = localController;
		if (current?.spec.target.collection !== of || current.spec.target.id !== id) {
			localController = new FormState(
				spec,
				live,
				Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
				(callable, input, options) => bolt.act(callable, input, options),
				{
					pendingApproval: formText('pendingApproval'),
					conflict: formText('conflict'),
					unknown: formText('unknown')
				},
				(field) => locked(exposure?.fields ?? {}, live)(field)
			);
			localController.onOutcome(done);
			if (mode !== 'create' && (mode !== 'edit' || spec.readonly)) localController.mode = 'view';
		} else {
			current.spec = spec;
			if (live !== null) current.refresh(live);
		}
		if (mode === 'create' || id === undefined || bolt.recordCapabilities === undefined) return;
		const target = localController;
		if (target === null) return;
		const request = ++capabilityRequest;
		const revision = live?.['revision'];
		target.expectCapabilities();
		permissionError = null;
		fork(
			bolt.recordCapabilities(of, id).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (request !== capabilityRequest || target !== localController) return;
						if (
							value !== null &&
							(value.collection !== of || value.id !== id || value.revision !== revision)
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
					permissionError = msg(
						bolt,
						'record.permissionsFailed',
						'Record permissions could not be loaded.'
					);
			}
		);
	});
	function beforeUnload(event: BeforeUnloadEvent) {
		if (localController !== null && (localController.dirty || localController.pending)) {
			event.preventDefault();
			event.returnValue = true;
		}
	}
	const editing = $derived(controller?.mode === 'edit');
	function done(o: Outcome) {
		notify(bolt, o);
		if (o.kind !== 'committed' && o.kind !== 'pendingApproval') return;
		// the created record is this collection's; an act's other writes (a transform's side rows) come first or last
		const mine = o.records.find((r) => r.collection === of);
		if (o.kind === 'pendingApproval') {
			submitted = { collection: of, record: id ?? mine?.id, requestId: o.requestId };
			pane = 'approval';
		}
		controller?.view();
		if (onDone) onDone(o);
		else if (mode === 'create' && mine !== undefined) openRecord(of, mine.id);
	}

	// the heading: the author's title, else the record's label fields by kind, else (a create, an unlabelled record) the
	// collection's label; above a record's own heading, the singular model label
	// a relation in the heading or subtitle reads as its target's label (a table cell's rule): one read of the record with
	// those targets' labels nested, never its id (blank until it arrives)
	const labelled = $derived(
		[...(exposure?.label ?? []), ...(typeof subtitle === 'object' ? subtitle : [])].filter(
			(f) => refLabel(kinds.catalog, of, f).length > 0
		)
	);
	const related = watch(() =>
		mode !== 'create' && id !== undefined && labelled.length > 0
			? bolt.live(bolt.get<Row | null>(of, id, listSelect(kinds.catalog, of, [], labelled)))
			: null
	);
	const refs = $derived.by<Refs>(() => {
		const r = related.state.kind === 'ready' ? related.state.value : null;
		if (r === null) return {};
		const resolved = unref(kinds.catalog, of, labelled, [r], bolt.locale)[0];
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
			: fieldsText(
					exposure.fields,
					{ ...row, ...Object.fromEntries(labelled.map((f) => [f, refs[f]?.text ?? null])) },
					fs,
					{
						locale: kinds.locale ?? bolt.locale,
						zone: kinds.zone,
						currency: kinds.currency,
						t: (k) => bolt.t(k),
						collection: of
					}
				);
	const heading = $derived(title ?? (mode !== 'create' ? shownAs(exposure?.label ?? []) : ''));
	const subline = $derived(
		typeof subtitle === 'string' ? subtitle : subtitle === undefined ? '' : shownAs(subtitle)
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
			title: msg(bolt, 'record.tab.record', 'Record'),
			icon: 'lucide:file-text',
			body,
			keepAlive: true
		},
		...tabs.filter((t) => !around?.shown.includes(t.name) && !around?.shown.includes(t.title)),
		...(runs.length > 0
			? [
					{
						name: 'runs',
						title: msg(bolt, 'record.tab.runs', 'Runs'),
						icon: 'lucide:play',
						body: runsTab
					}
				]
			: [])
	]);
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet head()}
	<div class="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap" data-record-head>
		<div class="mr-auto flex min-w-0 flex-col">
			{#if heading}<span class="text-micro text-muted-foreground truncate leading-4"
					>{singular(bolt, of)}</span
				>{/if}
			<div class="flex items-center gap-2">
				<h2 class="truncate text-sm leading-5 font-semibold">
					{heading ||
						(mode === 'create'
							? msg(bolt, 'record.new', 'New {what}', { what: lowerLead(singular(bolt, of)) })
							: label(bolt, of))}
				</h2>
				{#if badge || icon}<Badge variant="outline" title={hint}
						>{#if icon}<Icon {icon} class="size-3" />{/if}{badge ?? ''}</Badge
					>{/if}
				{#if pendingApproval}<Badge variant="warning" data-view="approval-badge"
						>{openRequest?.status === 'CHANGES_REQUESTED'
							? msg(bolt, 'approval.status.CHANGES_REQUESTED', 'Changes requested')
							: msg(bolt, 'record.pending', 'Under approval')}</Badge
					>{/if}
				{#if trailing}{@render trailing()}{/if}
			</div>
			{#if subline}<p class="text-muted-foreground truncate text-sm">{subline}</p>{/if}
		</div>
		{#if controller?.mode === 'view' && shownPast === null && exposure?.update !== undefined && controller.canSubmit}
			<Button size="sm" variant="outline" onclick={() => controller?.edit()}
				>{msg(bolt, 'record.edit', 'Edit')}</Button
			>
		{:else if controller?.mode === 'view' && shownPast === null && exposure?.update !== undefined && underApproval}
			<span class="text-meta" data-view="approval-lock">{lockReason}</span>
			<Button size="sm" variant="outline" disabled title={lockReason}
				>{msg(bolt, 'record.edit', 'Edit')}</Button
			>
		{/if}
		{#if controller?.mode === 'edit' && shownPast === null}
			<div
				class="inline-flex shrink-0 items-center gap-1"
				role="group"
				aria-label={msg(bolt, 'record.editing', 'Editing')}
			>
				<Button
					size="sm"
					variant="ghost"
					class="px-2.5 text-xs"
					disabled={controller.pending}
					onclick={() => {
						if (controller?.dirty && !confirm(formText('discardDraft'))) return;
						controller?.view();
					}}>{msg(bolt, 'record.cancel', 'Cancel')}</Button
				>
				<Button
					size="sm"
					class="px-2.5 text-xs"
					disabled={controller.pending || !controller.dirty || !controller.canSubmit}
					onclick={() => (controller === null ? undefined : fork(controller.submit()))}
					>{controller.pending
						? formText('saving')
						: controller.requestingApproval
							? msg(bolt, 'record.requestApproval', 'Request approval')
							: formText('save')}</Button
				>
			</div>
		{/if}
		{#if actions}{@render actions()}{/if}
	</div>
{/snippet}

{#snippet generated()}
	{#if mode === 'create'}
		<Form {of} mode="create" {values} {...fields.length > 0 ? { fields } : {}} {sections} />
	{:else if editing && id !== undefined && shownPast === null}
		<Form
			{of}
			mode="update"
			{id}
			record={row}
			{...fields.length > 0 ? { fields } : {}}
			{sections}
		/>
	{:else}
		<div data-view="record-generated">
			{#key shownPast}<Form
					{of}
					mode="update"
					{id}
					record={row}
					{...fields.length > 0 ? { fields } : {}}
					{sections}
					readonly
				/>{/key}
		</div>
	{/if}
	{#key controller}{#each Object.keys(controller?.spec.children ?? {}) as relation (relation)}
			<ChildGrid {of} {id} {relation} save="parent" />
		{/each}{/key}
{/snippet}

{#snippet body()}
	{#if children && view}{#key shownPast}{@render children(view)}{/key}
	{:else}{@render generated()}{/if}
{/snippet}

{#snippet approval()}
	{#if requests.error}<Alert variant="destructive" role="alert"
			>{msg(bolt, 'approval.loadFailed', 'Approval requests could not be loaded.')}</Alert
		>{/if}
	<!-- the record's approval history, oldest first: finished requests collapsed, the current (newest) one open -->
	{#each [...(requests.current ?? [])]
		.reverse()
		.filter((r) => r.id !== approvalId) as past (past.id)}
		<details class="rounded-md border p-2" data-request={past.id} data-status={past.status}>
			<summary class="cursor-pointer text-sm"
				>{msg(bolt, `approval.status.${past.status}`, past.status)} · {format(
					{ kind: 'instant' },
					past.at,
					{ locale: bolt.locale, zone: kinds.zone }
				)}</summary
			>
			<div class="mt-2"><ApprovalPanel requestId={past.id} /></div>
		</details>
	{/each}
	{#if approvalId !== null}<ApprovalPanel
			requestId={approvalId}
			revision={latest || undefined}
			onOutcome={() => {
				fork(requests.refetch());
			}}
		/>
	{:else}<EmptyState
			icon="shield"
			read="empty"
			title={msg(bolt, 'record.noApproval', 'No approval on this record')}
			hint={msg(
				bolt,
				'record.noApprovalHint',
				'When a change to this record needs approval, the request, its approvers and their decisions show here.'
			)}
		/>{/if}
{/snippet}

{#snippet tools()}
	<!-- record / approval: which body the record shows; icon toggles beside full screen, not content tabs -->
	{#if live !== null}
		<div
			class="flex items-center gap-0.5"
			role="group"
			aria-label={msg(bolt, 'record.show', 'Show')}
			data-record-toggle
		>
			{#each [{ key: 'record', glyph: 'file', text: msg(bolt, 'record.tab.record', 'Record') }, { key: 'approval', glyph: 'shield', text: msg(bolt, 'record.tab.approval', 'Approval') }] as const as t (t.key)}
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
					{#if t.key === 'approval' && pendingApproval}<span
							class="bg-brand ring-popover absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2"
							aria-hidden="true"
						></span>{/if}
				</button>
			{/each}
			{#if latest >= 1}<RecordTimeline
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

{#snippet pastPill(p: Row)}
	<!-- a past revision is read-only; back to current is the live, editable record -->
	<div
		class="border-brand/25 bg-brand/10 text-brand-700 dark:text-brand-400 flex w-fit max-w-full items-center gap-2 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
		role="status"
		data-record-past={viewing}
	>
		<Glyph name="history" class="size-3.5 shrink-0" />
		<span class="truncate"
			>{msg(bolt, 'record.viewingRevision', 'Viewing revision {n} · {when}', {
				n: String(p['revision'] ?? viewing ?? ''),
				when: format({ kind: 'instant' }, String(p['updated_at'] ?? p['created_at'] ?? ''), {
					locale: bolt.locale,
					zone: kinds.zone
				})
			})}</span
		>
		<button
			type="button"
			class="hover:bg-brand/15 focus-visible:ring-ring/40 shrink-0 rounded-full px-2 py-0.5 font-medium focus-visible:ring-2 focus-visible:outline-none"
			data-record-back
			onclick={() => pick(null)}>{msg(bolt, 'record.backToCurrent', 'Back to current')}</button
		>
		{#if canRestore}<button
				type="button"
				class="bg-brand/15 hover:bg-brand/25 focus-visible:ring-ring/40 shrink-0 rounded-full px-2 py-0.5 font-medium focus-visible:ring-2 focus-visible:outline-none"
				data-record-restore
				onclick={() => {
					previewOf = viewing;
					confirming = true;
				}}>{msg(bolt, 'record.restore', 'Restore this version')}</button
			>{/if}
	</div>
	{#if restoring !== null}{@render restoreDialog(restoring)}{/if}
{/snippet}

{#snippet restoreDialog(p: RestorePreview)}
	<!-- the preview: each own field it writes (current → this version) and each it leaves, with why -->
	<Dialog.Root bind:open={confirming}>
		<Dialog.Content class="max-w-lg" data-restore-preview={p.revision}>
			<Dialog.Header>
				<Dialog.Title
					>{msg(bolt, 'record.restoreTitle', 'Restore revision {n}?', {
						n: p.revision
					})}</Dialog.Title
				>
				<Dialog.Description
					>{msg(
						bolt,
						'record.restoreHint',
						'These fields take this version’s values as a new revision. Every later revision stays in history.'
					)}</Dialog.Description
				>
			</Dialog.Header>
			{#if p.changes.length === 0}<p class="text-muted-foreground text-sm" data-restore-nothing>
					{msg(
						bolt,
						'record.restoreNothing',
						'Nothing to restore: this version’s own fields match the record, or none can be written.'
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
								><Value
									value={c.current}
									kind={exposure?.fields[c.field]}
									name={c.field}
									dense
								/></span
							>
							<Glyph name="right" class="size-3 shrink-0" />
							<Value value={c.restored} kind={exposure?.fields[c.field]} name={c.field} dense />
							{#if c.approval}<Badge variant="warning"
									>{msg(bolt, 'record.restoreApproval', 'Needs approval')}</Badge
								>{/if}
						</span>
					</li>{/each}
			</ul>
			{#if p.skipped.length > 0}
				<p class="text-muted-foreground text-xs font-medium">
					{msg(bolt, 'record.restoreSkipped', 'Not restored')}
				</p>
				<ul class="flex flex-col gap-1 text-xs" data-restore-skipped>
					{#each p.skipped as c (c.field)}<li
							class="grid grid-cols-[8rem_1fr] gap-2"
							data-restore-skip={c.field}
							data-reason={c.reason}
						>
							<span class="text-muted-foreground truncate">{label(bolt, of, c.field)}</span>
							<span>{skipText(bolt, c.reason)}</span>
						</li>{/each}
				</ul>
			{/if}
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (confirming = false)}
					>{msg(bolt, 'record.cancel', 'Cancel')}</Button
				>
				{#if p.changes.length > 0}<Button
						disabled={restorePending}
						data-restore-confirm
						onclick={() => restore(p)}>{msg(bolt, 'record.restore', 'Restore this version')}</Button
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
		aria-label={msg(bolt, 'view.loading', 'Loading')}
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
				{msg(bolt, 'run.none', 'No runs yet')}
			</p>{/if}
	</div>
{/snippet}

{#snippet content()}
	{#if createRequest}
		{@render approval()}
	{:else if mode !== 'create' && live === null && requests.loading}
		{@render skeleton()}
	{:else if shownPast === null && controller?.capabilities === null && bolt.recordCapabilities !== undefined}
		<EmptyState
			icon="lock"
			read="notFound"
			title={msg(bolt, 'record.notFound', 'Not found or no access')}
		/>
	{:else if (mode === 'create' || live !== null) && controller === null && exposure !== undefined}
		{@render skeleton()}
	{:else if Representation && view}
		<!-- a representation chunk that fails to load says which model's view and why (final-ui §7.2, L-BOLT-515) -->
		{#await Representation}{@render skeleton()}{:then R}{#key shownPast}<R
					{view}
				/>{/key}{:catch e}{@render failure(
				msg(bolt, 'record.viewFailed', 'The {model} view could not be loaded: {cause}', {
					model: of,
					cause: e instanceof Error ? e.message : String(e)
				})
			)}{/await}
	{:else if mode !== 'create' && record.state.kind === 'loading'}
		{@render skeleton()}
	{:else if (mode !== 'create' && record.state.kind === 'ready' && row === null) || record.state.kind === 'noAccess'}
		<EmptyState
			icon="lock"
			read="notFound"
			title={msg(bolt, 'record.notFound', 'Not found or no access')}
		/>
	{:else if record.state.kind === 'error'}
		{@render failure(record.state.message)}
	{:else}
		<article
			class={[
				'flex min-h-0 min-w-0 flex-col gap-3',
				(inside === undefined || inside === of) && 'h-full'
			]}
			data-view="record"
			use:contentMotion
			data-collection={of}
			data-held={approvalId ?? undefined}
		>
			{#if toSheet === undefined}<header>{@render head()}</header>{/if}
			{#if permissionError}<Alert variant="destructive" role="alert">{permissionError}</Alert>{/if}
			{#if mode === 'create' || tabItems.length === 1}{@render body()}
			{:else if nested}{@render body()}{#if approvalId !== null && inside !== of}{@render approval()}{/if}
			{:else}<Tabs
					tabs={tabItems}
					value={lastTab.get(`${of}/${id}`)}
					onValueChange={(v) => lastTab.set(`${of}/${id}`, v)}
				/>{/if}
		</article>
	{/if}
{/snippet}

{#if owner}
	{#if toChrome === undefined && live !== null}
		<!-- a page-level record: the actions above it -->
		<div class="mb-3 flex justify-end" data-record-chrome>{@render tools()}</div>
	{/if}
	{#if past !== null}<div class="mb-3">{@render pastPill(past)}</div>{/if}
	{#if onApproval}{@render approval()}{/if}
	<!-- a past revision is read-only: every control beneath is disabled (a representation remounts per revision, so its forms start from it) -->
	<fieldset disabled={past !== null} class={onApproval ? 'hidden' : 'contents'}>
		{@render content()}
	</fieldset>
{:else if onApproval}{@render approval()}
{:else}{@render content()}{/if}
