<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Root as Progress } from '@norbital-ai/ui/progress';
	import { cn } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import {
		presentAutomationStatus,
		type AutomationRunStatus
	} from './automation-presentation.js';

	let { record }: { record: Record<string, unknown> | null; close: () => void } = $props();
	const { t } = useI18n();
	const text = (name: string): string | undefined => {
		const value = record?.[name];
		return typeof value === 'string' && value.trim() !== '' ? value : undefined;
	};
	const progress = $derived.by(() => {
		const value = record?.['progress'];
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const fraction = Reflect.get(value, 'progress');
		const message = Reflect.get(value, 'text');
		if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
		return {
			percent: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
			message: typeof message === 'string' && message.trim() !== '' ? message : undefined
		};
	});
	const status = $derived(text('status') ?? 'unknown');
	const statusLabel = $derived(
		status === 'pending' || status === 'running' || status === 'done' || status === 'failed'
			? t(presentAutomationStatus(status satisfies AutomationRunStatus).messageKey)
			: t('bolt.automations.status.unknown')
	);
	const result = $derived(record?.['result']);
	const error = $derived(text('error'));
	const printableResult = $derived(
		result == null
			? undefined
			: typeof result === 'string'
				? result
				: JSON.stringify(result, null, 2)
	);
	const timestamp = (name: string): string => {
		const value = text(name);
		if (value === undefined) return '—';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
	};
</script>

<Stack gap="lg" class="p-5" aria-live="polite">
	<Inline gap="md" align="center">
		<div
			class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500"
		>
			<Icon icon="lucide:refresh-cw" class={cn('size-5', status === 'running' && 'animate-spin')} />
		</div>
		<Stack gap="xs" class="min-w-0">
			<p class="truncate text-base font-semibold text-foreground">
				{text('name') ?? t('bolt.automations.run')}
			</p>
			<span
				class={cn(
					'w-fit rounded-full px-2 py-0.5 text-xs font-semibold capitalize',
					status === 'done' && 'bg-success/10 text-success',
					status === 'running' && 'bg-brand/10 text-brand',
					status === 'failed' && 'bg-destructive/10 text-destructive',
					!['done', 'running', 'failed'].includes(status) && 'bg-muted text-muted-foreground'
				)}
			>
				{statusLabel}
			</span>
		</Stack>
	</Inline>

	<Stack gap="sm" class="rounded-lg border bg-card p-4">
		<Inline justify="between" align="center" gap="md">
			<h3 class="text-sm font-semibold text-foreground">{t('bolt.automations.currentProgress')}</h3>
			<span class="text-sm font-semibold tabular-nums text-foreground"
				>{progress?.percent ?? 0}%</span
			>
		</Inline>
		<Progress value={progress?.percent ?? 0} class="h-2" />
		<p class="text-sm text-muted-foreground">
			{progress?.message ?? t('bolt.automations.noProgressMessage')}
		</p>
	</Stack>

	<Stack gap="sm">
		<h3 class="text-sm font-semibold text-foreground">{t('bolt.automations.runDetails')}</h3>
		<Grid as="dl" gap="sm" tracks="minmax(7rem,auto) minmax(0,1fr)" class="text-sm">
			<dt class="text-muted-foreground">{t('bolt.automations.taskId')}</dt>
			<dd class="break-all font-mono text-xs text-foreground">{text('task_id') ?? '—'}</dd>
			<dt class="text-muted-foreground">{t('bolt.automations.started')}</dt>
			<dd class="text-foreground">{timestamp('created_at')}</dd>
			<dt class="text-muted-foreground">{t('bolt.automations.lastUpdate')}</dt>
			<dd class="text-foreground">{timestamp('progress_updated_at')}</dd>
			<dt class="text-muted-foreground">{t('bolt.automations.checkpoints')}</dt>
			<dd class="tabular-nums text-foreground">{String(record?.['progress_sequence'] ?? 0)}</dd>
		</Grid>
	</Stack>

	{#if error}
		<Stack gap="xs" class="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			<h3 class="text-sm font-semibold text-destructive">{t('bolt.automations.failure')}</h3>
			<p class="whitespace-pre-wrap text-sm text-destructive">{error}</p>
		</Stack>
	{:else if printableResult}
		<Stack gap="xs">
			<h3 class="text-sm font-semibold text-foreground">{t('bolt.automations.result')}</h3>
			<Scroll name="Automation result" class="max-h-72">
			<pre
				class="rounded-lg border bg-muted/40 p-3 text-xs text-foreground">{printableResult}</pre>
			</Scroll>
		</Stack>
	{/if}
</Stack>
