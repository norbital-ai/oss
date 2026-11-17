<!--
@component
The approval decision buttons (`Approve`, `Reject`, `Request changes`, `Withdraw`) and two-step reason form for one
approval request. Shared by `ApprovalPanel` and `RecordShell`'s footer.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { ApprovalView, Outcome, UiContext } from '../client/contract.js';
	import { actOutcome, outcomeText } from '../actions/outcome.js';
	import { bolt_of } from '../client/context.js';
	import { Button } from '../primitives/button/index.js';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import { fork } from '../effect/index.js';
	import { catalogText, msg } from '../text/messages.js';

	let {
		ctx,
		request,
		inline = false,
		on_outcome
	}: {
		ctx: UiContext;
		request: ApprovalView;
		inline?: boolean;
		on_outcome?: (outcome: Outcome) => void;
	} = $props();

	const bolt = $derived(bolt_of(ctx));
	const ids = $props.id();
	type Move = ApprovalView['moves'][number];

	const DECISIONS = ['approve', 'reject', 'request_changes', 'withdraw'] as const;
	const DECISION_TEXT: Readonly<Record<Move['decision'], string>> = {
		approve: 'Approve',
		reject: 'Reject',
		request_changes: 'Request changes',
		withdraw: 'Withdraw'
	};
	const decisions = (v: ApprovalView) =>
		DECISIONS.flatMap((d) => v.moves.filter((m) => m.decision === d));
	const decisionText = (d: Move['decision']) =>
		catalogText(bolt, `approval.decision.${d}`, DECISION_TEXT[d]);

	let chosen = $state<{ request: string; move: Move } | null>(null);
	let reason = $state('');
	let busy = $state(false);
	let notice = $state<{ request: string; text: string; failed: boolean } | null>(null);

	const decision = $derived(chosen !== null && chosen.request === request.id ? chosen.move : null);
	const currentNotice = $derived(notice !== null && notice.request === request.id ? notice : null);

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
						notice = {
							request: v.id,
							text: outcomeText(bolt, outcome),
							failed:
								outcome.kind !== 'committed' &&
								outcome.kind !== 'pending_approval' &&
								outcome.kind !== 'running'
						};
						if (outcome.kind === 'committed') {
							reason = '';
							chosen = null;
						}
						on_outcome?.(outcome);
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			),
			(error) => {
				notice = { request: v.id, text: bolt.t(error.message), failed: true };
			}
		);
	}
</script>

{#if request.moves.length > 0 || currentNotice !== null}
	<div
		class={inline
			? decision !== null || currentNotice !== null
				? 'flex w-full flex-col gap-2 border-t pt-2 text-sm'
				: 'inline-flex flex-wrap items-center gap-2'
			: 'flex flex-col gap-2'}
		data-view="approval-controls"
	>
		{#if request.moves.length > 0}
			{#if decision === null}
				<div class="flex flex-wrap gap-2">
					{#each decisions(request) as move (move.decision)}
						<Button
							variant={move.decision === 'approve' ? 'default' : 'outline'}
							class={move.decision === 'reject' ? 'text-destructive' : undefined}
							disabled={busy}
							data-decision={move.decision}
							onclick={() => {
								chosen = { request: request.id, move };
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
						decide(request, decision);
					}}
				>
					<label for={`${ids}-reason`} class="text-label"
						>{decisionText(decision.decision)} · {decision.reason === 'required'
							? msg(bolt, 'approval.reasonRequired')
							: msg(bolt, 'approval.reasonOptional')}</label
					>
					<Textarea
						id={`${ids}-reason`}
						rows={inline ? 2 : 3}
						required={decision.reason === 'required'}
						disabled={busy}
						bind:value={reason}
					/>
					<div class="flex flex-wrap justify-between gap-2">
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							data-back
							onclick={() => {
								chosen = null;
							}}>{msg(bolt, 'approval.back')}</Button
						>
						<Button
							type="submit"
							variant={decision.decision === 'reject' ? 'destructive' : 'default'}
							disabled={busy || (decision.reason === 'required' && reason.trim() === '')}
							data-confirm>{decisionText(decision.decision)}</Button
						>
					</div>
				</form>
			{/if}
		{/if}
		{#if currentNotice}<p
				role={currentNotice.failed ? 'alert' : 'status'}
				class={currentNotice.failed ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
				data-view="approval-notice"
			>
				{currentNotice.text}
			</p>{/if}
	</div>
{/if}
