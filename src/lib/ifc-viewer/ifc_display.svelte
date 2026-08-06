<script lang="ts">
	import { mount, unmount, type Component } from 'svelte';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { IFCViewerProps } from './ifc_viewer.types';

	let props: IFCViewerProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const viewerModule = import('./ifc_viewer.svelte');

	function mountViewer(node: HTMLElement, mod: { default: Component<IFCViewerProps> }) {
		const instance = mount(mod.default, { target: node, props });
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
			{t('component.loading_viewer')}
		</Inline>
	{:then mod}
		<div class="h-full w-full" use:mountViewer={mod}></div>
	{:catch error}
		<Inline
			align="center"
			justify="center"
			class="absolute inset-0 bg-background/80 text-sm text-destructive"
		>
			{String(error)}
		</Inline>
	{/await}
</div>
