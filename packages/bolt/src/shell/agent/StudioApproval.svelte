<!--
	A merge or rollback the agent asked for, held by the host for the person (the step's `approval`): the agent's
	summary of the change, then the facts Studio holds — the change's commit message for a merge, the destructive schema
	steps approving accepts; the checkpoint's time, its description and whether data written after it is discarded for a
	rollback — and Approve / Reject, which decide it from the person's own session (`approval.decide`), as in Studio.
-->
<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Button, Icon, useKinds } from '@norbital-ai/ui';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { AgentRow } from '../../protocol/wire.ts';
	import type { ShellApi } from '../api-types.ts';

	let {
		api,
		step,
		t
	}: {
		api: ShellApi;
		step: AgentRow;
		t: (key: string) => string;
	} = $props();

	const id = $derived(step.tool?.approval);
	const summary = $derived(
		Option.getOrNull(
			Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ summary: Schema.String })))(
				step.tool?.args
			)
		)?.summary
	);
	const studio = observeOnce(() => api.studio());
	const held = $derived(studio.current?.approvals?.find((one) => one.id === id));
	// the checkpoint's time from Studio's own record, in the workspace's zone: never the agent's wording of it
	const zone = useKinds().zone;
	const when = (at: string) =>
		new Date(at).toLocaleString(undefined, zone === undefined ? {} : { timeZone: zone });
	const draft = $derived(
		held?.op.op === 'change.merge' && held.head !== undefined
			? studio.current?.builds?.find((b) => b.commit === held.head)?.message
			: undefined
	);
	const checkpoint = $derived.by(() => {
		const op = held?.op;
		return op?.op === 'rollback'
			? studio.current?.releases.find((r) => r.commit === op.commit)
			: undefined;
	});
	let decided = $state<'approved' | 'rejected' | null>(null);
	let busy = $state(false);
	let failed = $state<string | null>(null);
	const decide = (kind: 'approved' | 'rejected') =>
		Effect.suspend(() => {
			if (id === undefined || busy) return Effect.void;
			busy = true;
			failed = null;
			return api.studioRun({ op: 'approval.decide', id, kind }).pipe(
				Effect.match({
					onFailure: (cause) => {
						failed = cause.message;
					},
					onSuccess: () => {
						decided = kind;
					}
				}),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			);
		});
</script>

<div class="mt-2 rounded-xl border border-border/70 bg-background p-3 shadow-sm" data-approval={id}>
	<p class="text-sm font-medium text-foreground">
		{t(
			step.tool?.studio === 'rollback'
				? 'Roll the workspace back to an earlier version?'
				: 'Publish these changes to the workspace?'
		)}
	</p>
	{#if summary !== undefined}
		<p class="mt-1 text-sm text-foreground" data-role="summary">{summary}</p>
	{/if}
	{#if draft !== undefined}
		<p class="mt-1 text-xs text-muted-foreground">{t('Draft')}: {draft}</p>
	{/if}
	{#if (held?.destructive?.length ?? 0) > 0}
		<p class="mt-1 text-sm text-destructive" role="alert">
			{t('This applies destructive schema steps:')}
			{held?.destructive?.join(', ')}
		</p>
	{/if}
	{#if checkpoint !== undefined}
		<p class="mt-1 text-xs text-muted-foreground">
			{t('Checkpoint')}:
			<time datetime={checkpoint.checkpoint ?? checkpoint.at}
				>{when(checkpoint.checkpoint ?? checkpoint.at)}</time
			>
			— {checkpoint.message}
		</p>
		{#if checkpoint.discards !== undefined}
			<p class="mt-1 text-sm text-destructive" role="alert">
				{t('Data written after')}
				{when(checkpoint.discards)}
				{t('will be discarded. Everyone stays signed in.')}
			</p>
		{:else}
			<p class="mt-1 text-xs text-muted-foreground">
				{t('All data is kept. Everyone stays signed in.')}
			</p>
		{/if}
	{/if}
	{#if decided === 'approved'}
		<Inline gap="sm" align="center" class="mt-2 text-sm" role="status" data-outcome>
			<Icon name="lucide:circle-check" class="size-4 shrink-0 text-success" />
			<span class="min-w-0 whitespace-normal"
				>{t('Applied — the workspace is now on the new version.')}</span
			>
			<Button
				size="sm"
				variant="outline"
				class="shrink-0"
				onclick={() => location.reload()}
				data-view-live>{t('View live')}</Button
			>
		</Inline>
	{:else if decided === 'rejected'}
		<p class="mt-2 text-xs text-muted-foreground" role="status">{t('Rejected')}</p>
	{:else if held !== undefined}
		<p class="mt-1 text-xs text-muted-foreground">
			{t(
				'The workspace updates for everyone. It can take a few minutes; pages wait while it switches over and nobody is signed out.'
			)}
		</p>
		<Inline gap="xs" class="mt-2" align="center">
			<Button size="sm" disabled={busy} onclick={() => fork(decide('approved'))}
				>{t('Approve')}</Button
			>
			<Button size="sm" variant="outline" disabled={busy} onclick={() => fork(decide('rejected'))}
				>{t('Reject')}</Button
			>
			{#if busy}<span class="text-xs text-muted-foreground" role="status"
					>{t('Working on it… you can keep using the app.')}</span
				>{/if}
		</Inline>
	{:else if studio.current !== undefined}
		<p class="mt-2 text-xs text-muted-foreground">{t('No longer waiting for approval.')}</p>
	{/if}
	{#if failed !== null}
		<p class="mt-2 text-sm text-destructive" role="alert">{failed}</p>
	{/if}
</div>
