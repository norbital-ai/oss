<script lang="ts">
	import { Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Root as Progress } from '@norbital-ai/ui/progress';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import AutomationStatusRenderer from './automation-status.renderer.svelte';

	let { record }: { record: Record<string, unknown> | null; close: () => void } = $props();
	const { t } = useI18n();
	const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
	const isNumber = Schema.is(Schema.Number);
	const isString = Schema.is(Schema.String);
	const text = (name: string): string | undefined => {
		const value = record?.[name];
		return isString(value) && value.trim() !== '' ? value : undefined;
	};
	const progress = $derived.by(() => {
		const value = record?.['progress'];
		if (!isRecord(value)) return undefined;
		const fraction = Reflect.get(value, 'progress');
		const message = Reflect.get(value, 'text');
		if (!isNumber(fraction) || !Number.isFinite(fraction)) return undefined;
		return {
			percent: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
			message: isString(message) && message.trim() !== '' ? message : undefined
		};
	});
	const status = $derived(text('status') ?? 'unknown');
	const result = $derived(record?.['result']);
	const error = $derived(text('error'));
	const printableResult = $derived(
		result == null ? undefined : isString(result) ? result : JSON.stringify(result, null, 2)
	);
	const resultLanguage = $derived.by((): 'json' | 'plaintext' => {
		if (printableResult === undefined) return 'plaintext';
		const trimmed = printableResult.trimStart();
		return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'plaintext';
	});
	const timestamp = (name: string): string => {
		const value = text(name);
		if (value === undefined) return '—';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
	};
</script>

<Stack gap="lg" class="p-5" aria-live="polite">
	<Inline justify="between" align="center" gap="md">
		<Inline gap="md" align="center" class="min-w-0">
			<div
				class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500"
			>
				<Icon
					icon="lucide:refresh-cw"
					class="size-5 {status === 'running' ? 'animate-spin' : ''}"
				/>
			</div>
			<Stack gap="xs" class="min-w-0">
				<p class="truncate text-base font-semibold text-foreground">
					{text('name') ?? t('bolt.automations.run')}
				</p>
				<p class="truncate text-xs text-muted-foreground">
					{progress?.message ?? t('bolt.automations.noProgressMessage')}
				</p>
			</Stack>
		</Inline>
		<Inline gap="sm" align="center" class="shrink-0">
			<Progress value={progress?.percent ?? 0} class="h-1.5 w-24" />
			<span class="text-xs font-semibold tabular-nums text-foreground"
				>{progress?.percent ?? 0}%</span
			>
			<AutomationStatusRenderer value={status} row={record ?? {}} class="capitalize" />
		</Inline>
	</Inline>

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
			<!-- No max height: a constrained editor keeps its own scroller and swallows the sheet's
			     wheel. Let the editor size to its content so vertical scrolling belongs to the sheet. -->
			<CodeEditor
				value={printableResult}
				language={resultLanguage}
				readonly
				ariaLabel={t('bolt.automations.result')}
				minHeight="7rem"
				class="w-full rounded-lg border bg-muted/40 shadow-none"
			/>
		</Stack>
	{/if}
</Stack>
