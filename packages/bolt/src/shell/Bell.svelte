<!--
	The sidebar's notification bell (staging's `notifications.svelte`): the unread count on the bell and the installed
	app's badge, and a popover of the member's notices — the same live `inbox` read the Inbox page holds, so a new notice
	or a read arrives as a patch. Opening one marks it read and follows its link.
-->
<script lang="ts">
	import { Button, Icon, Popover, cn } from '@norbital-ai/ui';
	import { Imposter, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { Notice } from './data.ts';
	import type { ShellApi, ShellBolt } from './runtime.ts';

	let { api, bolt, t, expanded = true, header = false, onNavigate }: {
		api: ShellApi; bolt: ShellBolt; t: (key: string) => string; expanded?: boolean;
		/** In a phone's top bar: the list drops below the bell, kept inside the screen. */
		header?: boolean; onNavigate: (href: string) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const notices = bolt.live<{ rows: Notice[] }>({ read: { m: 'inbox', a: [] },
		then: (ok, bad) => Promise.reject<{ rows: Notice[] }>(new Error('the inbox is read live')).then(ok, bad) });
	const rows = $derived($notices?.rows ?? []);
	const unread = $derived(rows.filter((n) => !n.read));
	let open = $state(false);

	const markRead = (ids: readonly string[]) => { if (ids.length > 0) void api.markNoticesRead(ids); };
	const linkOf = (link: unknown) => typeof link === 'object' && link !== null && 'collection' in link && 'id' in link
		? `/inbox?record=${encodeURIComponent(String(link.collection))}/${encodeURIComponent(String(link.id))}` : null;
	function openNotice(n: Notice): void {
		if (!n.read) markRead([n.id]);
		const href = linkOf(n.link);
		if (href === null) return;
		open = false;
		onNavigate(href);
	}
	/** The installed app's icon carries the bell's count; the badge leaving the tree clears it. */
	const appBadge = (count: number) => () => {
		if (!('setAppBadge' in navigator)) return;
		void navigator.setAppBadge(count).catch(() => undefined);
		return () => void navigator.clearAppBadge().catch(() => undefined);
	};
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button {...props} type="button" title={t('Notifications')} data-testid="notification-bell"
				aria-label={unread.length > 0 ? t('{count} unread notifications').replace('{count}', String(unread.length)) : t('Notifications')}
				class={cn('relative grid place-items-center rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent', expanded ? 'size-7' : 'size-8')}>
				<Icon name="lucide:bell" class="size-3.5 shrink-0" />
				{#if unread.length > 0}
					<Imposter as="span" placement="top-end" data-testid="notification-unread-badge" {@attach appBadge(unread.length)}
						class="-top-0.5 -right-0.5 z-auto min-w-3.5 rounded-full bg-primary px-1 text-center text-[8px] leading-3.5 font-medium text-primary-foreground">
						{unread.length > 99 ? '99+' : unread.length}
					</Imposter>
				{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content side={header ? 'bottom' : expanded ? 'top' : 'right'} align={header || expanded ? 'end' : 'start'} sideOffset={8} collisionPadding={8}
		class="w-80 max-w-[calc(100vw-1rem)] p-0">
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
			<p class="text-xs font-medium">{t('Notifications')}</p>
			{#if unread.length > 0}
				<Button type="button" variant="ghost" class="h-6 px-2 text-tiny" onclick={() => markRead(unread.map((n) => n.id))}>{t('Mark all read')}</Button>
			{/if}
		</Inline>
		{#if notices.error !== undefined}<p class="border-b px-3 py-2 text-tiny text-destructive" role="alert">{notices.error.message}</p>{/if}
		<Scroll name={t('Notifications')} class="max-h-96">
			{#if $notices === undefined && notices.error === undefined}
				<p role="status" class="px-3 py-8 text-center text-tiny text-muted-foreground">{t('Loading…')}</p>
			{:else if rows.length === 0}
				<Stack align="center" gap="xs" class="px-3 py-8 text-center">
					<Icon name="lucide:bell-off" class="size-6 text-muted-foreground" />
					<span class="text-tiny text-muted-foreground">{t('Nothing here yet')}</span>
				</Stack>
			{:else}
				<Stack as="ul" gap="none" divided>
					{#each rows as n (n.id)}
						<li>
							<button type="button" onclick={() => openNotice(n)} data-read={n.read}
								class={cn('w-full px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent', !n.read && 'bg-accent/40')}>
								<Inline as="span" gap="xs">
									{#if !n.read}<span class="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>{/if}
									<span class="min-w-0 flex-1 truncate text-xs font-medium">{n.title}</span>
								</Inline>
								{#if n.body}<span class="block truncate text-tiny text-muted-foreground">{n.body}</span>{/if}
							</button>
						</li>
					{/each}
				</Stack>
			{/if}
		</Scroll>
	</Popover.Content>
</Popover.Root>
