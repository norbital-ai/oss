<script lang="ts">
	import { Schema } from 'effect';
	import type { FieldRendererProps } from '@norbital-ai/ui/data-renderer';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Root as Progress } from '@norbital-ai/ui/progress';
	import { useI18n } from '@norbital-ai/ui/i18n';

	let { value, class: className }: FieldRendererProps = $props();
	const { t } = useI18n();
	const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
	const isNumber = Schema.is(Schema.Number);
	const isString = Schema.is(Schema.String);
	const progress = $derived.by(() => {
		if (!isRecord(value)) return undefined;
		const fraction = Reflect.get(value, 'progress');
		const text = Reflect.get(value, 'text');
		if (!isNumber(fraction) || !Number.isFinite(fraction)) return undefined;
		return {
			percent: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
			message: isString(text) && text.trim() !== '' ? text : undefined
		};
	});
</script>

{#if progress === undefined}
	<span class="text-muted-foreground {className}">{t('bolt.automations.progress.notReported')}</span
	>
{:else}
	<Stack
		gap="xs"
		class="min-w-52 max-w-md py-1 {className}"
		aria-label={progress.message === undefined
			? t('bolt.automations.progress.aria', { percent: progress.percent })
			: t('bolt.automations.progress.ariaWithMessage', {
					percent: progress.percent,
					message: progress.message
				})}
	>
		<Inline align="center" justify="between" gap="md">
			<span class="truncate text-xs text-muted-foreground">
				{progress.message ?? t('bolt.automations.progress.inProgress')}
			</span>
			<span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
				{progress.percent}%
			</span>
		</Inline>
		<Progress value={progress.percent} max={100} />
	</Stack>
{/if}
