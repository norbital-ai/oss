<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { diagnosisFindingTone } from '#lib/client/ui/studio/authoring-live.js';
	import {
		diagnosisFindingPath,
		diagnosisFindingsByFile,
		workbenchDiagnosisState,
		type HostSnapshot
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		diagnosis,
		draftCount = 0,
		busy = false,
		onopenSource,
		onrerun
	}: {
		diagnosis: HostSnapshot['diagnosis'];
		draftCount?: number;
		busy?: boolean;
		onopenSource?: ((path: string) => void) | undefined;
		onrerun?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const state = $derived(workbenchDiagnosisState({ diagnosis, draftCount }));
	const groups = $derived(diagnosisFindingsByFile(diagnosis?.findings ?? []));
	const dimmed = $derived(state === 'stale');

	const toneClass = (severity: 'error' | 'warning' | 'hint'): string => {
		const tone = diagnosisFindingTone(severity);
		switch (tone) {
			case 'danger':
				return 'border-l-destructive text-destructive';
			case 'warning':
				return 'border-l-amber-600 text-amber-800 dark:text-amber-300';
			case 'info':
				return 'border-l-muted-foreground text-muted-foreground';
			default: {
				const unhandled: never = tone;
				throw new Error(`Unhandled diagnosis tone: ${String(unhandled)}`);
			}
		}
	};

	const severityWord = (severity: 'error' | 'warning' | 'hint'): string => {
		switch (severity) {
			case 'error':
				return t('bolt.studio.severity.error');
			case 'warning':
				return t('bolt.studio.severity.warning');
			case 'hint':
				return t('bolt.studio.severity.hint');
			default: {
				const unhandled: never = severity;
				throw new Error(`Unhandled diagnosis severity: ${String(unhandled)}`);
			}
		}
	};
</script>

<Stack
	gap="sm"
	class={cn('border-t border-border/60 bg-card/40 p-3 sm:p-4', dimmed && 'opacity-70')}
	data-testid="studio-diagnosis"
>
	<Inline gap="sm" align="start" class="flex-wrap">
		<Stack gap="xs" grow class="min-w-0">
			<h2 class="text-xs font-semibold text-foreground">{t('bolt.studio.diagnosis')}</h2>
			{#if state === 'missing'}
				<p class="text-meta">{t('bolt.studio.diagnosis.missing')}</p>
			{:else if state === 'stale'}
				<p class="text-meta">{t('bolt.studio.diagnosis.stale')}</p>
			{:else if state === 'clean'}
				<p class="text-meta">{t('bolt.studio.diagnosis.clean')}</p>
			{/if}
		</Stack>
		<Button
			type="button"
			size="sm"
			variant="outline"
			class="h-7 px-2 text-micro"
			disabled={busy}
			onclick={() => onrerun?.()}
		>
			<Icon icon="lucide:stethoscope" class="size-3.5" />
			{t('bolt.studio.diagnosis.rerun')}
		</Button>
	</Inline>

	{#if groups.length === 0 && state !== 'missing'}
		<p class="text-meta">{t('bolt.studio.noDiagnosisFindings')}</p>
	{:else if groups.length > 0}
		<Scroll name={t('bolt.studio.diagnosis')} class="max-h-56">
			<Stack gap="sm">
				{#each groups as group (group.file)}
					<Stack gap="xs">
						<p class="font-mono text-micro font-semibold text-foreground">{group.file}</p>
						<ul class="divide-y divide-border/40">
							{#each group.findings as finding (`${finding.rule}:${finding.location}`)}
								<li class={cn('border-l-2 py-1.5 pl-2', toneClass(finding.severity))}>
									<button
										type="button"
										class="w-full text-left"
										onclick={() => onopenSource?.(diagnosisFindingPath(finding.location))}
									>
										<span class="block text-micro font-medium">
											{severityWord(finding.severity)} · {finding.rule}
										</span>
										<span class="block text-xs text-foreground">{finding.summary}</span>
										<span class="block font-mono text-micro text-muted-foreground">
											{finding.location}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					</Stack>
				{/each}
			</Stack>
		</Scroll>
	{/if}
</Stack>
