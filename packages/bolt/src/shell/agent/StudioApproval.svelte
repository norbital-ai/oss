<!--
	One bounded card per held update: a short summary, disclosed data/version details, visible data-loss warnings and
	fixed decision controls. The native approval still runs once as the requestor and follows the real merge outcome.
-->
<script lang="ts">
	import { Effect, Option, Schema } from 'effect';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Alert, Button, Icon, PreviewFrame } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { impact_lines, step_name } from '@norbital-ai/host-api';
	import type { AgentRow } from '../../protocol/wire.ts';
	import type { ShellApi } from '../api-types.ts';
	import { date_time } from '../i18n.ts';

	let {
		api,
		step,
		t,
		zone
	}: {
		api: ShellApi;
		step: AgentRow;
		zone?: string | undefined;
		t: (key: string) => string;
	} = $props();

	const MergeArgs = Schema.fromJsonString(
		Schema.Struct({
			summary: Schema.optionalKey(Schema.String),
			commit: Schema.optionalKey(Schema.String)
		})
	);
	const MergeResult = Schema.fromJsonString(
		Schema.Struct({
			merge: Schema.optionalKey(Schema.NullOr(Schema.String)),
			commit: Schema.optionalKey(Schema.String),
			approval: Schema.optionalKey(
				Schema.NullOr(
					Schema.Struct({
						head: Schema.optionalKey(Schema.String),
						op: Schema.optionalKey(
							Schema.Struct({
								op: Schema.String,
								id: Schema.optionalKey(Schema.String)
							})
						)
					})
				)
			)
		})
	);
	const id = $derived(step.tool?.approval);
	const parsedArgs = $derived(
		Option.getOrUndefined(Schema.decodeUnknownOption(MergeArgs)(step.tool?.args))
	);
	const summary = $derived(parsedArgs?.summary);
	const parsedResult = $derived(
		Option.getOrUndefined(Schema.decodeUnknownOption(MergeResult)(step.tool?.result))
	);
	const resultChangeId = $derived.by(() => {
		const op = parsedResult?.approval?.op;
		if (op?.op === 'change.merge' && op.id !== undefined) return op.id;
		if (typeof parsedResult?.merge === 'string') return parsedResult.merge;
		const raw = step.tool?.result;
		if (typeof raw !== 'string') return undefined;
		return (
			/"op"\s*:\s*"change\.merge"[^}]*"id"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
			/"id"\s*:\s*"([^"]+)"[^}]*"op"\s*:\s*"change\.merge"/.exec(raw)?.[1] ??
			/"merge"\s*:\s*"([^"]+)"/.exec(raw)?.[1]
		);
	});
	const resultCommit = $derived(
		parsedResult?.approval?.head ?? parsedResult?.commit ?? parsedArgs?.commit
	);
	const studio = observe_once(() => api.studio());
	const held = $derived(studio.current?.approvals?.find((one) => one.id === id));
	const isMerge = $derived(held?.op.op === 'change.merge' || step.tool?.studio === 'merge');
	const matchedChange = $derived.by(() => {
		const sets = studio.current?.change_sets;
		if (sets === undefined) return undefined;
		const op = held?.op;
		if (op?.op === 'change.merge') return sets.find((c) => c.id === op.id);
		if (resultChangeId !== undefined) return sets.find((c) => c.id === resultChangeId);
		if (resultCommit !== undefined && step.tool?.studio === 'merge')
			return sets.find((c) => c.head.startsWith(resultCommit) || c.merge?.head.startsWith(resultCommit));
		return undefined;
	});
	const change = $derived(held?.op.op === 'change.merge' ? matchedChange : undefined);
	const preview = $derived(change?.preview);
	let previewing = $state(false);
	const showPreview = Effect.fn('StudioApproval.preview')(function* () {
		const request = held;
		if (request?.op.op !== 'change.merge' || busy) return;
		const changeId = request.op.id;
		busy = true;
		failed = null;
		yield* Effect.gen(function* () {
			if (preview?.url == null || preview.stale || preview.shelved) {
				yield* api.studio_run({ op: 'preview', id: changeId });
				yield* studio.refetch();
			}
			if (change?.preview?.url == null || change.preview.stale || change.preview.commit !== request.head) {
				failed = t('This request has no current preview. Ask for a new merge request.');
				return;
			}
			previewing = true;
		}).pipe(Effect.catch((cause) => Effect.sync(() => { failed = cause.message; })),
			Effect.ensuring(Effect.sync(() => { busy = false; })));
	});
	// the checkpoint's time from Studio's own record, in the workspace's zone: never the agent's wording of it
	const when = (at: string) =>
		date_time(at, undefined, zone === undefined ? {} : { timeZone: zone });
	const draft = $derived(
		held?.op.op === 'change.merge' && held.head !== undefined
			? studio.current?.builds?.find((b) => b.commit === held.head)?.message
			: undefined
	);
	// what its migrations did on a fresh copy of live: the rows, the downtime, what a rollback would lose
	const impact = $derived.by(() => {
		const op = held?.op;
		return op?.op === 'change.merge'
			? studio.current?.change_sets?.find((c) => c.id === op.id)?.preview?.impact
			: undefined;
	});
	const checkpoint = $derived.by(() => {
		const op = held?.op;
		return op?.op === 'rollback'
			? studio.current?.releases.find((r) => r.commit === op.commit)
			: undefined;
	});
	const short_summary = $derived(summary === undefined || summary === null ? '' : summary.length <= 240 ? summary : `${summary.slice(0, 240).replace(/\s+\S*$/, '')}…`);
	const destructive = $derived([...new Set(held?.destructive ?? [])]);
	const impact_details = $derived(impact === undefined ? [] : impact_lines(impact, t));
	const data_details = $derived([...new Set(impact === undefined ? destructive.map(step_name) : impact_details.slice(0, -2))]);
	let decided = $state<'approved' | 'rejected' | null>(null);
	/** How the approved merge ended: the card follows it, at most ten minutes, through its switch-over. */
	let ended = $state<{ readonly error?: string } | null>(null);
	let following = false;
	const follow = Effect.fn('StudioApproval.follow')(function* (changeId: string) {
		following = true;
		for (let tries = 0; tries < 300 && ended === null; tries++) {
			yield* Effect.sleep('2 seconds');
			const view = yield* Effect.orElseSucceed(api.studio(), () => null),
				found = view?.change_sets?.find((c) => c.id === changeId);
			if (found?.state === 'merged') ended = {};
			else if (found?.merge?.state === 'failed')
				ended = { error: found.merge.error ?? t('the merge did not reach live') };
		}
	});
	// On reload after approval, keep showing live merge progress/outcome from studio.change_sets instead of vanishing.
	$effect(() => {
		if (studio.current === undefined || held !== undefined || decided !== null || !isMerge) return;
		const found = matchedChange;
		if (found === undefined) return;
		if (found.state === 'merged') {
			decided = 'approved';
			ended = {};
		} else if (found.merge?.state === 'failed') {
			decided = 'approved';
			ended = { error: found.merge.error ?? t('the merge did not reach live') };
		} else if (found.merge !== undefined) {
			decided = 'approved';
			if (!following) fork(follow(found.id));
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
			return api.studio_run({ op: 'approval.decide', id, kind }).pipe(
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
	<section class="flex min-h-0 flex-col overflow-hidden rounded-md border border-border/70 bg-background" style="max-height: min(32rem, 60dvh)" data-approval={id} aria-label={t('Workspace update')}>
		<p class="shrink-0 px-3 pt-3 pb-2 text-sm font-medium">
			{t(decided !== null ? 'Workspace update' : step.tool?.studio === 'rollback' ? 'Restore this version?' : 'Apply these changes?')}
		</p>
		<Scroll name={t('Change details')} axis="both" fade={false} class="min-h-0 flex-initial space-y-3 overflow-y-auto overscroll-contain px-3 pb-3 text-sm [scrollbar-gutter:auto]">
			{#if summary !== undefined && summary !== null && summary !== ''}
				{#if summary.length > 240}
					<details class="group/summary" data-role="summary">
						<summary class="block cursor-pointer list-none rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
							<p class="mb-1 whitespace-pre-wrap group-open/summary:hidden">{short_summary}</p>
							<span class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
								<Icon name="lucide:chevron-right" class="size-3.5 shrink-0 transition-transform group-open/summary:rotate-90 motion-reduce:transition-none" />
								<span class="group-open/summary:hidden">{t('Read more')}</span>
								<span class="hidden group-open/summary:inline">{t('Change summary')}</span>
							</span>
						</summary>
						<p class="mt-1 whitespace-pre-wrap">{summary}</p>
					</details>
				{:else}<p class="whitespace-pre-wrap" data-role="summary">{summary}</p>{/if}
			{/if}
			{#if checkpoint !== undefined}
				<p class="text-xs text-muted-foreground">
					{t('Restore to')} <time datetime={checkpoint.checkpoint ?? checkpoint.at}>{when(checkpoint.checkpoint ?? checkpoint.at)}</time> — {checkpoint.message}
				</p>
			{/if}
			{#if destructive.length > 0}
				<Alert.Root variant="warning" size="sm" data-role="warning">
					<Icon name="lucide:triangle-alert" class="size-4" />
					<Alert.Description>{t('Some stored data will be removed or changed. Review the data changes before applying.')}</Alert.Description>
				</Alert.Root>
			{/if}
			{#if checkpoint?.discards !== undefined}
				<p class="text-sm text-destructive" role="alert">{t('Data written after')} {when(checkpoint.discards)} {t('will be discarded.')}</p>
			{:else if checkpoint !== undefined}
				<p class="text-xs text-muted-foreground">{t('Your current data will be kept.')}</p>
			{/if}
			{#if data_details.length > 0 || (draft !== undefined && draft !== summary)}
				<details class="group/impact" data-role="impact">
					<summary class="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
						<Icon name="lucide:chevron-right" class="size-3.5 shrink-0 transition-transform group-open/impact:rotate-90 motion-reduce:transition-none" />
						{t('Review data changes and version')}
					</summary>
					<div class="mt-2 space-y-2 pl-4.5 text-xs text-muted-foreground">
						{#if draft !== undefined && draft !== summary}<p>{t('Version')}: {draft}</p>{/if}
						{#if data_details.length > 0}<ul class="list-disc space-y-1 pl-4 break-words">{#each data_details as line, index (index)}<li>{line}</li>{/each}</ul>{/if}
					</div>
				</details>
			{/if}
			{#if impact_details.length > 0}
				<ul class="grid gap-1 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-role="facts">
					<li class="flex items-start gap-2"><Icon name="lucide:timer" class="mt-px size-3.5 shrink-0" />{impact_details.at(-2)}</li>
					<li class="flex items-start gap-2"><Icon name="lucide:history" class="mt-px size-3.5 shrink-0" />{impact_details.at(-1)}</li>
				</ul>
			{:else if decided === null && held !== undefined}
				<p class="text-xs text-muted-foreground">{t('This updates the workspace for everyone.')}</p>
			{/if}
		</Scroll>
		<div class="shrink-0 border-t border-border/60 px-3 py-2.5">
			{#if decided === 'approved'}
				<Inline gap="sm" align="center" class="min-h-8 text-sm" role="status" data-outcome>
					<Icon name={ended?.error !== undefined ? 'lucide:circle-alert' : ended === null && isMerge ? 'lucide:loader-circle' : 'lucide:circle-check'} class="size-4 shrink-0 {ended === null && isMerge ? 'animate-spin motion-reduce:animate-none' : ''}" />
					{#if ended?.error !== undefined}
						<span class="min-w-0 whitespace-normal text-destructive">{t('The update failed:')} {ended.error}</span>
					{:else if ended !== null || !isMerge}
						<span class="min-w-0 whitespace-normal">{t('Changes applied.')}</span>
						<Button variant="outline" class="shrink-0" onclick={() => location.reload()} data-view-live>{t('View workspace')}</Button>
					{:else}<span class="min-w-0 whitespace-normal">{t('Applying changes… You can keep using the app.')}</span>{/if}
				</Inline>
			{:else if decided === 'rejected'}
				<p class="flex min-h-8 items-center text-sm text-muted-foreground" role="status">{t('Changes rejected.')}</p>
			{:else if held !== undefined}
				<Inline gap="xs" align="center">
					{#if held.op.op === 'change.merge'}<Button variant="outline" disabled={busy} onclick={() => fork(showPreview())}>{t('Preview')}</Button>{/if}
					<Button disabled={busy} onclick={() => fork(decide('approved'))}>{t(busy ? 'Working…' : step.tool?.studio === 'rollback' ? 'Restore version' : 'Merge')}</Button>
					<Button variant="ghost" disabled={busy} onclick={() => fork(decide('rejected'))}>{t(held.op.op === 'change.merge' ? 'Deny' : 'Cancel')}</Button>
				</Inline>
			{/if}
			{#if failed !== null}<p class="mt-2 text-sm text-destructive" role="alert">{failed}</p>{/if}
		</div>
	</section>
{/if}

{#if previewing && preview?.url != null}
	<PreviewFrame src={preview.url} version={preview.artifact} label={change?.title}
		{t} bind:expanded={previewing} on_close={() => (previewing = false)} />
{/if}
