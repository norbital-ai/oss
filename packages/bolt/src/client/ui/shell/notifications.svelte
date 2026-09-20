<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import * as Popover from '@norbital-ai/ui/popover';
	import * as Sidebar from '@norbital-ai/ui/sidebar';
	import type { PushSubscriptionState } from './push-subscription.svelte.js';

	interface NotificationItem {
		readonly id: string;
		readonly text: string;
		readonly read: boolean;
	}

	let {
		items = [],
		loading = false,
		error,
		expanded = true,
		onread,
		push
	}: {
		items?: ReadonlyArray<NotificationItem>;
		loading?: boolean;
		error?: string | undefined;
		expanded?: boolean;
		onread?: (id: string) => void;
		/** This browser's push subscription; absent when the host sends none. */
		push?: PushSubscriptionState | undefined;
	} = $props();
	const pushOffered = $derived(
		push !== undefined &&
			(push.status === 'off' || push.status === 'on' || push.status === 'denied')
	);

	const unread = $derived(items.filter(({ read }) => !read));
	const badge = $derived(unread.length > 99 ? '99+' : String(unread.length));
	let open = $state(false);
	/**
	 * The installed app's icon carries the same count as the bell. An attachment on the badge
	 * itself: it re-runs as the count changes and its cleanup — the badge leaving the tree at
	 * zero — is what clears the icon. A browser without the API simply has no badge.
	 */
	const appBadge = (count: number) => () => {
		if (!('setAppBadge' in navigator)) return;
		void navigator.setAppBadge(count).catch(() => undefined);
		return () => void navigator.clearAppBadge().catch(() => undefined);
	};
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Sidebar.MenuButton
				{...props}
				aria-label={unread.length > 0 ? `${unread.length} unread notifications` : 'Notifications'}
				tooltipContent="Notifications"
				class="relative justify-center rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent {expanded
					? 'size-7'
					: 'size-8'}"
			>
				<IconWrapper name="lucide:bell" class="size-3.5 shrink-0" />
				{#if unread.length > 0}
					<Inline
						style="position: absolute; top: -0.125rem; right: -0.125rem /* repository-health:allow UI23 -- The unread count overlays the bell; no layout primitive owns anchored badge placement. */"
						class="min-w-3.5 rounded-full bg-primary px-1 text-[0.5625rem] leading-3.5 font-medium text-primary-foreground"
						as="span"
						justify="center"
						gap="none"
						data-testid="notification-unread-badge"
						{@attach appBadge(unread.length)}
					>
						{badge}
					</Inline>
				{/if}
			</Sidebar.MenuButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		side={expanded ? 'top' : 'right'}
		align={expanded ? 'end' : 'start'}
		sideOffset={8}
		class="w-80 p-0"
	>
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
			<p class="text-xs font-medium">Notifications</p>
			{#if unread.length > 0 && onread}
				<Button
					type="button"
					variant="ghost"
					class="h-6 px-2 text-tiny"
					onclick={() => unread.forEach((item) => onread(item.id))}
				>
					Mark all read
				</Button>
			{/if}
		</Inline>
		{#if error !== undefined}
			<p class="border-b px-3 py-2 text-tiny text-destructive" role="alert">
				{error}
			</p>
		{/if}
		{#if push !== undefined && pushOffered}
			<Inline justify="between" gap="sm" class="border-b px-3 py-2">
				<span class="text-tiny text-muted-foreground">
					{push.status === 'denied'
						? 'Notifications are blocked in your browser settings'
						: push.status === 'on'
							? 'Push notifications on'
							: 'Get notified on this device'}
				</span>
				{#if push.status !== 'denied'}
					<Button
						type="button"
						variant="ghost"
						class="h-6 px-2 text-tiny"
						onclick={() => void (push.status === 'on' ? push.disable() : push.enable())}
					>
						{push.status === 'on' ? 'Turn off' : 'Enable'}
					</Button>
				{/if}
			</Inline>
			{#if push.error !== undefined}
				<p class="border-b px-3 py-2 text-tiny text-destructive" role="alert">{push.error}</p>
			{/if}
		{/if}
		<Scroll name="Notifications" class="max-h-96">
			{#if loading && items.length === 0}
				<p role="status" class="px-3 py-8 text-center text-tiny text-muted-foreground">Loading…</p>
			{:else if items.length === 0}
				<Stack align="center" gap="xs" class="px-3 py-8 text-center">
					<IconWrapper name="lucide:bell-off" class="size-6 text-muted-foreground" />
					<span class="text-tiny text-muted-foreground">Nothing here yet</span>
				</Stack>
			{:else}
				<ul class="divide-y">
					{#each items as item (item.id)}
						<li>
							<button
								type="button"
								class="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent {item.read
									? ''
									: 'bg-accent/40'}"
								onclick={() => onread?.(item.id)}
							>
								<Inline as="span" gap="xs">
									{#if !item.read}
										<span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"
										></span>
									{/if}
									<span class="min-w-0 flex-1 truncate text-xs font-medium">{item.text}</span>
								</Inline>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</Scroll>
	</Popover.Content>
</Popover.Root>
