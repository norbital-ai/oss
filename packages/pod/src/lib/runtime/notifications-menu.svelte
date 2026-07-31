<script lang="ts">
	import Icon from '@iconify/svelte';
	import type {
		CollectionClient,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { Button } from '@norbital-ai/ui/button';
	import * as Popover from '@norbital-ai/ui/popover';
	import * as Sidebar from '@norbital-ai/ui/sidebar';
	import { cn } from '@norbital-ai/ui/utils';
	import { toNotificationRow, unreadBadge, type NotificationRow } from './notifications.js';

	/**
	 * The workspace's notification bell.
	 *
	 * It stays current with no cadence of its own. `workspaceApi.db.notification.findMany` is the same
	 * live query every collection surface uses: the read resolves from the local replica, and the sync
	 * engine re-fires exactly the cached reads for a collection when a diff for it lands
	 * (`setSyncInvalidator` in runtime/client.ts). `notification` replicates like any other collection
	 * — the server's own guard scopes the rows to `recipient_user_id` — so a notification raised by a
	 * hook, an automation or an inbound channel arrives here over the connection the shell already
	 * holds open. There is no poll and no second stream, and there must not be one.
	 */
	let {
		workspaceApi,
		userId,
		expanded,
		onNavigate
	}: {
		workspaceApi: CollectionClient<ErasedCollectionRegistry>;
		userId: string;
		expanded: boolean;
		onNavigate?: (href: string) => void;
	} = $props();

	/**
	 * The most recent page, newest first.
	 *
	 * Scoped to this user in the query as well as by the server's guard. Both matter: the guard is
	 * what makes it safe, and the `where` is what makes it *this person's bell* — an admin's session
	 * short-circuits the policy deny and would otherwise open a workspace-wide firehose.
	 */
	const PAGE = 50;
	const query = $derived(
		workspaceApi.db.notification?.findMany({
			where: { recipient_user_id: userId },
			orderBy: { norbital_created_at: 'desc' },
			limit: PAGE
		})
	);
	const rows = $derived((query?.current ?? []).flatMap(toNotificationRow));
	const unread = $derived(rows.filter((row) => row.read_at === null));
	const badge = $derived(unreadBadge(unread.length));

	let open = $state(false);
	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function markRead(ids: readonly string[]): Promise<void> {
		const update = workspaceApi.db.notification?.update;
		if (!update || ids.length === 0 || busy) return;
		busy = true;
		failure = null;
		const readAt = new Date().toISOString();
		try {
			// One mutation per row through the ordinary write path, so each is applied optimistically
			// and confirmed by the server. `updateMany` is deliberately not used: it does not route
			// through the sync mutate endpoint, so it would neither apply locally nor be authorized by
			// the self-service rule that lets a recipient dismiss their own notification.
			for (const id of ids) await update(id, { read_at: readAt });
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		} finally {
			busy = false;
		}
	}

	function openNotification(row: NotificationRow): void {
		void markRead([row.norbital_id]);
		if (!row.cta_url) return;
		open = false;
		onNavigate?.(row.cta_url);
	}

	function whenReceived(row: NotificationRow): string {
		const at = new Date(row.norbital_created_at);
		if (Number.isNaN(at.getTime())) return '';
		return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Sidebar.MenuButton
				{...props}
				aria-label={unread.length > 0
					? `Notifications, ${unread.length} unread`
					: 'Notifications'}
				class={cn(
					'relative rounded-md text-xs hover:bg-accent data-[state=open]:bg-accent',
					expanded ? 'h-8 px-2' : 'size-8 justify-center p-0'
				)}
			>
				<Icon icon="lucide:bell" class="size-4 shrink-0" />
				{#if expanded}<span class="min-w-0 flex-1 truncate text-left">Notifications</span>{/if}
				{#if unread.length > 0}
					<span
						data-testid="notification-unread-badge"
						class={cn(
							'grid min-w-4 place-items-center rounded-full bg-primary px-1 text-micro leading-4 font-medium text-primary-foreground',
							expanded ? 'ml-auto' : 'absolute -top-0.5 -right-0.5'
						)}
					>
						{badge}
					</span>
				{/if}
			</Sidebar.MenuButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		side={expanded ? 'top' : 'right'}
		align="start"
		sideOffset={8}
		class="w-80 p-0"
	>
		<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
			<p class="text-xs font-medium">Notifications</p>
			{#if unread.length > 0}
				<Button
					type="button"
					variant="ghost"
					class="h-6 px-2 text-tiny"
					disabled={busy}
					onclick={() => void markRead(unread.map((row) => row.norbital_id))}
				>
					Mark all read
				</Button>
			{/if}
		</div>

		{#if failure}
			<p class="border-b px-3 py-2 text-tiny text-destructive" role="alert">{failure}</p>
		{/if}

		<div class="max-h-96 overflow-y-auto overscroll-contain">
			{#if rows.length === 0}
				<div class="flex flex-col items-center gap-1 px-3 py-8 text-center">
					<Icon icon="lucide:bell-off" class="size-6 text-muted-foreground" />
					<span class="text-tiny text-muted-foreground">
						{query?.loading ? 'Loading…' : 'Nothing here yet'}
					</span>
				</div>
			{:else}
				<ul class="divide-y">
					{#each rows as row (row.norbital_id)}
						<li>
							<button
								type="button"
								class={cn(
									'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent',
									row.read_at === null ? 'bg-accent/40' : ''
								)}
								onclick={() => openNotification(row)}
							>
								<span class="flex w-full min-w-0 items-center gap-1.5">
									{#if row.read_at === null}
										<span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"
										></span>
									{/if}
									<span class="min-w-0 flex-1 truncate text-xs font-medium">{row.subject}</span>
								</span>
								<span class="line-clamp-2 text-tiny text-muted-foreground">{row.message}</span>
								<span class="flex w-full items-center gap-2 text-micro text-muted-foreground">
									<span>{whenReceived(row)}</span>
									{#if row.cta_url}
										<span class="ml-auto inline-flex items-center gap-0.5 text-primary">
											{row.cta_label ?? 'Open'}
											<Icon icon="lucide:arrow-right" class="size-3" />
										</span>
									{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
