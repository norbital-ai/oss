<script lang="ts">
	import { Toaster } from '@norbital-ai/ui/sonner';
	import { onMount } from 'svelte';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { TenantWorkspaceShellData } from '$lib/client/workspace_shell_types.js';
	import type { WorkspaceAppLoader } from '$lib/runtime/client.js';
	import type { CollectionSurfaceRegistry } from '@norbital-ai/ui/collection-table';
	import type { CustomTypeRendererMap } from '@norbital-ai/ui/data-renderer';
	import PodShell from './pod-shell.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { Inline, Stack } from '@norbital-ai/ui/layout';

	let {
		apps,
		collectionSurfaces,
		customTypeRenderers,
		shellData
	}: {
		apps: Readonly<Record<string, WorkspaceAppLoader>>;
		collectionSurfaces: CollectionSurfaceRegistry;
		customTypeRenderers: CustomTypeRendererMap;
		shellData: Promise<{
			data: TenantWorkspaceShellData;
			workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		}>;
	} = $props();

	onMount(() => {
		document.body.dataset.hydrated = 'true';
	});
</script>

<ModeWatcher disableHeadScriptInjection />
<Toaster />

{#await shellData}
	<div class="grid h-dvh w-screen place-items-center bg-background text-foreground">
		<Stack gap="lg" class="-translate-y-4 items-center" role="status" aria-live="polite">
			<div class="relative h-24 w-32" aria-hidden="true">
				<div
					class="absolute inset-x-3 top-4 bottom-0 rounded-lg border border-border/50 bg-muted/25"
				></div>
				<div
					class="absolute inset-x-1.5 top-2 bottom-2 rounded-lg border border-border/70 bg-muted/45"
				></div>
				<!-- stupidity:allow UI5 -- loading window is a decorative clip boundary -->
				<div
					class="workspace-loader-window absolute inset-x-0 top-0 bottom-4 overflow-hidden rounded-lg border border-border bg-card shadow-card"
				>
					<Inline gap="xs" class="h-6 border-b border-border/70 px-3">
						<span class="size-1.5 rounded-full bg-muted-foreground/45"></span>
						<span class="h-1.5 w-12 rounded-full bg-muted-foreground/30"></span>
						<span class="ml-auto h-1.5 w-5 rounded-full bg-muted-foreground/25"></span>
					</Inline>
					<Stack gap="xs" class="px-3 py-2.5">
						<span class="h-1 w-20 rounded-full bg-muted-foreground/35"></span>
						<span class="h-1 w-14 rounded-full bg-muted-foreground/30"></span>
						<span class="h-1 w-16 rounded-full bg-muted-foreground/30"></span>
						<span class="h-1 w-10 rounded-full bg-muted-foreground/25"></span>
						<span class="h-1 w-24 rounded-full bg-muted-foreground/35"></span>
						<span class="h-1 w-12 rounded-full bg-muted-foreground/25"></span>
					</Stack>
				</div>
			</div>
			<p class="text-[15px] font-semibold tracking-[-0.01em]">Preparing your workspace…</p>
		</Stack>
	</div>
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

<style>
	.workspace-loader-window {
		animation: workspace-loader-pulse 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite alternate;
	}

	@keyframes workspace-loader-pulse {
		from {
			opacity: 0.62;
		}

		to {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace-loader-window {
			animation: none;
		}
	}
</style>
