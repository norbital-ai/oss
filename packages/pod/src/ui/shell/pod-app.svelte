<script lang="ts">
	import { Toaster } from '@norbital-ai/ui/sonner';
	import { provideI18n, useI18n } from '@norbital-ai/ui/i18n';
	import { STORED_LOCALE_KEY, parseLocale, type LocaleCatalogs } from '@norbital-ai/std/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import { onMount, untrack } from 'svelte';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { TenantWorkspaceShellData } from '$lib/ui/state/workspace_shell_types.js';
	import type { WorkspaceAppLoader } from '$lib/ui/state/client.js';
	import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
	import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
	import PodShell from './pod-shell.svelte';
	import { ModeWatcher } from 'mode-watcher';

	let {
		apps,
		collectionSurfaces,
		customTypeRenderers,
		i18nMessages,
		shellData
	}: {
		apps: Readonly<Record<string, WorkspaceAppLoader>>;
		collectionSurfaces: CollectionSurfaceRegistry;
		customTypeRenderers: CustomTypeRendererMap;
		i18nMessages: LocaleCatalogs;
		shellData: Promise<{
			data: TenantWorkspaceShellData;
			workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		}>;
	} = $props();

	provideI18n(untrack(() => i18nMessages));

	const i18n = useI18n<PodUiKeys>();
	const { t } = i18n;

	onMount(() => {
		document.body.dataset.hydrated = 'true';

		// Cross-frame propagation: the host surfaces this workspace mounts live in same-origin frames,
		// and a locale toggle inside one of them must reach the shell. `storage` fires in every
		// same-origin window except the writer's, so listening here plus the host-side listener covers
		// both directions, and open tabs of the same origin sync too.
		const onStorage = (event: StorageEvent): void => {
			if (event.key !== STORED_LOCALE_KEY) return;
			const locale = parseLocale(event.newValue);
			if (locale && locale !== i18n.locale) i18n.setLocale(locale);
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	});
</script>

<ModeWatcher />
<Toaster />

{#await shellData}
	<div
		class="h-dvh w-screen bg-background"
		role="status"
		aria-live="polite"
		aria-label={t('pod.shell.prepareWorkspace')}
	></div>
{:then initialized}
	<PodShell
		{apps}
		{collectionSurfaces}
		{customTypeRenderers}
		workspaceApi={initialized.workspaceApi}
		data={initialized.data}
	/>
{:catch error}
	<div class="grid h-dvh w-screen place-items-center bg-background p-6 text-destructive">
		{error instanceof Error ? error.message : String(error)}
	</div>
{/await}
