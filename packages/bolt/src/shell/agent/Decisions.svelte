<script lang="ts">
	import { date_time, BRIEF_TIMESTAMP } from '../i18n.ts';
	import { answer_of, type Decided } from './decisions.ts';
	let { decision, t }: { decision: Decided; t: (key: string) => string } = $props();
	const event = $derived(decision.event);
	const d = $derived(decision.d);
</script>

	<div class="mt-2 rounded-md border border-border/70 bg-muted/20 p-2 text-xs" data-decision-matrix>
		<table class="w-full">
			<thead
				><tr class="text-left text-muted-foreground"
					><th class="pb-1 pr-2 font-medium">{t('Message')}</th><th class="pb-1 pr-2 font-medium"
						>{t('Answer')}</th
					><th class="pb-1 font-medium">{t('Verdict')}</th></tr
				></thead
			>
			<tbody>
				{#each d.state?.pending ?? [] as p, i (i)}
					<tr class="border-t border-border/60 align-top" data-decision-row={`m${i}`}>
						<td class="py-1 pr-2 whitespace-pre-wrap"
							><span class="text-muted-foreground">{p.from ?? ''}:</span> {p.text ?? ''}</td
						>
						<td class="py-1 pr-2 tabular-nums">{answer_of(d.answers?.[`m${i}`])}</td>
						<td class="py-1">{d.verdicts?.[i] ?? '—'}</td>
					</tr>
				{/each}
				<tr class="border-t border-border/60" data-decision-row="wait">
					<td class="py-1 pr-2 text-muted-foreground">{t('Wait')}</td><td
						class="py-1 pr-2 tabular-nums"
						>{answer_of(d.answers?.['hold'] ?? d.answers?.['wait'])}</td
					><td class="py-1">{d.action ?? '—'}</td>
				</tr>
			</tbody>
		</table>
		{#if d.error !== undefined}<p class="mt-1 text-destructive">{t('failed')}: {d.error}</p>{/if}
		{#if d.state !== undefined}
			<details class="mt-1 text-muted-foreground" data-decision-context>
				<summary class="cursor-pointer">{t('Context')} · {date_time(event.at, undefined, BRIEF_TIMESTAMP)}</summary>
				<p class="mt-1">
					<span class="font-medium">{t('Directive')}</span>: {d.state.directive ?? ''}
				</p>
				<p><span class="font-medium">{t('Assistant')}</span>: {d.state.assistant ?? ''}</p>
				{#each d.state.earlier ?? [] as p, i (i)}<p class="whitespace-pre-wrap opacity-80">
						<span>{p.from ?? ''}:</span>
						{p.text ?? ''}
					</p>{/each}
			</details>
		{/if}
	</div>
