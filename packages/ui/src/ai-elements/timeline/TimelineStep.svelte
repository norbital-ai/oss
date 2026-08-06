<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline, Stack } from '#lib/layout';
	import { Shimmer } from '../shimmer';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getTimelineContext } from './timeline-context.svelte.js';

	const { t } = useI18n<UiKeys>();

	type TimelineStepStatus = 'complete' | 'active' | 'pending' | 'error' | 'aborted';

	interface TimelineStepProps extends HTMLAttributes<HTMLDivElement> {
		/**
		 * Icon name to display (defaults to lucide:dot)
		 */
		icon?: string;
		/**
		 * Label text for the step
		 */
		label: string;
		/**
		 * Optional description text
		 */
		description?: string;
		/**
		 * Status of the step
		 */
		status?: TimelineStepStatus;
		/**
		 * Additional content
		 */
		children?: Snippet;
		/**
		 * Optional actions rendered inline with the label
		 */
		headerActions?: Snippet<[unknown]>;
		/**
		 * Arguments passed to the header action snippet
		 */
		headerActionArgs?: unknown;
		/**
		 * Additional CSS classes
		 */
		class?: string;
		/**
		 * Animation delay in milliseconds (optional, auto-calculated if not provided)
		 */
		delay?: number;
		/**
		 * Enable shimmer effect on the label and description text
		 */
		shimmer?: boolean;
	}

	let {
		icon = 'lucide:dot',
		label,
		description,
		status = 'complete',
		children,
		headerActions,
		headerActionArgs,
		class: className,
		delay,
		shimmer = false,
		...restProps
	}: TimelineStepProps = $props();

	const context = getTimelineContext()();
	let isVisible = $state(false);
	let element = $state() as HTMLDivElement;

	const statusStyles = {
		complete: 'text-muted-foreground',
		active: 'text-foreground',
		pending: 'text-muted-foreground/50',
		error: 'text-red-700',
		aborted: 'text-amber-700'
	} satisfies Record<TimelineStepStatus, string>;

	const iconStyles = {
		complete: 'text-muted-foreground',
		active: 'text-foreground',
		pending: 'text-muted-foreground/50',
		error: 'text-red-600',
		aborted: 'text-amber-600'
	} satisfies Record<TimelineStepStatus, string>;

	const connectorStyles = {
		complete: 'bg-border',
		active: 'bg-border',
		pending: 'bg-border/60',
		error: 'bg-red-200',
		aborted: 'bg-amber-200'
	};

	// Calculate step index based on DOM position
	function getStepIndex(): number {
		if (!element?.parentElement) return 0;
		const steps = Array.from(element.parentElement.querySelectorAll('[data-timeline-step]'));
		return steps.indexOf(element);
	}

	watch(
		() => [context.isOpen, delay] as const,
		([isOpen, delayMs]) => {
			if (!isOpen) {
				isVisible = false;
				return;
			}
			const stepIndex = getStepIndex();
			const calculatedDelay = delayMs ?? stepIndex * 40;
			const timer = setTimeout(() => {
				isVisible = true;
			}, calculatedDelay);
			return () => clearTimeout(timer);
		}
	);
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div
	bind:this={element}
	data-timeline-step
	class={cn(
		'flex gap-2 text-xs transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
		statusStyles[status],
		isVisible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0 motion-reduce:translate-y-0',
		className
	)}
	{...restProps}
>
	<div class="relative flex w-4 shrink-0 justify-center pt-0.5">
		<Icon {icon} class={cn('size-3.5', iconStyles[status])} />
		<div class={cn('absolute top-6 bottom-0 left-1/2 -mx-px w-px', connectorStyles[status])}></div>
	</div>
	<Stack gap="sm" grow>
		{#if shimmer}
			<Shimmer content_length={label.length}>
				{label}
			</Shimmer>
		{:else}
			<Inline gap="sm" class="min-h-4">
				{#if description}
					<Tooltip delayDuration={150} side="top" sideOffset={8} contentClass="max-w-72">
						{#snippet trigger({ props })}
							<div
								{...props}
								class="min-w-0 flex-1 leading-4 font-medium"
								aria-label={t('misc.stepDetails', { label })}
							>
								{label}
							</div>
						{/snippet}
						{#snippet content()}
							<p>{description}</p>
						{/snippet}
					</Tooltip>
				{:else}
					<div class="min-w-0 flex-1 leading-4 font-medium">{label}</div>
				{/if}
				<Inline gap="xs" shrink={false}>
					{#if headerActions}
						{@render headerActions(headerActionArgs)}
					{/if}
				</Inline>
			</Inline>
		{/if}
		{#if children}
			{@render children()}
		{/if}
	</Stack>
</div>
