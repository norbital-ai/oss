<script lang="ts">
	import Icon from '@iconify/svelte';
	import Button, { type ButtonProps } from '../button/button.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { onDestroy } from 'svelte';

	const { t } = useI18n<UiKeys>();

	let {
		data,
		size = 'icon',
		variant = 'ghost',
		class: className = '',
		...restProps
	}: ButtonProps & {
		data?: unknown;
	} = $props();

	let copied = $state(false);
	let timeoutId = $state<ReturnType<typeof setTimeout> | null>(null);

	onDestroy(() => {
		if (timeoutId) clearTimeout(timeoutId);
	});

	function handleCopy(e: MouseEvent) {
		e.stopPropagation();

		const textToCopy = typeof data === 'object' ? JSON.stringify(data) : String(data);
		navigator.clipboard.writeText(textToCopy);

		copied = true;

		// Clear any existing timeout
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		// Reset after 2 seconds
		timeoutId = setTimeout(() => {
			copied = false;
			timeoutId = null;
		}, 2000);
	}
</script>

<Button
	{size}
	{variant}
	onclick={handleCopy}
	title={copied ? t('dataRenderer.copied') : t('common.copy')}
	class="transition-all {className} {size === 'icon' ? 'h-8 w-8' : ''}"
	{...restProps}
>
	{#if copied}
		<Icon icon="lucide:check" class="h-4 w-4 text-success" />
	{:else}
		<Icon icon="lucide:copy" class="h-4 w-4" />
	{/if}
</Button>
