<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import type { WorkbenchView } from '#lib/client/ui/studio/studio-state.js';
	import { presentWorkbenchStatus } from '#lib/client/ui/studio/workbench-status-presentation.js';

	let {
		hostStatus,
		busy = false,
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
		busy?: boolean;
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

	const toolbarStatus = $derived(presentWorkbenchStatus({ hostStatus, busy, previewReady }));
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
		{#if toolbarStatus}
			<Badge
				variant={toolbarStatus.variant}
				class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro"
				data-testid={toolbarStatus.testId}
				role="status"
				aria-live="polite"
				aria-busy={toolbarStatus.loading}
				title={toolbarStatus.detail}
			>
				<Icon
					icon={toolbarStatus.icon}
					class={toolbarStatus.loading ? 'size-3 shrink-0 animate-spin' : 'size-3 shrink-0'}
					aria-hidden="true"
				/>
				<span class="truncate">{toolbarStatus.label}</span>
			</Badge>
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
