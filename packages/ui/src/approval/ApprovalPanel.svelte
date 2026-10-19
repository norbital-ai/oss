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
	import { Input } from '../primitives/input/index.js';
	import { useKinds } from '../kinds/context.js';
	import { format } from '../kinds/kind.js';
	import type { ActFailure, ActSuccess, ApprovalView, Outcome } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import { failed } from '../read/state.js';
	import { label, msg } from '../text/messages.js';
	import { skipText } from '../record/history.js';

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
	const STATUS_TEXT: { readonly [s: string]: string } = {
		ONGOING: 'Pending',
		CHANGES_REQUESTED: 'Changes requested',
		APPROVED: 'Approved',
		REJECTED: 'Rejected',
		WITHDRAWN: 'Withdrawn',
		SUPERSEDED: 'Superseded'
	};
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
		REJECTED: 'destructive',
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
	const needsReason = (v: ApprovalView) => v.moves.some((m) => m.reason === 'required');
</script>

{#await run(view)}
	<p class="text-muted-foreground text-sm">…</p>
{:then v}
	{#if v === null}
		<p class="text-muted-foreground text-sm" data-read="notFound">
			{msg(bolt, 'approval.notFound', 'Not found or no access')}
		</p>
	{:else}
		<div class="flex flex-col gap-4 text-sm" data-view="approval" data-status={v.status}>
			<div class="flex flex-wrap gap-x-4 gap-y-1">
				<span
					><span class="text-muted-foreground">{msg(bolt, 'approval.status', 'Status')}:</span>
					{msg(bolt, `approval.status.${v.status}`, STATUS_TEXT[v.status] ?? v.status)}</span
				>
				<span
					><span class="text-muted-foreground">{msg(bolt, 'approval.step', 'Step')}:</span>
					{Math.min(v.step + 1, v.steps.length)} / {v.steps.length}</span
				>
				{#if v.status === 'ONGOING'}
					<span data-view="approval-waiting"
						><span class="text-muted-foreground"
							>{msg(bolt, 'approval.awaiting', 'Awaiting a decision from')}:</span
						>
						{teams(v, v.steps[v.step] ?? [])}</span
					>
				{:else if v.status === 'CHANGES_REQUESTED'}
					<span data-view="approval-waiting"
						><span class="text-muted-foreground"
							>{msg(bolt, 'approval.awaitingRequester', 'Awaiting changes from')}:</span
						>
						{who(v.requestor)}</span
					>
				{/if}
				{#if v.superseded_by.length > 0}
					<span
						><span class="text-muted-foreground"
							>{msg(bolt, 'approval.supersededBy', 'May supersede')}:</span
						>
						{teams(v, v.superseded_by)}</span
					>
				{/if}
			</div>

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

			<ol class="flex flex-col gap-0" data-view="approval-timeline">
				{#each v.log as e, i (i)}
					<li class="flex gap-3" data-move={e.move} data-to={e.to}>
						<span class="mt-1.5 size-2 shrink-0 rounded-full {DOT[e.move] ?? 'bg-border'}"></span>
						<div class="pb-3">
							<div class="font-medium">
								{msg(bolt, `approval.move.${e.move}`, MOVE_TEXT[e.move] ?? e.move)}
								{#if e.move !== 'comment' && e.move !== 'request'}
									· {msg(bolt, 'approval.stepN', `Step ${e.step + 1}`)}{/if}
								{#if e.from !== null && e.from !== e.to}
									· {msg(bolt, `approval.status.${e.to}`, STATUS_TEXT[e.to] ?? e.to)}{/if}
							</div>
							<div class="text-meta">{who(e.by)} · {at(e.at)}</div>
							{#if e.reason}<div class="text-caption" data-reason>“{e.reason}”</div>{/if}
							{#if e.rolledBack !== undefined && e.rolledBack.length > 0}
								<div class="text-caption" data-rolled-back>
									{msg(bolt, 'approval.rolledBack', 'Rolled back')}:
									{e.rolledBack
										.map((r) => `${label(bolt, r.collection)} ${ACTION_TEXT[r.action] ?? r.action}`)
										.join(', ')}
								</div>
							{/if}
							{#if e.skipped !== undefined && e.skipped.length > 0}
								<div class="text-caption text-warning" data-skipped>
									{msg(bolt, 'approval.skipped', 'Not restored')}:
									{e.skipped
										.map(
											(s) => `${label(bolt, s.collection, s.field)} (${skipText(bolt, s.reason)})`
										)
										.join(', ')}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ol>

			{#if v.moves.length > 0}
				<div class="flex flex-wrap items-center gap-2" data-view="approval-controls">
					<Input
						class="h-8 min-w-48 flex-1"
						placeholder={needsReason(v)
							? msg(
									bolt,
									'approval.reason',
									'Reason or comment (required to request changes, supersede or comment)'
								)
							: msg(bolt, 'approval.note', 'Note (optional)')}
						bind:value={reason}
					/>
					{#each v.moves as move (move.status)}
						<Button
							size="sm"
							variant={VARIANT[move.status] ?? 'outline'}
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
			{/if}
			{#if notice}<p role="status" class="text-muted-foreground">{notice}</p>{/if}
		</div>
	{/if}
{:catch e}
	<p class="text-muted-foreground text-sm" data-read={failed(e).kind}>
		{msg(bolt, 'approval.notFound', 'Not found or no access')}
	</p>
{/await}
