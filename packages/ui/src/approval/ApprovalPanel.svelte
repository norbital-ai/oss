<!--
@component
A record's approval requests (spec §7): a scope selector when there are several, the chosen request's timeline (one
node for the request, one per step; each node a button whose popover holds that step's back-and-forth) and, for whoever
may decide now, a two-step form: pick Approve, Reject or Request changes, then give the reason and confirm.
-->
<script lang="ts" module>
	import type { ApprovalView, Outcome } from '../client/contract.js';
	/** Every request of one record (or one request), and what to do after a decision settles. */
	export type ApprovalPanelProps = {
		requests: readonly ApprovalView[];
		onOutcome?: (outcome: Outcome) => void;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '../effect/index.js';
	import { actOutcome, outcomeText } from '../actions/outcome.js';
	import { Button } from '../primitives/button/index.js';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph, { type GlyphName } from '../primitives/icon/Glyph.svelte';
	import { useKinds } from '../kinds/context.js';
	import { format } from '../kinds/kind.js';
	import { useBolt } from '../client/context.js';
	import { label, msg } from '../text/messages.js';
	import { skipText } from '../record/history.js';
	import { approvalStatus } from './row.js';

	let { requests, onOutcome }: ApprovalPanelProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const ids = $props.id();
	type Entry = ApprovalView['log'][number];
	type Move = ApprovalView['moves'][number];
	type Look = 'done' | 'active' | 'changes' | 'rejected' | 'later';
	type Node = {
		key: string;
		label: string;
		caption: string;
		look: Look;
		entries: readonly Entry[];
	};

	const locale = $derived(kinds.locale ?? bolt.locale);
	const at = (value: string) => format({ kind: 'instant' }, value, { locale, zone: kinds.zone });
	const day = (value: string) =>
		new Intl.DateTimeFormat(locale, {
			day: 'numeric',
			month: 'short',
			...(kinds.zone === undefined ? {} : { timeZone: kinds.zone })
		}).format(new Date(value));
	const who = (p: { ref: string; name: string | null }) => p.name ?? p.ref.replace(/^[a-z]+:/i, '');
	const OPEN = new Set(['Pending', 'ChangesRequested']);
	const DECISIVE = new Set<Entry['move']>(['approve', 'reject', 'requestChanges', 'supersede']);

	// oldest first: a request's number is its place in the record's history
	const ordered = $derived([...requests].sort((a, b) => a.at.localeCompare(b.at)));
	let picked = $state<string | null>(null);
	const current = $derived(
		requests.find((r) => r.id === picked) ??
			requests.find((r) => OPEN.has(r.status)) ??
			ordered[ordered.length - 1] ??
			null
	);

	const MOVE_TEXT: Readonly<Record<Entry['move'], string>> = {
		request: 'Requested',
		approve: 'Approved',
		reject: 'Rejected',
		requestChanges: 'Requested changes',
		resubmit: 'Resubmitted',
		supersede: 'Superseded'
	};
	const DECISION_TEXT: Readonly<Record<Move['decision'], string>> = {
		approve: 'Approve',
		reject: 'Reject',
		requestChanges: 'Request changes'
	};
	const LOOK_TEXT: Readonly<Record<Look, string>> = {
		done: 'Done',
		active: 'Waiting',
		changes: 'Changes requested',
		rejected: 'Rejected',
		later: 'Later'
	};
	const lookText = (look: Look) => msg(bolt, `approval.look.${look}`, LOOK_TEXT[look]);
	const decisionText = (d: Move['decision']) =>
		msg(bolt, `approval.decision.${d}`, DECISION_TEXT[d]);

	function nodes(v: ApprovalView): Node[] {
		const request = v.log.find((e) => e.move === 'request');
		const closed = v.status === 'Approved' || v.status === 'Superseded';
		return [
			{
				key: 'request',
				label: msg(bolt, 'approval.move.request', 'Requested'),
				caption: `${who(request?.by ?? v.requestor)} · ${day(request?.at ?? v.at)}`,
				look: 'done',
				entries: request === undefined ? [] : [request]
			},
			...v.steps.map((s, i): Node => {
				const entries = v.log.filter((e) => e.move !== 'request' && e.step === i);
				const look: Look =
					closed || i < v.step
						? 'done'
						: i > v.step
							? 'later'
							: v.status === 'Pending'
								? 'active'
								: v.status === 'ChangesRequested'
									? 'changes'
									: 'rejected';
				const last = [...entries].reverse().find((e) => DECISIVE.has(e.move));
				return {
					key: `step-${i}`,
					label: s.name,
					caption:
						look === 'active' || look === 'later'
							? lookText(look)
							: last === undefined
								? ''
								: `${who(last.by)} · ${day(last.at)}`,
					look,
					entries
				};
			})
		];
	}
	const NODE: Readonly<Record<Look, string>> = {
		done: 'border-success bg-success text-success-foreground',
		active: 'border-brand bg-background text-brand',
		changes: 'border-warning bg-warning text-warning-foreground',
		rejected: 'border-destructive bg-destructive text-destructive-foreground',
		later: 'border-border bg-muted text-muted-foreground'
	};
	const glyph = (look: Look): GlyphName | null =>
		look === 'done' ? 'check' : look === 'changes' ? 'alert' : look === 'rejected' ? 'x' : null;
	const DECISIONS = ['approve', 'reject', 'requestChanges'] as const;
	/** The viewer's decisions in the form's order: Approve, Reject, Request changes. */
	const decisions = (v: ApprovalView) =>
		DECISIONS.flatMap((d) => v.moves.filter((m) => m.decision === d));
	const changedText = (v: ApprovalView, e: Entry) =>
		(e.changed ?? []).map((f) => label(bolt, v.model, f)).join(', ');

	// the node whose popover is open: hover, keyboard focus or a tap opens it, Escape or leaving it closes it
	let shown = $state<string | null>(null);
	let pointing = false;

	// the form: step 1 picks the decision, step 2 takes the reason and repeats the decision on its confirm
	let chosen = $state<{ request: string; move: Move } | null>(null);
	let reason = $state('');
	let busy = $state(false);
	let notice = $state<string | null>(null);
	function decide(v: ApprovalView, move: Move) {
		if (busy || (move.reason === 'required' && reason.trim() === '')) return;
		busy = true;
		const note = reason.trim();
		fork(
			actOutcome(
				bolt.approvals.decide(v.id, {
					decision: move.decision,
					...(note === '' ? {} : { reason: note })
				})
			).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						notice = outcomeText(bolt, outcome);
						if (outcome.kind === 'committed') {
							reason = '';
							chosen = null;
						}
						onOutcome?.(outcome);
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
		);
	}
</script>

{#snippet entry(v: ApprovalView, e: Entry)}
	<li class="flex flex-col gap-0.5" data-move={e.move}>
		<p class="text-sm font-medium">
			{msg(bolt, `approval.move.${e.move}`, MOVE_TEXT[e.move])} · {who(e.by)}
		</p>
		<p class="text-meta"><time datetime={e.at}>{at(e.at)}</time></p>
		{#if e.reason}<p class="text-caption whitespace-pre-wrap wrap-anywhere" data-reason>
				“{e.reason}”
			</p>{/if}
		{#if e.move === 'resubmit' && changedText(v, e) !== ''}<p class="text-caption" data-changed>
				{msg(bolt, 'approval.changed', 'Changed: {fields}', { fields: changedText(v, e) })}
			</p>{/if}
		{#if e.rolledBack !== undefined && e.rolledBack.length > 0}
			<p class="text-caption" data-rolled-back>
				{msg(bolt, 'approval.rolledBack', 'Rolled back')}: {e.rolledBack
					.map(
						(r) =>
							`${label(bolt, r.model)} ${msg(bolt, `approval.action.${r.action}`, r.action)}`
					)
					.join(', ')}
			</p>
		{/if}
		{#if e.skipped !== undefined && e.skipped.length > 0}
			<p class="text-caption text-warning-foreground dark:text-warning" data-skipped>
				{msg(bolt, 'approval.skipped', 'Not restored')}: {e.skipped
					.map((s) => `${label(bolt, s.model, s.field)} (${skipText(bolt, s.reason)})`)
					.join(', ')}
			</p>
		{/if}
	</li>
{/snippet}

{#if current !== null}
	{@const v = current}
	{@const decision = chosen !== null && chosen.request === v.id ? chosen.move : null}
	{@const steps = nodes(v)}
	<div class="flex flex-col gap-4 text-sm" data-view="approval" data-status={v.status}>
		{#if requests.length > 1}
			<div class="flex flex-wrap items-center gap-2">
				<label for={`${ids}-scope`} class="text-label"
					>{msg(bolt, 'approval.request', 'Request')}</label
				>
				<select
					id={`${ids}-scope`}
					class="border-input bg-background focus-visible:ring-ring/40 h-8 min-w-0 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
					value={v.id}
					onchange={(e) => {
						picked = e.currentTarget.value;
						notice = null;
					}}
					data-view="approval-scope"
				>
					{#each [...ordered.entries()].reverse() as [i, r] (r.id)}<option value={r.id}
							>#{i + 1} · {approvalStatus(bolt, r.status)} · {day(r.at)}</option
						>{/each}
				</select>
			</div>
		{/if}

		<ol class="flex overflow-x-auto pb-1" data-view="approval-timeline">
			{#each steps as node, i (node.key)}
				{@const last = i === steps.length - 1}
				<li
					class="relative flex min-w-24 flex-1 flex-col items-center gap-1 px-1 text-center"
					data-step={node.key}
					data-look={node.look}
				>
					{#if !last}<span
							class={[
								'absolute top-3.5 left-1/2 h-0.5 w-full',
								node.look === 'done' && steps[i + 1]?.look !== 'later' ? 'bg-success' : 'bg-border'
							]}
							aria-hidden="true"
						></span>{/if}
					<Popover.Root
						open={shown === node.key}
						onOpenChange={(open) => {
							shown = open ? node.key : shown === node.key ? null : shown;
						}}
					>
						<Popover.Trigger
							openOnHover
							openDelay={100}
							closeDelay={150}
							aria-label={`${node.label}: ${lookText(node.look)}`}
							data-node={node.look}
							class="focus-visible:ring-ring/40 relative z-10 grid size-7 shrink-0 place-items-center rounded-full border-2 focus-visible:ring-2 focus-visible:outline-none max-sm:size-11 {NODE[
								node.look
							]}"
							onpointerdown={() => {
								pointing = true;
							}}
							onclick={() => {
								pointing = false;
							}}
							onfocus={() => {
								if (!pointing) shown = node.key;
								pointing = false;
							}}
							onblur={() => {
								if (shown === node.key) shown = null;
							}}
						>
							{#if node.look === 'active'}<span
									class="bg-brand/30 absolute inset-0 animate-ping rounded-full motion-reduce:animate-none"
									aria-hidden="true"
								></span><span class="bg-brand size-2.5 rounded-full" aria-hidden="true"
								></span>{:else}{@const g = glyph(node.look)}{#if g !== null}<Glyph
										name={g}
										class="size-3.5"
									/>{/if}{/if}
						</Popover.Trigger>
						<Popover.Content
							trapFocus={false}
							onOpenAutoFocus={(e) => e.preventDefault()}
							class="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 p-3"
							data-view="approval-step-log"
						>
							<p class="text-sm font-semibold">{node.label}</p>
							{#if node.entries.length === 0}<p class="text-meta">
									{node.look === 'active'
										? msg(bolt, 'approval.noDecision', 'No decision yet')
										: lookText(node.look)}
								</p>
							{:else}<ol class="flex flex-col gap-2">
									{#each node.entries as e, k (k)}{@render entry(v, e)}{/each}
								</ol>{/if}
						</Popover.Content>
					</Popover.Root>
					<span class="max-w-full truncate text-sm font-medium" data-label>{node.label}</span>
					{#if node.caption}<span class="text-meta max-w-full truncate" data-caption
							>{node.caption}</span
						>{/if}
				</li>
			{/each}
		</ol>

		{#if v.status === 'ChangesRequested' && v.mine}<p
				class="text-caption"
				role="status"
				data-view="approval-resubmit"
			>
				{msg(bolt, 'approval.resubmitOnSave', 'Saving resubmits for approval')}
			</p>{/if}

		{#if v.moves.length > 0}
			<div class="flex flex-col gap-2" data-view="approval-controls">
				{#if decision === null}
					<div class="flex flex-wrap gap-2">
						{#each decisions(v) as move (move.decision)}
							<Button
								size="sm"
								variant={move.decision === 'approve' ? 'default' : 'outline'}
								class={move.decision === 'reject' ? 'text-destructive' : undefined}
								disabled={busy}
								data-decision={move.decision}
								onclick={() => {
									chosen = { request: v.id, move };
									reason = '';
									notice = null;
								}}>{decisionText(move.decision)}</Button
							>
						{/each}
					</div>
				{:else}
					<form
						class="flex flex-col gap-2"
						data-decision={decision.decision}
						onsubmit={(e) => {
							e.preventDefault();
							decide(v, decision);
						}}
					>
						<label for={`${ids}-reason`} class="text-label"
							>{decisionText(decision.decision)} · {decision.reason === 'required'
								? msg(bolt, 'approval.reasonRequired', 'reason (required)')
								: msg(bolt, 'approval.reasonOptional', 'reason (optional)')}</label
						>
						<Textarea
							id={`${ids}-reason`}
							rows={3}
							required={decision.reason === 'required'}
							disabled={busy}
							bind:value={reason}
						/>
						<div class="flex flex-wrap justify-between gap-2">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={busy}
								data-back
								onclick={() => {
									chosen = null;
								}}>{msg(bolt, 'approval.back', 'Back')}</Button
							>
							<Button
								type="submit"
								size="sm"
								variant={decision.decision === 'reject' ? 'destructive' : 'default'}
								disabled={busy || (decision.reason === 'required' && reason.trim() === '')}
								data-confirm>{decisionText(decision.decision)}</Button
							>
						</div>
					</form>
				{/if}
			</div>
		{/if}

		{#if notice}<p role="status" class="text-muted-foreground">{notice}</p>{/if}
	</div>
{/if}
