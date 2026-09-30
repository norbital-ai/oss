<script lang="ts">
	// The approval view of §3.8 (R3, as today): the request's timeline (requested, each step with its approver teams and
	// decision, applied or restored), the held changes against the restore point, and the decisions the host says this
	// viewer may take. The host decides eligibility (L-BOLT-600); a refusal shows here.
	import { Button } from '../primitives/button/index.js';
	import { Input } from '../primitives/input/index.js';
	import { useKinds } from '../kinds/context.js';
	import type { ApprovalView, Json } from './bolt.js';
	import { useBolt } from './bolt.js';
	import { failed, heldChanges, humanize, isRow, label, msg, outcomeText, show } from './model.js';
	import Value from './Value.svelte';

	/** `revision`: the held row's revision; a participant's edit moves it, so the view and its changes re-read. */
	let { requestId, collection, id, revision }: { requestId: string; collection?: string; id?: string; revision?: number } = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	let reason = $state('');
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let decided = $state(0);
	const view = $derived.by(() => {
		void decided; void revision;
		return bolt.approvals.get?.(requestId) ?? Promise.resolve(null);
	});
	const history = $derived.by(() => {
		void decided; void revision;
		return collection !== undefined && id !== undefined ? bolt.history(collection, id) : null;
	});
	async function decide(status: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED') {
		busy = true;
		const o = await bolt.approvals.process(requestId, { status, ...(reason.trim() ? { reason: reason.trim() } : {}) });
		busy = false;
		notice = outcomeText(bolt, o);
		if (o.kind === 'committed') { reason = ''; decided++; }
	}
	async function withdraw() {
		busy = true;
		notice = outcomeText(bolt, await bolt.approvals.withdraw(requestId));
		busy = false;
		decided++;
	}
	// ── the held changes, shown as the record view shows them: by kind, relations by their target's label ──
	const exposure = $derived(collection === undefined ? undefined : kinds.catalog?.[collection]);
	/** A field the viewer's exposure shows (a hidden or unexposed field is left out); without a catalog, every non-`$` key. */
	const visible = (f: string) => exposure === undefined ? !f.startsWith('$')
		: (exposure.fields[f] !== undefined && !exposure.fields[f].hidden) || exposure.relations?.[f] !== undefined;
	const fieldLabel = (f: string) => {
		const l = exposure?.fields[f]?.label ?? label(bolt, collection!, f);
		return exposure?.relations?.[f] !== undefined && l === humanize(f) ? humanize(f.replace(/_id$/, '')) : l;
	};
	const STRUCTURED = new Set(['json', 'list', 'object', 'record', 'union']);
	/** "2 items" / "3 fields" for a structured value, which opens on demand; null for anything shown inline. */
	function summary(f: string, v: Json): string | null {
		const k = exposure?.fields[f];
		if (k !== undefined ? !STRUCTURED.has(k.kind) : !/^[[{]/.test(show(v, bolt.locale))) return null;
		if (Array.isArray(v)) return msg(bolt, 'approval.items', '{n} items', { n: v.length });
		return isRow(v) ? msg(bolt, 'approval.fields', '{n} fields', { n: Object.keys(v).length }) : null;
	}
	/** Long text is clamped to three lines until opened. */
	const LONG = 160;
	let open = $state<{ [key: string]: boolean }>({});
	const who = (p: { ref: string; name: string | null }) => p.name ?? p.ref.replace(/^[a-z]+:/i, '');
	const teams = (ts: readonly string[]) => ts.join(` ${msg(bolt, 'approval.or', 'or')} `);
	/** One step's state on the timeline: its decision, the current step, or not (yet) reached. */
	function stepState(v: ApprovalView, i: number): { state: string; decision?: ApprovalView['decisions'][number] } {
		const decision = v.decisions.filter((d) => d.step === i).at(-1);
		if (decision !== undefined) return { state: decision.status, decision };
		if (v.status === 'ONGOING' && i === v.step) return { state: 'CURRENT' };
		if (v.decisions.some((d) => d.status === 'SUPERSEDED' && d.step < i)) return { state: 'SUPERSEDED' };
		return { state: 'WAITING' };
	}
	const STATE_TEXT: { readonly [s: string]: string } = { APPROVED: 'Approved', REJECTED: 'Rejected', REQUEST_FOR_CHANGE: 'Changes requested',
		SUPERSEDED: 'Superseded', WITHDRAWN: 'Withdrawn', CURRENT: 'Awaiting decision', WAITING: 'Not reached' };
	const STATUS_TEXT: { readonly [s: string]: string } = { ONGOING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected',
		CHANGES_REQUESTED: 'Changes requested', WITHDRAWN: 'Withdrawn', CONFLICTED: 'Conflicted' };
	const ACTION_TEXT: { readonly [a: string]: string } = { create: 'new record', update: 'change', delete: 'deletion' };
	const DOT: { readonly [s: string]: string } = { APPROVED: 'bg-success', SUPERSEDED: 'bg-success', REJECTED: 'bg-destructive',
		REQUEST_FOR_CHANGE: 'bg-warning', WITHDRAWN: 'bg-muted-foreground', CURRENT: 'bg-primary', WAITING: 'bg-border' };
</script>

{#snippet change(f: string, v: Json, side: string)}
	{@const rel = exposure?.relations?.[f]}
	{@const sum = v === null ? null : summary(f, v)}
	{@const key = `${f}:${side}`}
	{#if v === null}
		<span class="text-muted-foreground">—</span>
	{:else if rel !== undefined && rel.targets.length === 1 && typeof v === 'string'}
		{@const target = rel.targets[0]!}
		{#await bolt.get(target, v)}<span class="text-muted-foreground">…</span>{:then r}
			<Value value={v} ref={{ of: target, text: [rel.label ?? kinds.catalog?.[target]?.label ?? []].flat().map((l) => show(r?.[l] ?? null, bolt.locale)).filter(Boolean).join(' · ') || v }} />
		{:catch}<Value value={v} />{/await}
	{:else if sum !== null}
		<details class="min-w-0" bind:open={open[key]}>
			<summary class="w-fit cursor-pointer">{sum}</summary>
			<div class="mt-1 min-w-0 overflow-x-auto"><Value value={v} kind={exposure?.fields[f]} name={f} /></div>
		</details>
	{:else}
		{@const long = show(v, bolt.locale).length > LONG}
		<div class={long && !open[key] ? 'line-clamp-3' : ''}><Value value={v} kind={exposure?.fields[f]} name={f} /></div>
		{#if long}
			<button type="button" class="text-primary w-fit text-xs underline-offset-4 hover:underline" onclick={() => (open[key] = !open[key])}>
				{open[key] ? msg(bolt, 'approval.showLess', 'Show less') : msg(bolt, 'approval.showMore', 'Show more')}
			</button>
		{/if}
	{/if}
{/snippet}

{#await view}
	<p class="text-muted-foreground text-sm">…</p>
{:then v}
	{#if v === null}
		<p class="text-muted-foreground text-sm" data-read="notFound">{msg(bolt, 'approval.notFound', 'Not found or no access')}</p>
	{:else}
		<div class="flex flex-col gap-4 text-sm" data-view="approval" data-status={v.status}>
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<span><span class="text-muted-foreground">{msg(bolt, 'approval.status', 'Status')}:</span> {msg(bolt, `approval.status.${v.status}`, STATUS_TEXT[v.status] ?? v.status)}</span>
				<span><span class="text-muted-foreground">{msg(bolt, 'approval.step', 'Step')}:</span> {Math.min(v.step + 1, v.steps.length)} / {v.steps.length}</span>
				{#if v.superceded_by.length > 0}
					<span><span class="text-muted-foreground">{msg(bolt, 'approval.supersededBy', 'May supersede')}:</span> {teams(v.superceded_by)}</span>
				{/if}
			</div>

			<ol class="flex flex-col gap-0" data-view="approval-timeline">
				<li class="flex gap-3" data-event="requested">
					<span class="bg-primary mt-1.5 size-2 shrink-0 rounded-full"></span>
					<div class="pb-3">
						<div class="font-medium">{msg(bolt, 'approval.requested', 'Requested')} · {msg(bolt, `approval.action.${v.action}`, ACTION_TEXT[v.action] ?? v.action)}</div>
						<div class="text-meta">{who(v.requestor)} · {show(v.at, bolt.locale)}</div>
					</div>
				</li>
				{#each v.steps as stepTeams, i (i)}
					{@const s = stepState(v, i)}
					<li class="flex gap-3" data-step={i + 1} data-state={s.state}>
						<span class="mt-1.5 size-2 shrink-0 rounded-full {DOT[s.state] ?? 'bg-border'}"></span>
						<div class="pb-3">
							<div class="font-medium">{msg(bolt, 'approval.stepN', `Step ${i + 1}`)}: {teams(stepTeams)} · {msg(bolt, `approval.state.${s.state}`, STATE_TEXT[s.state] ?? s.state)}</div>
							{#if s.decision}
								<div class="text-meta">{who(s.decision.by)} · {show(s.decision.at, bolt.locale)}</div>
								{#if s.decision.reason}<div class="text-caption">“{s.decision.reason}”</div>{/if}
							{/if}
						</div>
					</li>
				{/each}
				{#if v.appliedAt}
					<li class="flex gap-3" data-event="applied"><span class="bg-success mt-1.5 size-2 shrink-0 rounded-full"></span>
						<div class="pb-3"><div class="font-medium">{msg(bolt, 'approval.applied', 'Applied')}</div><div class="text-meta">{show(v.appliedAt, bolt.locale)}</div></div></li>
				{:else if v.restoredAt}
					<li class="flex gap-3" data-event="restored"><span class="bg-muted-foreground mt-1.5 size-2 shrink-0 rounded-full"></span>
						<div class="pb-3"><div class="font-medium">{msg(bolt, 'approval.restored', 'Changes undone')}</div><div class="text-meta">{show(v.restoredAt, bolt.locale)}</div></div></li>
				{/if}
			</ol>

			{#if history !== null && collection !== undefined}
				{#await history then revisions}
					{@const changes = heldChanges(revisions, requestId)}
					{@const shown = changes.filter((c) => visible(c.field))}
					{@const created = v.action === 'create'}
					{#if shown.length > 0}
						<section class="flex flex-col gap-2" data-view="held-changes">
							<h3 class="text-overline">{created ? msg(bolt, 'approval.newValues', 'New record') : msg(bolt, 'approval.changes', 'Changes')}</h3>
							<dl class="bg-card @container divide-y rounded-md border">
								{#each shown as c (c.field)}
									<div class="grid min-w-0 gap-x-4 gap-y-0.5 px-3 py-2 @sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]" data-field={c.field}>
										<dt class="text-muted-foreground min-w-0">{fieldLabel(c.field)}</dt>
										<dd class="flex min-w-0 flex-col gap-0.5 wrap-anywhere">
											{#if !created}
												<div class="text-muted-foreground line-through" data-side="before">{@render change(c.field, c.before, 'before')}</div>
											{/if}
											<div class="font-medium" data-side="held">{@render change(c.field, c.held, 'held')}</div>
										</dd>
									</div>
								{/each}
							</dl>
						</section>
					{/if}
				{:catch e}
					<p class="text-muted-foreground text-xs" data-read={failed(e).kind}>{msg(bolt, 'approval.noChanges', 'The held changes are not readable here.')}</p>
				{/await}
			{/if}

			{#if v.status === 'ONGOING' && (v.canDecide || v.canSupersede || v.mine)}
				<div class="flex flex-wrap items-center gap-2" data-view="approval-controls">
					{#if v.canDecide || v.canSupersede}
						<Input class="h-8 min-w-48 flex-1" placeholder={msg(bolt, 'approval.reason', 'Reason (required to request changes or supersede)')} bind:value={reason} />
					{/if}
					{#if v.canDecide}
						<Button size="sm" disabled={busy} onclick={() => decide('APPROVED')}>{msg(bolt, 'approval.approve', 'Approve')}</Button>
						<Button size="sm" variant="outline" disabled={busy} onclick={() => decide('REQUEST_FOR_CHANGE')}>{msg(bolt, 'approval.requestChanges', 'Request changes')}</Button>
						<Button size="sm" variant="destructive" disabled={busy} onclick={() => decide('REJECTED')}>{msg(bolt, 'approval.reject', 'Reject')}</Button>
					{/if}
					{#if v.canSupersede}
						<Button size="sm" variant="outline" disabled={busy} onclick={() => decide('SUPERSEDED')}>{msg(bolt, 'approval.supersede', 'Supersede')}</Button>
					{/if}
					{#if v.mine}<Button size="sm" variant="ghost" disabled={busy} onclick={withdraw}>{msg(bolt, 'approval.withdraw', 'Withdraw')}</Button>{/if}
				</div>
			{:else if v.status === 'ONGOING'}
				<p class="text-muted-foreground text-xs" data-view="approval-waiting">{msg(bolt, 'approval.awaiting', 'Awaiting a decision from')} {teams(v.steps[v.step] ?? [])}</p>
			{/if}
			{#if notice}<p role="status" class="text-muted-foreground">{notice}</p>{/if}
		</div>
	{/if}
{:catch e}
	<p class="text-muted-foreground text-sm" data-read={failed(e).kind}>{msg(bolt, 'approval.notFound', 'Not found or no access')}</p>
{/await}
