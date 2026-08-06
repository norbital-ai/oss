<script lang="ts">
	import { mount, unmount, type Component } from 'svelte';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { SiteViewerProps } from './site_viewer.types.js';

	/**
	 * Lazy mount for the viewer.
	 *
	 * The viewer pulls a rendering runtime from a CDN and spins up a tessellation
	 * worker, so it is only loaded once a panel that shows a model is on screen.
	 * Every prop is forwarded, including the controlled layer visibility.
	 */
	let props: SiteViewerProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const viewerModule = import('./site_viewer.svelte');

	function mountViewer(node: HTMLElement, module: { default: Component<SiteViewerProps> }) {
		const instance = mount(module.default, { target: node, props });
		return {
			destroy() {
				unmount(instance);
			}
		};
	}
</script>

<div class="relative h-full w-full">
	{#await viewerModule}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/80 text-sm text-muted-foreground"
		>
			{t('component.loading_site_viewer')}
		</Inline>
	{:then module}
		<div class="h-full w-full" use:mountViewer={module}></div>
	{:catch error}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/80 px-6 text-center text-sm text-destructive"
		>
			{String(error)}
		</Inline>
	{/await}
</div>
