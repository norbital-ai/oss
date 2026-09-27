<!--
	The last build's diagnosis under the editor (staging's diagnosis-pane): its state (not built, stale behind drafts, clean)
	and a rerun, then the findings grouped by file, each opening its source. A merge request's diagnosis uses it too.
-->
<script lang="ts">
	import { Button, Icon } from '@norbital-ai/ui';
	import { Cluster, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { StudioDiagnostic } from '../studio.ts';

	let { diagnostics, stale = false, busy = false, onopen, onrerun, t }: {
		diagnostics: readonly StudioDiagnostic[] | undefined; stale?: boolean; busy?: boolean;
		onopen: (path: string) => void; onrerun?: () => void; t: (key: string) => string;
	} = $props();
	const groups = $derived.by(() => {
		const by = new Map<string, StudioDiagnostic[]>();
		for (const d of diagnostics ?? []) by.set(d.path, [...(by.get(d.path) ?? []), d]);
		return [...by].sort(([a], [b]) => a.localeCompare(b));
	});
</script>

<Stack gap="sm" shrink={false} class="border-t border-border/60 bg-card/40 p-3 sm:p-4 {stale ? 'opacity-70' : ''}">
	<Cluster gap="sm" align="start">
		<Stack gap="xs" grow class="min-w-0">
			<h2 class="text-xs font-semibold text-foreground">{t('Diagnosis')}</h2>
			{#if diagnostics === undefined}
				<p class="text-meta">{t('No diagnosis yet. Run one to check this source.')}</p>
			{:else if stale}
				<p class="text-meta">{t('These findings cover an earlier version.')}</p>
			{:else if diagnostics.length === 0}
				<p class="text-meta">{t('No diagnosis errors.')}</p>
			{/if}
		</Stack>
		{#if onrerun}
			<Button size="sm" variant="outline" class="h-7 px-2 text-micro" disabled={busy} onclick={onrerun}>
				<Icon name="lucide:stethoscope" class="size-3.5" />{t('Run diagnosis')}
			</Button>
		{/if}
	</Cluster>
	{#if groups.length > 0}
		<Scroll name={t('Diagnosis')} class="max-h-56">
			<Stack gap="sm" data-diagnosis aria-label={t('Diagnosis')}>
				{#each groups as [file, findings] (file)}
					<Stack gap="xs">
						<p class="font-mono text-micro font-semibold text-foreground">{file}</p>
						<Stack as="ul" gap="none" divided>
							{#each findings as d, i (i)}
								{@const warn = d.severity === 'warn'}
								<li data-severity={d.severity ?? 'error'} class="border-l-2 py-1.5 pl-2 {warn ? 'border-l-amber-600 text-amber-800 dark:text-amber-300' : 'border-l-destructive text-destructive'}">
									<button type="button" class="w-full text-left" onclick={() => onopen(d.path)}>
										<span class="block text-micro font-medium">{t(warn ? 'Warning' : 'Error')} · {d.code}</span>
										<span class="block text-xs whitespace-pre-wrap text-foreground">{d.message}</span>
										{#if d.help}<span class="block text-xs text-muted-foreground">{d.help}</span>{/if}
										<span class="block font-mono text-micro text-muted-foreground">{d.path}{d.line === undefined ? '' : `:${d.line}`}</span>
									</button>
								</li>
							{/each}
						</Stack>
					</Stack>
				{/each}
			</Stack>
		</Scroll>
	{/if}
</Stack>
