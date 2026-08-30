<script lang="ts">
	import type { FieldRendererProps } from '@norbital-ai/ui/data-renderer';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Root as Progress } from '@norbital-ai/ui/progress';

	let { value, class: className }: FieldRendererProps = $props();
	const progress = $derived.by(() => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
		const fraction = Reflect.get(value, 'progress');
		const text = Reflect.get(value, 'text');
		if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined;
		return {
			percent: Math.round(Math.min(1, Math.max(0, fraction)) * 100),
			message: typeof text === 'string' && text.trim() !== '' ? text : undefined
		};
	});
</script>

{#if progress === undefined}
	<span class={['text-muted-foreground', className]}>Not reported</span>
{:else}
	<Stack
		gap="xs"
		class={['min-w-52 max-w-md py-1', className]}
		aria-label={`${progress.percent}%${progress.message ? `, ${progress.message}` : ''}`}
	>
		<Inline gap="sm" align="center" justify="between">
			<span class="shrink-0 text-sm font-semibold tabular-nums text-foreground"
				>{progress.percent}%</span
			>
			<span class="min-w-0 truncate text-sm text-muted-foreground" title={progress.message}
				>{progress.message ?? 'In progress'}</span
			>
		</Inline>
		<Progress value={progress.percent} class="h-1.5" />
	</Stack>
{/if}
