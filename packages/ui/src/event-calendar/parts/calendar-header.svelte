<script lang="ts">
	import Icon from '@iconify/svelte';
	import { cn } from '#lib/utils';
	import { buttonVariants } from '#lib/button';
	import { Inline } from '#lib/layout';
	import { navigateView } from '../utils.js';
	import type { CalendarView } from '../types.js';

	let {
		view = 'week',
		date,
		views = ['day', 'week', 'month'],
		onviewchange,
		ondatechange,
		readonly = false,
		class: className
	}: {
		view?: CalendarView;
		date: Date;
		views?: CalendarView[];
		onviewchange?: (v: CalendarView) => void;
		ondatechange?: (d: Date) => void;
		readonly?: boolean;
		class?: string;
	} = $props();

	const viewLabels: Record<CalendarView, string> = {
		day: 'Day',
		week: 'Week',
		month: 'Month'
	};

	function goToday() {
		ondatechange?.(new Date());
	}

	function goPrev() {
		ondatechange?.(navigateView(view, date, 'prev'));
	}

	function goNext() {
		ondatechange?.(navigateView(view, date, 'next'));
	}

	function titleForView(): string {
		const today = new Date();
		switch (view) {
			case 'day':
				if (
					date.getFullYear() === today.getFullYear() &&
					date.getMonth() === today.getMonth() &&
					date.getDate() === today.getDate()
				) {
					return 'Today';
				}
				return date.toLocaleDateString('en-US', {
					weekday: 'long',
					month: 'long',
					day: 'numeric',
					year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
				});
			case 'week': {
				const start = new Date(date);
				start.setDate(start.getDate() - start.getDay() + (start.getDay() === 0 ? -6 : 1));
				const end = new Date(start);
				end.setDate(end.getDate() + 6);
				const startStr = start.toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric'
				});
				const endStr = end.toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					year: end.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
				});
				return `${startStr} – ${endStr}`;
			}
			case 'month': {
				const str = date.toLocaleDateString('en-US', {
					month: 'long',
					year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
				});
				return str;
			}
		}
	}
</script>

<header
	class={cn(
		'flex items-center justify-between px-4 py-2.5 bg-card border-b border-border',
		className
	)}
>
	<Inline gap="md">
		<Inline gap="xs">
			<button
				class={buttonVariants({ variant: 'ghost', size: 'icon' })}
				onclick={goPrev}
				aria-label="Previous"
			>
				<Icon icon="lucide:chevron-left" class="size-4" />
			</button>
			<button
				class={cn(buttonVariants({ variant: 'ghost' }), 'h-7 px-2.5 text-xs font-medium')}
				onclick={goToday}
			>
				Today
			</button>
			<button
				class={buttonVariants({ variant: 'ghost', size: 'icon' })}
				onclick={goNext}
				aria-label="Next"
			>
				<Icon icon="lucide:chevron-right" class="size-4" />
			</button>
		</Inline>
		<span class="text-sm font-semibold text-foreground select-none">
			{titleForView()}
		</span>
	</Inline>

	<div class="flex items-center">
		<div class="flex border border-border rounded-sm bg-muted/40 p-0.5">
			{#each views as v}
				<button
					class={cn(
						'px-3 py-1 text-xs font-medium rounded-sm transition-colors',
						v === view
							? 'bg-background text-foreground shadow-xs'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => onviewchange?.(v)}
				>
					{viewLabels[v]}
				</button>
			{/each}
		</div>
	</div>
</header>
