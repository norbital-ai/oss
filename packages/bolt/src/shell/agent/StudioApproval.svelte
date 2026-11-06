<!--
	In the composer: a merge or rollback the agent asked for, held by the host for the person (the step's `approval`): the agent's
	summary of the change, then the facts Studio holds — the change's commit message for a merge, the destructive schema
	steps approving accepts; the checkpoint's time, its description and whether data written after it is discarded for a
	rollback — and Approve / Reject, which decide it from the person's own session (`approval.decide`), as in Studio.
-->
<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Button, Icon, useKinds } from '@norbital-ai/ui';
	import { Inline } from '@norbital-ai/ui/layout';
	import { impactLines, stepName } from '../../protocol/migration-impact.ts';
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
	// what its migrations did on a fresh copy of live: the rows, the downtime, what a rollback would lose
	const impact = $derived.by(() => {
		const op = held?.op;
		return op?.op === 'change.merge'
			? studio.current?.changeSets?.find((c) => c.id === op.id)?.preview?.impact
			: undefined;
	});
	const checkpoint = $derived.by(() => {
		const op = held?.op;
		return op?.op === 'rollback'
			? studio.current?.releases.find((r) => r.commit === op.commit)
			: undefined;
	});
	let decided = $state<'approved' | 'rejected' | null>(null);
	/** How the approved merge ended: the card follows it, at most ten minutes, through its switch-over. */
	let ended = $state<{ readonly error?: string } | null>(null);
	const follow = Effect.fn('StudioApproval.follow')(function* (change: string) {
		for (let tries = 0; tries < 300 && ended === null; tries++) {
			yield* Effect.sleep('2 seconds');
			const view = yield* Effect.orElseSucceed(api.studio(), () => null),
				found = view?.changeSets?.find((c) => c.id === change);
			if (found?.state === 'merged') ended = {};
			else if (found?.merge?.state === 'failed')
				ended = { error: found.merge.error ?? t('the merge did not reach live') };
		}
	});
	let busy = $state(false);
	let failed = $state<string | null>(null);
	const decide = (kind: 'approved' | 'rejected') =>
		Effect.suspend(() => {
			if (id === undefined || busy) return Effect.void;
			busy = true;
			failed = null;
			const op = held?.op;
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
				),
				Effect.andThen(
					Effect.suspend(() =>
						decided === 'approved' && op?.op === 'change.merge' ? follow(op.id) : Effect.void
					)
				)
			);
		});
</script>

{#if held !== undefined || decided !== null}
	<div class="rounded-xl border border-border/70 bg-background p-3" data-approval={id}>
		<p class="text-sm font-medium text-foreground">
			{t(
				step.tool?.studio === 'rollback'
					? 'Roll the workspace back to an earlier version?'
					: 'Merge into live?'
			)}
		</p>
		{#if summary !== undefined}
			<p class="mt-1 text-sm text-foreground" data-role="summary">{summary}</p>
		{/if}
		{#if draft !== undefined}
			<p class="mt-1 text-xs text-muted-foreground">{t('Last commit')}: {draft}</p>
		{/if}
		{#if (held?.destructive?.length ?? 0) > 0}
			<p class="mt-1 text-sm text-destructive" role="alert">
				{t('This removes or changes stored data:')}
				{held?.destructive?.map(stepName).join(', ')}
			</p>
		{/if}
		{#if impact !== undefined}
			<ul class="mt-1 text-xs text-muted-foreground" data-role="impact">
				{#each impactLines(impact, t) as line (line)}<li>{line}</li>{/each}
			</ul>
		{/if}
		{#if checkpoint !== undefined}
			<p class="mt-1 text-xs text-muted-foreground">
				{t('Goes back to')}:
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
				<Icon
					name={ended?.error === undefined ? 'lucide:circle-check' : 'lucide:circle-alert'}
					class="size-4 shrink-0 {ended?.error === undefined ? 'text-success' : 'text-destructive'}"
				/>
				{#if ended?.error !== undefined}
					<span class="min-w-0 whitespace-normal">{t('The merge failed:')} {ended.error}</span>
				{:else if ended !== null}
					<span class="min-w-0 whitespace-normal">{t('Merged. Live runs the new version.')}</span>
				{:else if held?.op.op === 'change.merge'}
					<span class="min-w-0 whitespace-normal">{t('Approved. Merging into live…')}</span>
				{:else}
					<span class="min-w-0 whitespace-normal"
						>{t('Applied — the workspace is now on the new version.')}</span
					>
					<Button
						variant="outline"
						class="shrink-0"
						onclick={() => location.reload()}
						data-view-live>{t('View live')}</Button
					>
				{/if}
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
				<Button disabled={busy} onclick={() => fork(decide('approved'))}>{t('Approve')}</Button>
				<Button variant="outline" disabled={busy} onclick={() => fork(decide('rejected'))}
					>{t('Reject')}</Button
				>
				{#if busy}<span class="text-xs text-muted-foreground" role="status"
						>{t('Working on it… you can keep using the app.')}</span
					>{/if}
			</Inline>
		{/if}
		{#if failed !== null}
			<p class="mt-2 text-sm text-destructive" role="alert">{failed}</p>
		{/if}
	</div>
{/if}
