<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import type { WorkbenchView } from '#lib/client/ui/studio/studio-state.js';

	let {
		hostStatus,
		view = 'manifest',
		previewReady = false,
		updateRequired = false,
		updateDisabled = false,
		updateReason,
		previewDisabled = true,
		previewReason,
		reviewRequested = false,
		reviewDisabled = true,
		reviewReason,
		onview,
		onpreview,
		onreview,
		onopenreview,
		onrebase
	}: {
		hostStatus: string;
		view?: WorkbenchView;
		previewReady?: boolean;
		updateRequired?: boolean;
		updateDisabled?: boolean;
		updateReason: string;
		previewDisabled?: boolean;
		previewReason: string;
		reviewRequested?: boolean;
		reviewDisabled?: boolean;
		reviewReason: string;
		onview?: ((next: WorkbenchView) => void) | undefined;
		onpreview?: (() => void) | undefined;
		onreview?: (() => void) | undefined;
		onopenreview?: (() => void) | undefined;
		onrebase?: (() => void) | undefined;
	} = $props();
</script>

<Inline shrink={false} class="h-10 border-b border-border/60 sm:h-9">
	<Scroll name="Workbench toolbar" axis="x" layout="inline" gap="xs" grow class="min-w-0">
		<Tabs
			value={view}
			onValueChange={(next) => {
				if (next === 'manifest' || next === 'editor') onview?.(next);
			}}
			showContent={false}
			animate={false}
			variant="underline"
			listClass="mx-1"
			config={[
				{ name: 'manifest', label: 'Manifest', icon: 'lucide:braces', content: '' },
				{ name: 'editor', label: 'Editor', icon: 'lucide:code-2', content: '' }
			] satisfies TabConfig[]}
		/>
		{#if hostStatus !== 'Ready'}
			<Inline
				as="span"
				gap="xs"
				shrink={false}
				class="min-w-0 px-1 text-micro text-amber-700 dark:text-amber-300"
				data-testid="studio-host-status"
				role="status"
			>
				<Icon icon="lucide:circle-alert" class="size-3 shrink-0" />
				<span class="max-w-72 truncate">{hostStatus}</span>
			</Inline>
		{:else if previewReady}
			<Inline
				as="span"
				gap="xs"
				shrink={false}
				class="px-1 text-micro text-emerald-700 dark:text-emerald-300"
				data-testid="studio-preview-status"
				role="status"
			>
				<Icon icon="lucide:circle-check" class="size-3 shrink-0" />
				<span>Ready for review</span>
			</Inline>
		{/if}
	</Scroll>

	<Inline gap="xs" shrink={false}>
		{#if updateRequired}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={updateDisabled}
				disabledMessage={updateReason}
				data-testid="studio-rebase"
				onclick={() => onrebase?.()}
			>
				<Icon icon="lucide:git-rebase" class="size-3.5" />
				Rebase
			</Button>
		{:else if previewReady}
			<Button
				type="button"
				variant="outline"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={previewDisabled}
				disabledMessage={previewReason}
				data-testid="studio-preview"
				onclick={() => onpreview?.()}
			>
				<Icon icon="lucide:external-link" class="size-3.5" />
				Open Preview
			</Button>
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={!reviewRequested && reviewDisabled}
				disabledMessage={reviewReason}
				data-testid={reviewRequested ? 'studio-open-review' : 'studio-request-review'}
				onclick={() => (reviewRequested ? onopenreview?.() : onreview?.())}
			>
				<Icon icon="lucide:git-pull-request" class="size-3.5" />
				{reviewRequested ? 'Open review' : 'Request review'}
			</Button>
		{:else}
			<Button
				type="button"
				variant="default"
				size="sm"
				class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
				disabled={previewDisabled}
				disabledMessage={previewReason}
				data-testid="studio-preview"
				onclick={() => onpreview?.()}
			>
				<Icon icon="lucide:scan-eye" class="size-3.5" />
				Preview
			</Button>
		{/if}
	</Inline>
</Inline>
