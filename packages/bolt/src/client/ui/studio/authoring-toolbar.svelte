<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import * as Popover from '@norbital-ai/ui/popover';
	import { Tabs, WORKSPACE_TAB_TRIGGER_TEXT_CLASS, type TabConfig } from '@norbital-ai/ui/tabs';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		RELEASE_REQUEST_UNAVAILABLE,
		type AuthoringView,
		type StudioEnvironment
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * Authoring's chrome row: which environment is being read, what the host is, and what may be
	 * written back to it.
	 *
	 * One row of fixed height. The left half scrolls on x so a long environment name never pushes
	 * Commit off the page, and the right half is pinned because an action that moves is an action
	 * somebody misses.
	 */
	let {
		environments = [],
		activeEnvironment,
		hostStatus,
		view = 'manifest',
		commitDisabled = true,
		commitReason,
		onenvironment,
		onview,
		oncommit
	}: {
		environments?: ReadonlyArray<StudioEnvironment>;
		activeEnvironment?: StudioEnvironment | undefined;
		hostStatus: string;
		view?: AuthoringView;
		commitDisabled?: boolean;
		commitReason: string;
		onenvironment?: ((id: string) => void) | undefined;
		onview?: ((next: AuthoringView) => void) | undefined;
		oncommit?: (() => void) | undefined;
	} = $props();

	let pickerOpen = $state(false);

	const readOnly = $derived(activeEnvironment?.readOnly === true);
</script>

<!--
	Chrome chips carry the tab rail's own text class rather than a size of their own. A chip beside a
	trigger that reads a step larger or smaller is what makes a toolbar look assembled from two
	different products.
-->
{#snippet chip(tone: 'ready' | 'warn' | 'idle', label: string, testId: string, icon?: string)}
	<Inline
		as="span"
		gap="xs"
		justify="center"
		shrink={false}
		class={cn(
			'truncate rounded-sm border border-transparent px-1.5 py-0.5',
			WORKSPACE_TAB_TRIGGER_TEXT_CLASS,
			tone === 'ready' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
			tone === 'warn' && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
			tone === 'idle' && 'bg-muted text-muted-foreground'
		)}
		data-testid={testId}
		role="status"
	>
		{#if icon}
			<Icon {icon} class="size-3 shrink-0" />
		{/if}
		<span class="truncate">{label}</span>
	</Inline>
{/snippet}

<Inline shrink={false} class="h-10 border-b border-border/60 sm:h-9">
	<Scroll name="Authoring toolbar" axis="x" layout="inline" gap="xs" grow class="min-w-0">
		<Popover.Root bind:open={pickerOpen}>
			<Popover.Trigger>
				{#snippet child({ props }: { props: Record<string, unknown> })}
					<button
						{...props}
						type="button"
						class={cn(
							'inline-flex h-7 w-40 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-popover px-2 text-xs font-medium transition-colors hover:bg-accent/70',
							readOnly && 'text-muted-foreground'
						)}
						aria-label="Environment"
						data-testid="environment-picker-trigger"
					>
						<Icon
							icon={readOnly ? 'lucide:circle-dot' : 'lucide:container'}
							class={cn('size-3 shrink-0', readOnly ? 'text-emerald-500' : 'text-brand')}
						/>
						<span class="min-w-0 flex-1 truncate text-left">
							{activeEnvironment?.label ?? 'Live'}
						</span>
						<Icon icon="lucide:chevrons-up-down" class="size-3 shrink-0 text-muted-foreground" />
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content side="bottom" align="start" class="w-72 p-1">
				<p class="px-2 py-1.5 text-tiny leading-relaxed text-muted-foreground">
					One environment is routed per tenant on this host, so this list is the routes the gateway
					already resolved rather than workbenches you may open.
				</p>
				{#each environments as candidate (candidate.id)}
					<button
						type="button"
						data-testid="environment-picker-option"
						data-environment={candidate.id}
						class={cn(
							'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-accent/70',
							candidate.id === activeEnvironment?.id && 'bg-primary/5'
						)}
						onclick={() => {
							onenvironment?.(candidate.id);
							pickerOpen = false;
						}}
					>
						<Icon
							icon={candidate.readOnly ? 'lucide:circle-dot' : 'lucide:container'}
							class={cn(
								'size-3.5 shrink-0',
								candidate.readOnly ? 'text-emerald-500' : 'text-brand'
							)}
						/>
						<span class="min-w-0 flex-1">
							<span class="block font-medium text-foreground">{candidate.label}</span>
							<span class="block truncate font-mono text-tiny text-muted-foreground">
								{candidate.releaseId === '' ? '—' : candidate.releaseId} · {candidate.health}{candidate.readOnly
									? ' · read-only'
									: ''}
							</span>
						</span>
					</button>
				{/each}
			</Popover.Content>
		</Popover.Root>

		{@render chip(hostStatus === 'Ready' ? 'ready' : 'warn', hostStatus, 'studio-host-status')}

		<!-- Shared `Tabs`, not a second bordered pill; the studio uses the product's tab treatment. -->
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
	</Scroll>

	<Inline gap="xs" shrink={false}>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
			disabled
			disabledMessage={RELEASE_REQUEST_UNAVAILABLE}
			data-testid="studio-request-release"
		>
			<Icon icon="lucide:git-pull-request" class="size-3.5" />
			Request release
		</Button>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="h-8 gap-1 px-2 text-xs font-semibold sm:h-7 sm:text-micro"
			disabled={commitDisabled}
			disabledMessage={commitReason}
			data-testid="studio-commit"
			onclick={() => oncommit?.()}
		>
			<Icon icon="lucide:git-commit-horizontal" class="size-3.5" />
			Commit
		</Button>
	</Inline>
</Inline>
