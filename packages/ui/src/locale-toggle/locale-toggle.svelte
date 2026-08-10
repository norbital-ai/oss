<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';

	let { class: className = '', showLabel = true }: { class?: string; showLabel?: boolean } =
		$props();

	const i18n = useI18n<UiKeys>();
	const { t } = i18n;
	const nextLocale = $derived(
		i18n.locales[(i18n.locales.indexOf(i18n.locale) + 1) % i18n.locales.length] ?? i18n.locale
	);
	const nextLabel = $derived(
		i18n.has(`misc.localeName.${nextLocale}`)
			? t(`misc.localeName.${nextLocale}` as UiKeys)
			: nextLocale.toUpperCase()
	);

	function toggleLocale(): void {
		i18n.setLocale(nextLocale);
	}
</script>

<button
	type="button"
	onclick={toggleLocale}
	aria-label={t('misc.switchLocale', { locale: nextLabel })}
	title={t('misc.language')}
	class={cn(
		'inline-flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground',
		className
	)}
>
	<Icon icon="lucide:languages" class="size-4 shrink-0" />
	{#if showLabel}
		<span class="text-tiny font-semibold">{nextLabel}</span>
	{/if}
</button>
