<!--
	What a publish or rollback card asks the person to approve: the agent's summary of the change, then the facts Studio
	holds — the draft's commit message for a publish; the checkpoint's time, its description and whether data written
	after it is discarded for a rollback.
-->
<script lang="ts">
	import { Option, Schema } from 'effect';
	import { query } from '@norbital-ai/ui/effect';
	import { useKinds } from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import type { ShellApi } from '../api-types.ts';

	let {
		api,
		studio,
		input,
		t
	}: {
		api: ShellApi;
		studio: 'publish' | 'rollback';
		input: Json;
		t: (key: string) => string;
	} = $props();

	const asked = $derived(
		Option.getOrNull(
			Schema.decodeUnknownOption(Schema.Struct({ summary: Schema.String, commit: Schema.String }))(
				input
			)
		)
	);
	const held = query(() => api.studio());
	// the checkpoint's time from Studio's own record, in the workspace's zone: never the agent's wording of it
	const zone = useKinds().zone;
	const when = (at: string) =>
		new Date(at).toLocaleString(undefined, zone === undefined ? {} : { timeZone: zone });
	const draft = $derived(
		studio === 'publish' && asked !== null
			? held.current?.builds?.find((b) => b.commit.startsWith(asked.commit))?.message
			: undefined
	);
	const checkpoint = $derived(
		studio === 'rollback' && asked !== null
			? held.current?.releases.find((r) => r.commit === asked.commit)
			: undefined
	);
</script>

{#if asked !== null}
	<p class="mt-1 text-sm text-foreground" data-role="summary">{asked.summary}</p>
{/if}
{#if draft !== undefined}
	<p class="mt-1 text-xs text-muted-foreground">{t('Draft')}: {draft}</p>
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
