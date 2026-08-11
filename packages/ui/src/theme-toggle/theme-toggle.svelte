<script lang="ts">
	import { mode, toggleMode } from 'mode-watcher';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';

	let { class: className = '' }: { class?: string } = $props();

	const isDark = $derived(mode.current === 'dark');
	const { t } = useI18n<UiKeys>();
</script>

<button
	type="button"
	onclick={() => toggleMode()}
	aria-label={t(isDark ? 'misc.switchToLightMode' : 'misc.switchToDarkMode')}
	class={cn(
		'inline-flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground',
		className
	)}
>
	<!-- Sun icon (shown in dark mode) -->
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={cn('size-4 transition-all', isDark ? 'scale-100 rotate-0' : 'scale-0 rotate-90')}
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2" />
		<path d="M12 20v2" />
		<path d="m4.93 4.93 1.41 1.41" />
		<path d="m17.66 17.66 1.41 1.41" />
		<path d="M2 12h2" />
		<path d="M20 12h2" />
		<path d="m6.34 17.66-1.41 1.41" />
		<path d="m19.07 4.93-1.41 1.41" />
	</svg>
	<!-- Moon icon (shown in light mode) -->
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={cn(
			'absolute size-4 transition-all',
			isDark ? 'scale-0 rotate-90' : 'scale-100 rotate-0'
		)}
		aria-hidden="true"
	>
		<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
	</svg>
</button>
