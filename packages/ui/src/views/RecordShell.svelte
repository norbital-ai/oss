<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { CollectionKey, IdOf, InsertOf, Outcome, RecordFieldOf, Row } from './bolt.js';
	import type { RunsForProps } from './RunsFor.svelte';

	/** An authored tab; a `keepAlive` tab stays mounted while hidden, so a form inside it keeps its state. */
	export type RecordTab = { name: string; title: string; body: Snippet; icon?: string; keepAlive?: true };
	/** The props of `RecordShell`, typed by the collection `of`. */
	export type RecordShellProps<C = CollectionKey> = {
		of: C;
		/** The stored row; absent with `mode="create"`. */
		id?: IdOf<C>;
		mode?: 'update' | 'create';
		/** Create mode: the pre-filled values (`{ [row], [col] }` from a Matrix cell, a page's scope). */
		values?: Partial<InsertOf<C>>;
		/** Generated view: create offers these beyond `values`' keys; update shows only these, in this order (else every field). */
		fields?: readonly RecordFieldOf<C>[];
		title?: string;
		subtitle?: string;
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
		/** Runs whose subject is this record, shown as a Runs tab. */
		runs?: readonly RunsForProps[];
		/**
		 * The representation's body; absent → the representation registered for `of`, else the generated view. It receives
		 * the record shown — the scrubbed revision while one is picked — as `useRecordView()` also does beneath.
		 */
		children?: Snippet<[RecordView]>;
		onDone?: (outcome: Outcome) => void;
	};
</script>

<script lang="ts">
	// The record frame (§3.6, X-20): label, state pill, actions, the UI tab, authored tabs and Runs. One tab row: a nested
	// shell shows its body only, and a tab a page's own strip already shows is not repeated. The record's header carries
	// the record/approval toggle (§3.8, while the row is held) and the history scrubber (rule 17): a past revision shows
	// read-only in the body. Without a body it renders the collection's `+representation.svelte` or the generated view.
	import Icon from '@iconify/svelte';
	import { getContext, setContext, untrack } from 'svelte';
	import { Badge } from '../primitives/badge/index.js';
	import { Button } from '../primitives/button/index.js';
	import { TAB_LEVEL, Tabs, type TabItem } from '../primitives/tabs/index.js';
	import Form from '../form/form.svelte';
	import RecordInfo from '../form/record-info.svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import { useKinds } from '../kinds/context.js';
	import { openRecord, provideRecordView, representations, useBolt, type RecordView } from './bolt.js';
	import { humanize } from './model.js';
	import ApprovalPanel from './ApprovalPanel.svelte';
	import EmptyState from './EmptyState.svelte';
	import Glyph from './Glyph.svelte';
	import { notify } from './notify.js';
	import { watch } from './live.svelte.js';
	import { checkpoints, label, msg, show, type Checkpoint } from './model.js';
	import RecordTimeline from './RecordTimeline.svelte';
	import RunsFor from './RunsFor.svelte';
	import Value from './Value.svelte';

	let { of, id, mode = 'update', values = {}, fields = [], title, subtitle, icon, badge, hint, actions, trailing, tabs = [], runs = [], children, onDone }: RecordShellProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const SYSTEM = new Set(['id', 'revision', 'approval_id', 'created_at', 'created_by', 'updated_at', 'updated_by']);

	// a representation that renders <RecordShell of={same}> without a body gets the generated view, not itself again;
	// a shell inside a framed shell (a record within a record's tab) shows its body only: a record view has one tab row
	const INSIDE = 'ui.views.record';
	type Scrub = { readonly past: Row | null };
	const parent = getContext<{ of: string; framed: boolean; scrub?: Scrub } | undefined>(INSIDE);
	const inside = parent?.of;
	const nested = $derived(parent?.framed === true);
	// the outermost shell of a stored record owns its header chrome: the toggle, the scrubber and the revision shown;
	// its own representation's shell (same collection) shows that revision too
	const owner = untrack(() => mode === 'update' && id !== undefined && inside !== of && parent?.framed !== true);
	const scrub: Scrub | undefined = owner ? { get past() { return past; } } : inside === untrack(() => of) ? parent?.scrub : undefined;
	setContext(INSIDE, { of: untrack(() => of), get framed() { return framed; }, scrub });
	// the tab strips around this record (a page's own tabs): an authored tab they already show is not repeated
	const around = getContext<{ shown: readonly string[] } | undefined>(TAB_LEVEL);
	const registry = representations();
	// the representation's module loads on first use, so importing it (and `$bolt`) waits for a record to show
	const Representation = $derived(inside === of || children !== undefined ? undefined : registry?.[of]?.().then((m) => m.default));

	const record = watch(() => mode === 'update' && id !== undefined ? bolt.live(bolt.get<Row | null>(of, id)) : null);
	const live = $derived(record.state.kind === 'ready' ? record.state.value : null);
	// ── the scrubber (owner only): the revision the body shows, read as of that revision (L-BOLT-181); null is live ──
	let viewing = $state<number | null>(null);
	let past = $state<Row | null>(null);
	let asked = 0;
	const latest = $derived(typeof live?.['revision'] === 'number' ? live['revision'] : 0);
	function pick(r: number | null) {
		const n = ++asked;
		if (r === null || r >= latest || id === undefined) { viewing = null; past = null; return; }
		viewing = r;
		const back = () => { if (n === asked) { viewing = null; past = null; } };
		// a pruned create folds to null: there is nothing to show, so the live record stays
		Promise.resolve(bolt.get<Row | null>(of, id, undefined, { revision: r })).then((p) => { if (n !== asked) return; if (p === null) back(); else past = p; }, back);
	}
	// the revisions' details load on the scrubber's first hover or focus, and again once the record moves on
	let wanted = $state(false);
	const history = $derived.by<Promise<readonly Checkpoint[]> | null>(() => {
		if (!wanted || id === undefined) return null;
		void latest;
		return Promise.resolve(bolt.history(of, id)).then(checkpoints);
	});
	const shownPast = $derived(owner ? past : scrub?.past ?? null);
	const row = $derived(shownPast ?? live);
	const view = $derived<RecordView | null>(mode === 'create' ? { collection: of, mode: 'create', values } : row === null ? null : { collection: of, mode: 'update', record: row });
	const heldBy = $derived(live !== null && typeof live['approval_id'] === 'string' ? live['approval_id'] : null);
	/** The header toggle: the record's own UI, or its approval while it is held. */
	let pane = $state<'record' | 'approval'>('record');
	const onApproval = $derived(pane === 'approval');
	// the body (children, `Form`s, a representation's tabs) reads the record shown, not the live one, while scrubbed
	provideRecordView({ get current() { return view; } });
	// a held row is edited only by the request's participants (rule 46); the host says who they are
	const held = $derived(heldBy === null ? null : bolt.approvals.get?.(heldBy) ?? null);
	// Inside a sheet the record's label, pills and actions are the sheet's header (one header, not two); only the frame
	// that renders the article claims it, so a representation's own `RecordShell` does and the one around it does not.
	const framed = $derived(!(Representation && view) && !(mode === 'update' && (record.state.kind !== 'ready' || row === null)));
	const SHEET = Symbol.for('ui.sheet.header');
	const toSheet = getContext<((s: Snippet | null) => void) | undefined>(SHEET);
	setContext(SHEET, toSheet === undefined ? undefined : (s: Snippet | null) => { if (!framed) toSheet(s); });
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
	const shown = $derived(mode === 'update' && fields.length > 0 ? fields.filter((f) => exposure === undefined || exposure.fields[f] !== undefined)
		: exposure !== undefined ? Object.keys(exposure.fields).filter((f) => !exposure.fields[f]?.hidden)
		: Object.keys(row ?? {}).filter((f) => !SYSTEM.has(f) && !f.startsWith('$')));
	let editing = $state(false);
	function done(o: Outcome) {
		notify(bolt, o);
		if (o.kind !== 'committed' && o.kind !== 'pendingApproval') return;
		editing = false;
		if (onDone) onDone(o);
		// the created record is this collection's; an act's other writes (a transform's side rows) come first or last
		// a create held for approval opens its held record too: the person sees what they submitted, pending review
		else if (mode === 'create') { const mine = o.records.find((r) => r.collection === of); if (mine !== undefined) openRecord(of, mine.id); }
	}

	const tabItems = $derived<TabItem[]>([
		{ name: 'ui', title: msg(bolt, 'record.tab.record', 'Record'), icon: 'lucide:file-text', body, keepAlive: true },
		...tabs.filter((t) => !around?.shown.includes(t.name) && !around?.shown.includes(t.title)),
		...(runs.length > 0 ? [{ name: 'runs', title: msg(bolt, 'record.tab.runs', 'Runs'), icon: 'lucide:play', body: runsTab }] : []),
	]);
</script>

{#snippet head()}
	<div class="flex min-w-0 flex-wrap items-center gap-2" data-record-head>
		<div class="mr-auto flex min-w-0 flex-col">
			{#if title}<span class="text-micro text-muted-foreground truncate leading-4">{label(bolt, of)}</span>{/if}
			<div class="flex items-center gap-2">
				<h2 class="truncate text-sm leading-5 font-semibold">{title ?? label(bolt, of)}</h2>
				{#if badge || icon}<Badge variant="outline" title={hint}>{#if icon}<Icon {icon} class="size-3" />{/if}{badge ?? ''}</Badge>{/if}
				{#if heldBy !== null}<Badge variant="warning">{msg(bolt, 'record.pending', 'Pending review')}</Badge>{/if}
				{#if trailing}{@render trailing()}{/if}
			</div>
			{#if subtitle}<p class="text-muted-foreground truncate text-sm">{subtitle}</p>{/if}
		</div>
		{#if actions}{@render actions()}{/if}
	</div>
{/snippet}

{#snippet generated()}
	{#if mode === 'create'}
		<Form {of} mode="create" {values} {...fields.length > 0 ? { fields } : {}} onOutcome={done} />
	{:else if editing && id !== undefined && shownPast === null}
		<Form {of} mode="update" {id} record={row} onOutcome={done} />
		<Button size="sm" variant="ghost" onclick={() => (editing = false)}>{msg(bolt, 'record.cancel', 'Cancel')}</Button>
	{:else}
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2" data-view="record-generated">
			{#each shown as f (f)}
				{@const name = exposure?.fields[f]?.label ?? label(bolt, of, f)}
				<div class="flex flex-col gap-0.5 text-sm" data-field={f}>
					<span class="text-muted-foreground text-xs">{name}</span>
				<span><Value value={row?.[f]} kind={exposure?.fields[f]} row={row ?? {}} /></span>
				</div>
			{/each}
			<!-- one-relations: the target's label, opening the target record -->
			{#each Object.entries(exposure?.relations ?? {}) as [fk, rel] (fk)}
				{@const v = row?.[fk]}
				{@const target = rel.targets[0]!}
				<div class="flex flex-col gap-0.5 text-sm" data-field={fk}>
					<span class="text-muted-foreground text-xs">{label(bolt, of, fk) === humanize(fk) ? humanize(fk.replace(/_id$/, '')) : label(bolt, of, fk)}</span>
					{#if typeof v === 'string' && rel.targets.length === 1}
						<button type="button" class="text-primary w-fit text-left underline-offset-4 hover:underline" onclick={() => openRecord(target, v)}>
							{#await bolt.get(target, v)}{v}{:then r}{[rel.label ?? kinds.catalog?.[target]?.label ?? []].flat().map((l) => show(r?.[l] ?? null, bolt.locale)).filter(Boolean).join(' · ') || v}{:catch}{v}{/await}
						</button>
					{:else}
						<span><Value value={v} /></span>
					{/if}
				</div>
			{/each}
		</div>
		{#if row !== null}<RecordInfo row={row} class="mt-4" />{/if}
		<div class="mt-3 flex items-center gap-2">
			{#if exposure?.update !== undefined && shownPast === null}
				{#if heldBy === null}
					<Button size="sm" variant="outline" onclick={() => (editing = true)}>{msg(bolt, 'record.edit', 'Edit')}</Button>
				{:else if held !== null}
					{#await held then v}{#if v?.participant}<Button size="sm" variant="outline" onclick={() => (editing = true)}>{msg(bolt, 'record.edit', 'Edit')}</Button>{/if}{/await}
				{/if}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet body()}
	{#if children && view}{#key shownPast}{@render children(view)}{/key}
	{:else}{@render generated()}{/if}
{/snippet}

{#snippet approval()}
	{#if heldBy !== null}<ApprovalPanel requestId={heldBy} collection={of} {id} revision={latest || undefined} />
	{:else}<EmptyState icon="shield" read="empty" title={msg(bolt, 'record.noApproval', 'No approval on this record')}
		hint={msg(bolt, 'record.noApprovalHint', 'When a change to this record needs approval, the request, its approvers and their decisions show here.')} />{/if}
{/snippet}

{#snippet tools()}
	<!-- record / approval: which body the record shows; icon toggles beside full screen, not content tabs -->
	{#if live !== null}
		<div class="flex items-center gap-0.5" role="group" aria-label={msg(bolt, 'record.show', 'Show')} data-record-toggle>
			{#each [{ key: 'record', glyph: 'file', text: msg(bolt, 'record.tab.record', 'Record') }, { key: 'approval', glyph: 'shield', text: msg(bolt, 'record.tab.approval', 'Approval') }] as const as t (t.key)}
				<button type="button" aria-pressed={pane === t.key} aria-label={t.text} title={t.text} data-record-pane={t.key} onclick={() => (pane = t.key)}
					class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 aria-pressed:bg-muted aria-pressed:text-foreground relative grid size-8 shrink-0 place-items-center rounded-md focus-visible:ring-2 focus-visible:outline-none">
					<Glyph name={t.glyph} class="size-4" />
					{#if t.key === 'approval' && heldBy !== null}<span class="bg-brand ring-popover absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2" aria-hidden="true"></span>{/if}
				</button>
			{/each}
			{#if latest >= 1}<RecordTimeline {of} {latest} {viewing} {history} onload={() => (wanted = true)} onpick={pick} />{/if}
		</div>
	{/if}
{/snippet}

{#snippet pastPill(p: Row)}
	<!-- a past revision is read-only; back to current is the live, editable record -->
	<div class="border-brand/25 bg-brand/10 text-brand-700 dark:text-brand-400 flex w-fit max-w-full items-center gap-2 rounded-full border py-0.5 pr-1 pl-2.5 text-xs" role="status" data-record-past={viewing}>
		<Glyph name="history" class="size-3.5 shrink-0" />
		<span class="truncate">{msg(bolt, 'record.viewingRevision', 'Viewing revision {n} · {when}', { n: String(p['revision'] ?? viewing ?? ''), when: show(p['updated_at'] ?? p['created_at'] ?? null, bolt.locale) })}</span>
		<button type="button" class="hover:bg-brand/15 focus-visible:ring-ring/40 shrink-0 rounded-full px-2 py-0.5 font-medium focus-visible:ring-2 focus-visible:outline-none" data-record-back onclick={() => pick(null)}>{msg(bolt, 'record.backToCurrent', 'Back to current')}</button>
	</div>
{/snippet}

{#snippet skeleton()}
	<!-- the record's shape while it loads (staging's): a header, the tab strip and a grid of fields -->
	<div class="flex flex-col gap-4" role="status" aria-busy="true" aria-label={msg(bolt, 'view.loading', 'Loading')} data-read="loading">
		<div class="bg-muted h-5 w-48 animate-pulse rounded motion-reduce:animate-none"></div>
		<div class="flex gap-4 border-b pb-2">{#each [16, 14, 12] as w (w)}<div class="bg-muted h-3.5 animate-pulse rounded motion-reduce:animate-none" style="width:{w * 4}px"></div>{/each}</div>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{#each [0, 1, 2, 3, 4, 5] as i (i)}<div class="flex flex-col gap-1.5"><div class="bg-muted h-3 w-20 animate-pulse rounded motion-reduce:animate-none"></div><div class="bg-muted h-4 w-3/4 animate-pulse rounded motion-reduce:animate-none"></div></div>{/each}
		</div>
	</div>
{/snippet}

{#snippet failure(text: string)}
	<Alert variant="destructive" data-read="error"><Glyph name="alert" class="size-4" /><p class="text-sm break-words">{text}</p></Alert>
{/snippet}

{#snippet runsTab()}
	<div class="flex flex-col gap-3">{#each runs as r (r.automation)}<RunsFor {...r} />{/each}</div>
{/snippet}

{#snippet content()}
{#if Representation && view}
	<!-- a representation chunk that fails to load says which model's view and why (final-ui §7.2, L-BOLT-515) -->
	{#await Representation}{@render skeleton()}{:then R}{#key shownPast}<R {view} />{/key}{:catch e}{@render failure(msg(bolt, 'record.viewFailed', 'The {model} view could not be loaded: {cause}', { model: of, cause: e instanceof Error ? e.message : String(e) }))}{/await}
{:else if mode === 'update' && record.state.kind === 'loading'}
	{@render skeleton()}
{:else if mode === 'update' && record.state.kind === 'ready' && row === null || record.state.kind === 'noAccess'}
	<EmptyState icon="lock" read="notFound" title={msg(bolt, 'record.notFound', 'Not found or no access')} />
{:else if record.state.kind === 'error'}
	{@render failure(record.state.message)}
{:else}
	<article class="flex min-w-0 flex-col gap-3" data-view="record" data-collection={of} data-held={heldBy ?? undefined}>
		{#if toSheet === undefined}<header>{@render head()}</header>{/if}
		{#if mode === 'create' || tabItems.length === 1}{@render body()}
		{:else if nested}{@render body()}{#if heldBy !== null && inside !== of}{@render approval()}{/if}
		{:else}<Tabs tabs={tabItems} />{/if}
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
	<fieldset disabled={past !== null} class={onApproval ? 'hidden' : 'contents'}>{@render content()}</fieldset>
{:else}{@render content()}{/if}
