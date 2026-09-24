<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Schema } from 'effect';
	import type { FieldRendererProps } from '@norbital-ai/ui/data-renderer';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { cn } from '@norbital-ai/ui/utils';
	import { presentAutomationStatus, type AutomationRunStatus } from './automation-presentation.js';

	/** The status badge of one run row; while the run can stop, hovering the badge offers Stop. */
	let {
		value,
		row,
		class: className,
		onStop
	}: Pick<FieldRendererProps, 'value' | 'row' | 'class'> & {
		onStop?: (taskId: string) => void;
	} = $props();
	const { t } = useI18n();
	const isStatus = Schema.is(Schema.Literals(['pending', 'running', 'done', 'failed', 'stopped']));
	const status = $derived<AutomationRunStatus | undefined>(isStatus(value) ? value : undefined);
	const presentation = $derived(presentAutomationStatus(status));
	const taskId = $derived(typeof row?.['task_id'] === 'string' ? row['task_id'] : undefined);
	const error = $derived(row?.['error']);
	const label = $derived(
		status === 'pending' && typeof error === 'string' && error !== ''
			? t('bolt.automations.status.retrying')
			: t(presentation.messageKey)
	);
	const stoppable = $derived(presentation.canStop && taskId !== undefined && onStop !== undefined);
	const tone = $derived(
		status === 'done'
			? 'bg-success/10 text-success'
			: status === 'running' || status === 'pending'
				? 'bg-brand/10 text-brand'
				: status === 'failed'
					? 'bg-destructive/10 text-destructive'
					: 'bg-muted text-muted-foreground'
	);
</script>

{#if stoppable && taskId !== undefined}
	<!-- One fixed width for both faces, so the hover swap never moves the row. -->
	<button
		type="button"
		class={cn(
			'inline-block min-w-26 rounded-full px-2 py-0.5 text-center text-xs font-semibold',
			tone,
			className,
			'group cursor-pointer hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none'
		)}
		aria-label={t('bolt.automations.stop')}
		onclick={(event) => {
			event.stopPropagation();
			onStop?.(taskId);
		}}
	>
		<span class="group-hover:hidden group-focus-visible:hidden">{label}</span>
		<span class="hidden group-hover:inline group-focus-visible:inline">
			<Icon icon="lucide:square" class="mr-1 size-3" />
			{t('bolt.automations.stop')}
		</span>
	</button>
{:else}
	<span
		class={cn(
			'inline-block min-w-26 rounded-full px-2 py-0.5 text-center text-xs font-semibold',
			tone,
			className
		)}>{label}</span
	>
{/if}
