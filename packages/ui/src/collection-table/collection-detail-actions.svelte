<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';

	const { t } = useI18n<UiKeys>();

	let {
		fullScreen,
		onToggleFullScreen,
		onClose
	}: {
		fullScreen: boolean;
		onToggleFullScreen: () => void;
		onClose: () => void;
	} = $props();
</script>

<Inline justify="end" gap="xs" shrink={false}>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="size-8"
		aria-label={fullScreen ? t('common.exitFullScreen') : t('common.enterFullScreen')}
		onclick={onToggleFullScreen}
	>
		<Icon icon={fullScreen ? 'lucide:minimize' : 'lucide:maximize'} class="size-4" />
	</Button>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="size-8"
		aria-label={t('table.closeRecordDetail')}
		onclick={onClose}
	>
		<Icon icon="lucide:x" class="size-4" />
	</Button>
</Inline>
