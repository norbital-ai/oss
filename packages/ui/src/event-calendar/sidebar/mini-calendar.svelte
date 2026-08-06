<script lang="ts">
	import { cn } from '#lib/utils';
	import { buttonVariants } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';
	import Icon from '@iconify/svelte';

	const { t } = useI18n<UiKeys>();
	const intlLocale = $derived(useI18n<UiKeys>().intlLocale);

	let {
		date,
		ondatechange,
		class: className
	}: {
		date: Date;
		ondatechange?: (d: Date) => void;
		class?: string;
	} = $props();

	const weekDays = $derived.by(() => {
		const formatter = new Intl.DateTimeFormat(intlLocale, { weekday: 'short' });
		return Array.from({ length: 7 }, (_, index) =>
			formatter.format(new Date(2024, 0, 1 + index)).slice(0, 2)
		);
	});

	const today = $derived(new Date());
	const currentMonth = $derived(date.getMonth());
	const currentYear = $derived(date.getFullYear());

	const firstOfMonth = $derived(new Date(currentYear, currentMonth, 1));
	const startDay = $derived((firstOfMonth.getDay() + 6) % 7);
	const daysInMonth = $derived(new Date(currentYear, currentMonth + 1, 0).getDate());

	const weeks = $derived.by(() => {
		const result: (number | null)[][] = [];
		let day = 1;
		for (let w = 0; w < 6; w++) {
			const week: (number | null)[] = [];
			for (let d = 0; d < 7; d++) {
				if ((w === 0 && d < startDay) || day > daysInMonth) {
					week.push(null);
				} else {
					week.push(day++);
				}
			}
			result.push(week);
			if (day > daysInMonth) break;
		}
		return result;
	});

	const monthLabel = $derived(
		firstOfMonth.toLocaleDateString(intlLocale, { month: 'long', year: 'numeric' })
	);

	function goPrevMonth() {
		const d = new Date(date);
		d.setMonth(d.getMonth() - 1);
		ondatechange?.(d);
	}

	function goNextMonth() {
		const d = new Date(date);
		d.setMonth(d.getMonth() + 1);
		ondatechange?.(d);
	}

	function selectDay(day: number) {
		const d = new Date(currentYear, currentMonth, day);
		ondatechange?.(d);
	}
</script>

<div class={cn('p-3 bg-card rounded-lg border border-border shadow-card', className)}>
	<Inline justify="between" gap="sm" class="pb-2">
		<button
			class={buttonVariants({ variant: 'ghost', size: 'icon' })}
			onclick={goPrevMonth}
			aria-label={t('misc.previousMonth')}
		>
			<Icon icon="lucide:chevron-left" class="size-3.5" />
		</button>
		<span class="text-sm font-semibold text-foreground">{monthLabel}</span>
		<button
			class={buttonVariants({ variant: 'ghost', size: 'icon' })}
			onclick={goNextMonth}
			aria-label={t('misc.nextMonth')}
		>
			<Icon icon="lucide:chevron-right" class="size-3.5" />
		</button>
		<span class="text-sm font-semibold text-foreground">{monthLabel}</span>
		<button
			class={buttonVariants({ variant: 'ghost', size: 'icon' })}
			onclick={goNextMonth}
			aria-label={t('misc.nextMonth')}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg
			>
		</button>
	</Inline>

	<div class="grid grid-cols-7 text-center mb-1">
		{#each weekDays as day}
			<span class="text-tiny font-medium text-muted-foreground uppercase tracking-wider py-0.5">
				{day}
			</span>
		{/each}
	</div>

	<div class="grid grid-cols-7">
		{#each weeks as week}
			{#each week as day}
				{#if day !== null}
					{@const isToday =
						currentYear === today.getFullYear() &&
						currentMonth === today.getMonth() &&
						day === today.getDate()}
					<button
						class={cn(
							'size-[28px] mx-auto my-0.5 rounded-full text-micro font-medium transition-colors',
							'hover:bg-accent',
							isToday && 'bg-brand text-brand-foreground hover:bg-brand-600',
							!isToday && 'text-foreground'
						)}
						onclick={() => selectDay(day)}
					>
						{day}
					</button>
				{:else}
					<div class="size-[28px] mx-auto my-0.5"></div>
				{/if}
			{/each}
		{/each}
	</div>
</div>
