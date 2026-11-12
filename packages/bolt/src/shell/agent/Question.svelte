<script lang="ts">
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, Icon, Textarea } from '@norbital-ai/ui';
	import { Scroll } from '@norbital-ai/ui/layout';
	import type { AgentQuestion } from '../../protocol/schema.ts';
	import type { ShellApi } from '../api-types.ts';

	let { api, conversation, id, question, answered, active, pending, t }: {
		api: ShellApi;
		conversation: string;
		id: string;
		question: AgentQuestion;
		answered: boolean;
		active: boolean;
		pending: boolean;
		t: (key: string) => string;
	} = $props();
	let selected = $state<string | null>(null);
	let custom = $state('');
	let busy = $state(false);
	let accepted = $state(false);
	let failed = $state<string | null>(null);
	const answer = $derived(custom.trim() || selected || '');
	const response = $derived(answered || accepted);
	watch(() => active, (waiting) => { if (waiting) { accepted = false; failed = null; } });
	const submit = () => Effect.suspend(() => {
		if (!active || busy || response || answer === '') return Effect.void;
		const text = answer;
		busy = true;
		failed = null;
		return api.agent.post(conversation, text, true, [], undefined, undefined, id).pipe(
			Effect.match({
				onFailure: (error) => { failed = error.message; },
				onSuccess: (outcome) => {
					if (outcome.kind === 'committed') accepted = true;
					else failed = outcome.kind === 'refused' ? outcome.message : t('The request failed.');
				}
			}),
			Effect.ensuring(Effect.sync(() => { busy = false; }))
		);
	});
</script>

<section class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background p-4" style="max-height: min(32rem, 60dvh)" data-question={id} aria-labelledby="question-{id}">
	<div class="mb-3 flex shrink-0 items-center gap-2 text-sm font-medium">
		<Icon name="lucide:message-circle-question" class="size-4 shrink-0 text-muted-foreground" />
		<span>{t('Your input')}</span>
	</div>
	{#if active && !response}
		<form class="flex min-h-0 flex-col" onsubmit={(event) => { event.preventDefault(); fork(submit()); }}>
			<Scroll name={t('Question details')} axis="both" fade={false} class="min-h-0 flex-initial overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:auto]" data-question-details>
				<p id="question-{id}" class="text-sm font-medium whitespace-pre-wrap">{question.question}</p>
				<fieldset disabled={busy} class="mt-4 grid min-w-0 gap-2" aria-labelledby="question-{id}">
					{#each question.options as option, index (option)}
						<label class="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm hover:bg-muted/50 has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
							<input type="radio" name="answer-{id}" value={option} checked={selected === option && custom === ''} class="mt-1 accent-primary" onchange={() => { selected = option; custom = ''; }} />
							<span class="shrink-0 text-muted-foreground tabular-nums">{index + 1}.</span>
							<span class="min-w-0 whitespace-pre-wrap">{option}</span>
						</label>
					{/each}
					<label for="answer-{id}" class="mt-1 text-xs text-muted-foreground">{t(question.options.length > 0 ? 'Or write your own answer' : 'Your answer')}</label>
					<Textarea id="answer-{id}" bind:value={custom} oninput={() => { selected = null; }} class="min-h-16 text-sm" />
				</fieldset>
			</Scroll>
			<div class="flex shrink-0 items-center gap-2 pt-3">
				<Button type="submit" disabled={busy || answer === ''}>{t(busy ? 'Sending…' : 'Send answer')}</Button>
				<span class="text-xs text-muted-foreground" role="status">{t('Waiting for your answer')}</span>
			</div>
			{#if failed !== null}<p class="mt-2 shrink-0 text-sm text-destructive" role="alert">{failed}</p>{/if}
		</form>
	{:else}
		<Scroll name={t('Question details')} axis="both" fade={false} class="min-h-0 flex-initial overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:auto]" data-question-details>
			<p id="question-{id}" class="text-sm font-medium whitespace-pre-wrap">{question.question}</p>
			{#if !response && question.options.length > 0}
				<ol class="mt-3 list-decimal space-y-1 pl-5 text-sm">{#each question.options as option (option)}<li class="whitespace-pre-wrap">{option}</li>{/each}</ol>
			{/if}
		</Scroll>
		<p class="mt-3 shrink-0 text-sm text-muted-foreground" data-question-answer>{t(response ? 'Answered' : pending ? 'Waiting for an answer' : 'Continued in conversation')}</p>
	{/if}
</section>
