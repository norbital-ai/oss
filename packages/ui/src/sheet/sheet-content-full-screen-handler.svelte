<script lang="ts">
	import Icon from '@iconify/svelte';

	import { Button } from '#lib/button';
	import { Tooltip } from '#lib/tooltip';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { onDestroy, onMount } from 'svelte';

	let {
		fullScreen = $bindable(),
		ref = $bindable(),
		class: className = '',
		previousSibling,
		side = 'right'
	}: {
		fullScreen: boolean;
		ref: HTMLElement | null;
		class?: string;
		previousSibling?: HTMLElement;
		side?: 'left' | 'right' | 'top' | 'bottom';
	} = $props();

	const sidebar = document.getElementById('sidebar');
	const { t } = useI18n<UiKeys>();

	const handleClick = () => {
		if (ref) {
			fullScreen = !fullScreen;
			if (fullScreen) {
				ref.style.width = '100%';
			} else {
				ref.style.width = '50%';
			}
		}
	};

	const sheetContentResizeObserver = new ResizeObserver((entries) => {
		if (previousSibling && ref) {
			for (const entry of entries) {
				if (entry.target === ref) {
					const el = entry.target as HTMLElement;
					const width = el.offsetWidth; // Get the current width
					const maxWidth = parseInt(el.style.maxWidth, 10);
					fullScreen = Math.abs(width - maxWidth) <= 1; // A rough margin
				}
			}
		}
	});

	const sidebarResizeObserver = new ResizeObserver((entries) => {
		for (const entry of entries) {
			if (entry.target === sidebar) {
				let width = (entry.target as HTMLElement).offsetWidth; // Get the current sidebar width
				const maxWidth = (ref as HTMLElement).parentElement?.offsetWidth
					? (ref?.parentElement as HTMLElement)?.offsetWidth - width
					: window.innerWidth - width; // Get the maximum possible width (parent container or viewport)
				(ref as HTMLElement).style.maxWidth = `${maxWidth}px`;
			}
		}
	});
	const updateMaxWidth = () => {
		if (ref && sidebar && previousSibling) {
			const sidebarWidth = sidebar.offsetWidth; // Get the current sidebar width
			let maxWidth = 0;
			if (previousSibling === sidebar) {
				maxWidth = ref.parentElement?.offsetWidth
					? ref.parentElement.offsetWidth - sidebarWidth
					: window.innerWidth; // Parent container width or viewport width
			} else {
				maxWidth = previousSibling.offsetWidth - previousSibling.offsetWidth * 0.05;
			}
			ref.style.maxWidth = `${maxWidth}px`;
			if (fullScreen) {
				ref.style.width = `${maxWidth}px`;
			}
		}
	};

	onMount(() => {
		if (ref) {
			if (fullScreen) {
				ref.style.width = `100%`;
			} else {
				ref.style.width = `50%`;
			}
			sheetContentResizeObserver.observe(ref);
			const firstSheetContent = document.querySelector('[data-dialog-content]');
			window.addEventListener('resize', updateMaxWidth);

			if (ref === firstSheetContent && sidebar) {
				sidebarResizeObserver.observe(sidebar);
			}
		}
	});

	onDestroy(() => {
		window.removeEventListener('resize', updateMaxWidth);
		sheetContentResizeObserver.disconnect();
		sidebarResizeObserver.disconnect();
	});
</script>

<Tooltip align="start" delayDuration={100}>
	{#snippet trigger({ props })}
		<Button
			{...props}
			size="icon"
			class={cn('bg-transparent hover:bg-transparent', className)}
			onclick={handleClick}
		>
			{#if fullScreen}
				<Icon
					icon="pepicons-pop:contract"
					width="22"
					height="22"
					class="text-muted-foreground transition-colors duration-300 hover:text-secondary-foreground"
				/>
			{:else}
				<Icon
					icon="pepicons-pop:expand"
					width="22"
					height="22"
					class="text-muted-foreground transition-colors duration-300 hover:text-secondary-foreground"
				/>
			{/if}
		</Button>
	{/snippet}
	{#snippet content()}
		<p>
			{#if fullScreen}{t('table.collapse')}{:else}{t('table.expand')}{/if}
		</p>
	{/snippet}
</Tooltip>
