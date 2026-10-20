<!--
@component
An approval request: its full timeline (every transition, comment, reason, resubmit and rollback result), the records its
provisional change holds, and the moves the host's state machine allows this viewer — the buttons are exactly those.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { run, fork } from '../effect/index.js';
	import { actOutcome, outcomeText } from '../actions/outcome.js';
	import { Button } from '../primitives/button/index.js';
	import { Textarea } from '../primitives/textarea/index.js';
	import { useKinds } from '../kinds/context.js';
	import { format } from '../kinds/kind.js';
	import type { ActFailure, ActSuccess, ApprovalView, Outcome } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import { failed } from '../read/state.js';
	import { label, msg } from '../text/messages.js';
	import { skipText } from '../record/history.js';
	import { approvalStatus } from './row.js';

	/** A new source revision refreshes the request under current permissions. */
	let {
		requestId,
		revision,
		onOutcome
	}: { requestId: string; revision?: number; onOutcome?: (outcome: Outcome) => void } = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const at = (value: string) =>
		format({ kind: 'instant' }, value, { locale: kinds.locale ?? bolt.locale, zone: kinds.zone });
	const noteId = $props.id();
	let reason = $state('');
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let decided = $state(0);
	const view = $derived.by(() => {
		void decided;
		void revision;
		return bolt.approvals.get?.(requestId) ?? Effect.succeed(null);
	});
	function settle(action: Effect.Effect<ActSuccess, ActFailure>) {
		if (busy) return;
		busy = true;
		fork(
			actOutcome(action).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						notice = outcomeText(bolt, outcome);
						if (outcome.kind === 'committed') {
							reason = '';
							decided++;
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
	const act = (move: ApprovalView['moves'][number]) =>
		settle(
			bolt.approvals.process(requestId, {
				status: move.status,
				...(reason.trim() ? { reason: reason.trim() } : {})
			})
		);

	const who = (p: { ref: string; name: string | null }) => p.name ?? p.ref.replace(/^[a-z]+:/i, '');
	const teams = (v: ApprovalView, ts: readonly string[]) =>
		ts.map((handle) => v.teamNames[handle] ?? handle).join(` ${msg(bolt, 'approval.or', 'or')} `);
	const MOVE_TEXT: { readonly [m: string]: string } = {
		request: 'Requested',
		approve: 'Approved',
		reject: 'Rejected',
		requestChanges: 'Requested changes',
		resubmit: 'Resubmitted',
		withdraw: 'Withdrew',
		supersede: 'Superseded',
		comment: 'Commented',
		close: 'Closed (source changed)'
	};
	const BUTTON_TEXT: { readonly [s: string]: string } = {
		APPROVED: 'Approve',
		REQUEST_FOR_CHANGE: 'Request changes',
		REJECTED: 'Reject',
		RESUBMITTED: 'Resubmit',
		WITHDRAWN: 'Withdraw',
		SUPERSEDED: 'Supersede',
		COMMENT: 'Comment',
		CLOSED: 'Close'
	};
	const VARIANT: { readonly [s: string]: 'default' | 'outline' | 'destructive' | 'ghost' } = {
		APPROVED: 'default',
		RESUBMITTED: 'default',
		REJECTED: 'outline',
		WITHDRAWN: 'ghost',
		COMMENT: 'ghost'
	};
	const DOT: { readonly [m: string]: string } = {
		request: 'bg-primary',
		approve: 'bg-success',
		supersede: 'bg-success',
		resubmit: 'bg-primary',
		reject: 'bg-destructive',
		requestChanges: 'bg-warning',
		withdraw: 'bg-muted-foreground',
		close: 'bg-muted-foreground',
		comment: 'bg-border'
	};
	const ACTION_TEXT: { readonly [a: string]: string } = {
		create: 'created',
		update: 'changed',
		delete: 'deleted',
		restored: 'restored',
		removed: 'removed',
		recreated: 'recreated'
	};
	const requiredActions = (v: ApprovalView) =>
		v.moves
			.filter((m) => m.reason === 'required')
			.map((m) => msg(bolt, `approval.button.${m.status}`, BUTTON_TEXT[m.status] ?? m.status))
			.join(', ');
	const orderedMoves = (v: ApprovalView) =>
		[...v.moves].sort(
			(a, b) => Number(VARIANT[b.status] === 'default') - Number(VARIANT[a.status] === 'default')
		);
</script>

{#snippet effects(e: ApprovalView['log'][number])}
	{#if e.rolledBack !== undefined && e.rolledBack.length > 0}
		<p class="text-caption" data-rolled-back>
			{msg(bolt, 'approval.rolledBack', 'Rolled back')}: {e.rolledBack
				.map(
					(r) =>
						`${label(bolt, r.collection)} ${msg(bolt, `approval.action.${r.action}`, ACTION_TEXT[r.action] ?? r.action)}`
				)
				.join(', ')}
		</p>
	{/if}
	{#if e.skipped !== undefined && e.skipped.length > 0}
		<details class="text-caption text-warning-foreground dark:text-warning" data-skipped>
			<summary class="cursor-pointer"
				>{msg(bolt, 'approval.skipped', 'Not restored')} ({e.skipped.length})</summary
			>
			<ul class="mt-1 list-disc pl-4">
				{#each e.skipped as s, i (i)}<li>
						{label(bolt, s.collection, s.field)} ({skipText(bolt, s.reason)})
					</li>{/each}
			</ul>
		</details>
	{/if}
{/snippet}

{#await run(view)}
	<p class="text-muted-foreground text-sm">…</p>
{:then v}
	{#if v === null}
		<p class="text-muted-foreground text-sm" data-read="notFound">
			{msg(bolt, 'approval.notFound', 'Not found or no access')}
		</p>
	{:else}
		{@const decision =
			v.status === 'CHANGES_REQUESTED' || v.status === 'REJECTED' || v.status === 'WITHDRAWN'
				? [...v.log].reverse().find((e) => e.to === v.status && e.from !== e.to)
				: undefined}
		<div class="flex flex-col gap-4 text-sm" data-view="approval" data-status={v.status}>
			<header class="flex flex-col gap-2" data-view="approval-summary">
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h3 class="font-medium">{approvalStatus(bolt, v.status)}</h3>
					{#if v.status === 'ONGOING' && v.steps.length > 0}<span class="text-meta"
							>{msg(bolt, 'approval.stepOf', 'Step {step} of {total}', {
								step: Math.min(v.step + 1, v.steps.length),
								total: v.steps.length
							})}</span
						>{/if}
				</div>
				{#if v.status === 'ONGOING'}
					<p class="text-meta" data-view="approval-waiting">
						{msg(bolt, 'approval.awaiting', 'Awaiting a decision from')}:
						<span class="text-foreground">{teams(v, v.steps[v.step] ?? [])}</span>
					</p>
				{:else if v.status === 'CHANGES_REQUESTED'}
					<p class="text-meta" data-view="approval-waiting">
						{msg(bolt, 'approval.awaitingRequester', 'Awaiting changes from')}:
						<span class="text-foreground">{who(v.requestor)}</span>
					</p>
				{/if}
				{#if decision?.reason}
					<blockquote
						class="whitespace-pre-wrap wrap-anywhere"
						data-view="approval-decision-reason"
					>
						{decision.reason}
					</blockquote>
					<p class="text-meta">
						{who(decision.by)} · <time datetime={decision.at}>{at(decision.at)}</time>
					</p>
				{/if}
				{#if decision !== undefined}{@render effects(decision)}{/if}
				{#if v.status === 'ONGOING' && v.superseded_by.length > 0}<p class="text-meta">
						{msg(bolt, 'approval.supersededBy', 'May supersede')}: {teams(v, v.superseded_by)}
					</p>{/if}
			</header>

			<ul class="text-meta flex flex-wrap gap-x-3" data-view="approval-records">
				{#each v.records as r (`${r.collection}:${r.id}`)}
					<li data-record={r.id} data-op={r.op}>
						{label(bolt, r.collection)} · {msg(
							bolt,
							`approval.action.${r.op}`,
							ACTION_TEXT[r.op] ?? r.op
						)}
					</li>
				{/each}
			</ul>

			{#if v.moves.length > 0}
				{@const required = requiredActions(v)}
				<div class="flex flex-col gap-2" data-view="approval-controls">
					<label for={noteId} class="text-label"
						>{msg(bolt, 'approval.reasonLabel', 'Reason or comment')}</label
					>
					<Textarea
						id={noteId}
						rows={2}
						disabled={busy}
						aria-describedby={`${noteId}-help`}
						bind:value={reason}
					/>
					<p id={`${noteId}-help`} class="text-meta">
						{required
							? msg(bolt, 'approval.reasonFor', 'Required for {actions}.', { actions: required })
							: msg(bolt, 'approval.optional', 'Optional.')}
					</p>
					<div class="flex flex-wrap gap-2">
						{#each orderedMoves(v) as move (move.status)}
							<Button
								size="sm"
								variant={VARIANT[move.status] ?? 'outline'}
								class={move.status === 'REJECTED' ? 'text-destructive' : undefined}
								disabled={busy || (move.reason === 'required' && reason.trim() === '')}
								data-move={move.status}
								onclick={() => act(move)}
								>{msg(
									bolt,
									`approval.button.${move.status}`,
									BUTTON_TEXT[move.status] ?? move.status
								)}</Button
							>
						{/each}
					</div>
				</div>
			{/if}

			<details data-view="approval-history">
				<summary class="cursor-pointer text-meta"
					>{msg(bolt, 'approval.decisionHistory', 'Decision history')} ({v.log.length})</summary
				>
				<ol class="mt-3 flex flex-col gap-0" data-view="approval-timeline">
					{#each v.log as e, i (i)}
						<li class="flex gap-3" data-move={e.move} data-to={e.to}>
							<span class="mt-1.5 size-2 shrink-0 rounded-full {DOT[e.move] ?? 'bg-border'}"></span>
							<div class="min-w-0 pb-3">
								<div class="font-medium">
									{msg(bolt, `approval.move.${e.move}`, MOVE_TEXT[e.move] ?? e.move)}
									{#if v.steps.length > 1 && e.move !== 'comment' && e.move !== 'request'}
										· {msg(bolt, 'approval.stepN', `Step ${e.step + 1}`)}{/if}
								</div>
								<div class="text-meta">{who(e.by)} · <time datetime={e.at}>{at(e.at)}</time></div>
								{#if e.reason}<div
										class="text-caption whitespace-pre-wrap wrap-anywhere"
										data-reason
									>
										“{e.reason}”
									</div>{/if}
								{#if e !== decision}{@render effects(e)}{/if}
							</div>
						</li>
					{/each}
				</ol>
			</details>

			{#if notice}<p role="status" class="text-muted-foreground">{notice}</p>{/if}
		</div>
	{/if}
{:catch e}
	<p class="text-muted-foreground text-sm" data-read={failed(e).kind}>
		{msg(bolt, 'approval.notFound', 'Not found or no access')}
	</p>
{/await}
