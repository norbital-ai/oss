<script lang="ts">
	import { humanize } from '@norbital-ai/std/string';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RendererProps } from './$types.js';
	import { photoSourceSchema } from './+definition.js';

	let props: RendererProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const parsed = $derived(photoSourceSchema.safeParse(props.value));
	const source = $derived(parsed.success ? parsed.data : null);
</script>

{#if source?.kind === 'channel'}
	<div class="min-w-0">
		<p class="truncate text-sm font-medium">
			{t('component.provider_channel', { provider: humanize(source.provider) })}
		</p>
		<p class="truncate text-xs text-muted-foreground">
			{t('component.conversation_message', {
				conversationId: source.conversation_id,
				messageId: source.message_id
			})}
		</p>
	</div>
{:else if source?.kind === 'workspace_upload'}
	<span class="text-sm">{t('component.workspace_upload')}</span>
{:else}
	<span class="text-sm text-destructive">{t('component.invalid_photo_source')}</span>
{/if}
