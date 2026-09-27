<!--
	A delegated sub-agent's conversation inside the agent panel (§5.9 `subagent`): its task, its steps as they land and
	its answer, open while it works. It reads the child the same way the panel reads its own conversation (a live
	transcript, whose streaming and running rows say it works); a child that spawns its own sub-agents nests them the same way.
-->
<script lang="ts">
	import { watch } from 'runed';
	import { Icon, ReadonlyMarkdown, Spinner } from '@norbital-ai/ui';
	import type { AgentRow } from '../protocol/wire.ts';
	import type { ShellApi, ShellBolt } from './runtime.ts';
	import AgentChild from './AgentChild.svelte';

	let { api, bolt, t, id }: { api: ShellApi; bolt: Pick<ShellBolt, 'live'>; t: (key: string) => string; id: string } = $props();

	let rows = $state<AgentRow[]>([]);
	let error = $state<string | null>(null);
	watch(() => id, (c) => {
		const transcript = bolt.live<{ rows: AgentRow[] }>({ read: { m: 'transcript', a: [c] },
			then: (ok, bad) => Promise.reject<{ rows: AgentRow[] }>(new Error('the transcript is read live')).then(ok, bad) });
		const off = transcript.subscribe((value) => {
			error = transcript.error?.message ?? null;
			if (value !== undefined) rows = value.rows;
		});
		return off;
	});
	const task = $derived(rows.find((r) => r.role === 'user')?.text ?? '');
	const answer = $derived(rows.findLast((r) => r.role === 'assistant' && (r.tag === 'reply' || r.tag === 'failed')));
	const steps = $derived(rows.filter((r) => r.tool !== undefined));
	// a reply or call still being written, or no settled reply yet: working; a cut last reply: stopped
	const last = $derived(rows.findLast((r) => r.role === 'assistant'));
	const status = $derived(rows.some((r) => r.state === 'streaming' || r.state === 'running') || last === undefined || (last.tag !== 'reply' && last.tag !== 'failed' && last.tag !== 'cut')
		? 'running' : last.tag === 'cut' ? 'stopped' : 'idle');
</script>

<details class="w-full rounded-md border px-3 py-2 text-xs" open={status === 'running'} data-subagent={id} data-subagent-state={status}>
	<summary class="flex cursor-pointer list-none items-center gap-2">
		{#if status === 'running'}<Spinner label={t('Working…')} class="size-3" />{:else}<Icon name="lucide:bot" class="size-3.5" />{/if}
		<span class="min-w-0 flex-1 truncate font-medium">{task.split('\n')[0] || t('Sub-agent')}</span>
		<span class="text-muted-foreground">{status === 'running' ? t('working') : status === 'stopped' ? t('stopped') : t('done')}</span>
	</summary>
	<div class="mt-2 space-y-2 border-l pl-3">
		{#if error !== null}<p role="alert" class="text-destructive">{error}</p>{/if}
		{#if task !== ''}<p class="whitespace-pre-wrap text-muted-foreground" data-subagent-task>{task}</p>{/if}
		{#if steps.length > 0}
			<ol class="space-y-1 text-muted-foreground">
				{#each steps as s (s.id)}
					<li data-step class:text-destructive={s.tool!.failed}>
						{s.tool!.name}{s.tool!.failed ? ` · ${t('failed')}` : ''}
						{#if s.tool!.child !== undefined}<AgentChild {api} {bolt} {t} id={s.tool!.child} />{/if}
					</li>
				{/each}
			</ol>
		{/if}
		{#if answer?.text}<div data-subagent-answer><ReadonlyMarkdown value={answer.text} /></div>{/if}
	</div>
</details>
