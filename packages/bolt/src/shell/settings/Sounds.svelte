<script lang="ts">
	import { Button, Icon } from '@norbital-ai/ui';
	import { Stack, Inline } from '@norbital-ai/ui/layout';
	import type { SoundStatus } from '../sounds.ts';

	let {
		enabled,
		status,
		on_change,
		on_test,
		t
	}: {
		enabled: boolean;
		status: SoundStatus;
		on_change: (enabled: boolean) => void;
		on_test: () => void;
		t: (key: string) => string;
	} = $props();
</script>

<Stack gap="lg">
	<Stack gap="sm">
		<Button
			variant="outline"
			role="switch"
			aria-checked={enabled}
			aria-label={t('Play sounds')}
			class="w-full justify-start"
			onclick={() => on_change(!enabled)}
		>
			<Icon name={enabled ? 'lucide:volume-1' : 'lucide:volume-x'} class="size-4" />
			<span>{t('Play sounds')}</span><span class="ml-auto">{t(enabled ? 'On' : 'Off')}</span>
		</Button>
		<p class="text-sm text-muted-foreground">
			{t(
				'Chimes for notifications, approvals and Norbius completions. Saved for your account in this browser.'
			)}
		</p>
	</Stack>
	<Stack gap="sm">
		<Inline
			><Button variant="outline" disabled={!enabled || status === 'unavailable'} onclick={on_test}>
				<Icon name="lucide:play" class="size-4" />{t('Test sound')}
			</Button></Inline
		>
		<p role="status" class="text-sm text-muted-foreground">
			{#if !enabled}{t('Sounds are off.')}
			{:else if status === 'unavailable'}{t('This browser does not support sound playback.')}
			{:else if status === 'needs-gesture'}{t('Click Test sound to enable audio in this browser.')}
			{:else if status === 'blocked'}{t(
					'Audio is blocked or paused. Allow sound in your browser’s site settings, then click Test sound.'
				)}
			{:else}{t(
					'Browser audio is ready. If you hear nothing, check the tab’s mute setting and your device volume.'
				)}{/if}
		</p>
	</Stack>
</Stack>
