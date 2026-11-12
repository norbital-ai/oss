<!--
	The sidebar's notification bell: the unread count on the bell and the installed
	app's badge, and a popover of the member's notices, sorted so the reader need not (`notices.ts`). The live inbox
	refreshes the full unread count independently of the displayed page. Opening a line marks it read and follows its
	link. In the list, j/k or the arrows move and u marks the line read.
-->
<script lang="ts">
	import { attach, observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Queue, Schema } from 'effect';
	import { getContext } from 'svelte';
	import { watch } from 'runed';
	import { SOUNDS, noticeArrivals, type Sounds } from './sounds.ts';
	import { Button, Icon, Popover, cn } from '@norbital-ai/ui';
	import { Imposter, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { notice_path } from '../protocol/wire.ts';
	import { noticeAge, sortNotices, type NoticeGroup } from './notices.ts';
	import type { NoticeRow } from '../protocol/schema.ts';
	import { NoticesReadAnswer, type ShellApi } from './api-types.ts';
	import type { ShellBolt } from './runtime.ts';

	let {
		api,
		bolt,
		t,
		expanded = true,
		header = false,
		on_arrival,
		on_navigate
	}: {
		api: Pick<ShellApi, 'mark_notices_read' | 'mark_all_notices_read'>;
		bolt: Pick<ShellBolt, 'observe'>;
		t: (key: string) => string;
		expanded?: boolean;
		/** In a phone's top bar: the list drops below the bell, kept inside the screen. */
		header?: boolean;
		/** A notice arrived (the chime's moment). */
		on_arrival?: () => void;
		on_navigate: (href: string) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const notices = observe(() => bolt.observe({ read: { m: 'inbox', a: [] } }, NoticesReadAnswer));
	const sorted = $derived(sortNotices($notices?.rows ?? []));
	const unread = $derived($notices?.unread ?? 0);
	let open = $state(false),
		showWorkspace = $state(false),
		list = $state<HTMLElement | null>(null);
	let read_open = $state(false);
	let read_on_open = $state<ReadonlySet<string> | null>(null);
	// Reading a line changes its styling now; it moves into history only on the next open.
	const archived = (group: NoticeGroup) => group.unread.length === 0 &&
		group.rows.every((row) => read_on_open?.has(row.id) ?? row.read);
	const for_you = $derived(sorted.forYou.filter((group) => !archived(group)));
	const workspace = $derived(sorted.workspace.filter((group) => !archived(group)));
	const read_for_you = $derived(sorted.forYou.filter(archived));
	const read_workspace = $derived(sorted.workspace.filter(archived));
	const read_count = $derived([...read_for_you, ...read_workspace].reduce((n, group) => n + group.rows.length, 0));
	const workspaceShown = $derived(showWorkspace || for_you.length === 0);
	const now = $derived(open ? Date.now() : 0);
	const workspaceUnread = $derived(workspace.reduce((count, group) => count + group.unread.length, 0));
	function opened(next: boolean): void {
		open = next;
		if (!next) return;
		read_open = false;
		showWorkspace = false;
		read_on_open = $notices === undefined ? null : new Set($notices.rows.filter((row) => row.read).map((row) => row.id));
	}
	watch(() => [open, $notices] as const, ([shown, answer]) => {
		if (shown && read_on_open === null && answer !== undefined)
			read_on_open = new Set(answer.rows.filter((row) => row.read).map((row) => row.id));
	});
	const sounds = getContext<Sounds | undefined>(SOUNDS);
	const arrivals = noticeArrivals();
	watch(
		() => $notices,
		(answer) => {
			if (answer === undefined || !arrivals(answer.rows)) return;
			sounds?.play('notification');
			on_arrival?.();
		}
	);

	const mark_read = (ids: readonly string[]) => {
		if (ids.length > 0) fork(api.mark_notices_read(ids), () => {});
	};
	function openGroup(group: NoticeGroup, newest: NoticeRow): void {
		mark_read(group.unread);
		if (newest.link === null) return;
		open = false;
		on_navigate(notice_path(newest.link));
	}
	const lines = () => [...(list?.querySelectorAll<HTMLElement>('[data-notice], [data-notice-toggle]') ?? [])];
	function onListKey(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const all = lines();
		const at = all.findIndex((line) => line === document.activeElement);
		const move = (by: number) => {
			event.preventDefault();
			all[Math.max(0, Math.min(all.length - 1, at + by))]?.focus();
		};
		if (event.key === 'ArrowDown' || event.key === 'j') move(1);
		else if (event.key === 'ArrowUp' || event.key === 'k') move(-1);
		else if (event.key === 'u' && at >= 0) {
			const key = all[at]?.dataset['notice'];
			mark_read(
				(all[at]?.dataset['noticeScope'] === 'workspace' ? sorted.workspace : sorted.forYou).find((group) => group.key === key)?.unread ?? []
			);
		}
	}
	class AppBadgeFailed extends Schema.TaggedError<AppBadgeFailed>()('AppBadgeFailed', {
		operation: Schema.Literals(['set', 'clear']),
		cause: Schema.Defect()
	}) {}
	/** One component-owned queue keeps each set, clear and next set in order. */
	const appBadge = attach(() =>
		Effect.gen(function* () {
			if (
				typeof navigator.setAppBadge !== 'function' ||
				typeof navigator.clearAppBadge !== 'function'
			)
				return;
			const updates = yield* Queue.sliding<number>(1);
			let current = 0;
			const clear = Effect.tryPromise({
				try: () => navigator.clearAppBadge(),
				catch: (cause) => new AppBadgeFailed({ operation: 'clear', cause })
			}).pipe(
				Effect.uninterruptible,
				Effect.catch((error) => Effect.logWarning(error))
			);
			yield* Effect.addFinalizer(() => (current > 0 ? clear : Effect.void));
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					notices.subscribe((value) => {
						Queue.offerUnsafe(updates, value?.unread ?? 0);
					})
				),
				(unsubscribe) => Effect.sync(unsubscribe)
			);
			yield* Effect.forever(
				Queue.take(updates).pipe(
					Effect.flatMap((count) =>
						Effect.gen(function* () {
							if (count === current) return;
							const previous = current;
							current = 0;
							if (previous > 0) yield* clear;
							current = count;
							if (count > 0)
								yield* Effect.tryPromise({
									try: () => navigator.setAppBadge(count),
									catch: (cause) => new AppBadgeFailed({ operation: 'set', cause })
								}).pipe(
									Effect.uninterruptible,
									Effect.catch((error) => Effect.logWarning(error))
								);
						})
					)
				)
			);
		})
	);
</script>

{#snippet section(groups: readonly NoticeGroup[], scope: 'personal' | 'workspace')}
	<Stack as="ul" gap="none" divided>
		{#each groups as group (group.key)}
			{@const newest = group.rows[0]}
			{#if newest !== undefined}
				{@const fresh = group.unread.length > 0}
				{@const updates =
					group.rows.length > 1
						? t('{count} updates').replace('{count}', String(group.rows.length))
						: null}
				{@const detail = [updates, newest.body].filter(Boolean).join(' · ')}
				<li>
					<button
						type="button"
						data-notice={group.key}
						data-notice-scope={scope}
						data-read={!fresh}
						onclick={() => openGroup(group, newest)}
						class="min-h-11 w-full px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
					>
						<Inline as="span" gap="xs">
							<span
								class={cn('size-1.5 shrink-0 rounded-full', fresh && 'bg-primary')}
								aria-hidden="true"
							></span>
							<span
							title={newest.title}
								class={cn(
									'min-w-0 flex-1 truncate text-xs',
									fresh ? 'font-medium' : 'text-muted-foreground'
								)}>{newest.title}</span
							>
							<time class="shrink-0 text-tiny text-muted-foreground tabular-nums" datetime={newest.at}
								>{noticeAge(newest.at, now)}</time
							>
						</Inline>
						{#if detail !== ''}<span title={detail} class="block truncate pl-2.5 text-tiny text-muted-foreground"
								>{detail}</span
							>{/if}
					</button>
				</li>
			{/if}
		{/each}
	</Stack>
{/snippet}

<Popover.Root bind:open on_open_change={opened}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				title={t('Notifications')}
				data-testid="notification-bell"
				{@attach appBadge}
				aria-label={unread > 0
					? t('{count} unread notifications').replace('{count}', String(unread))
					: t('Notifications')}
				class={cn(
					'relative grid size-8 place-items-center rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent',
					header && 'size-11'
				)}
			>
				<Icon name="lucide:bell" class="size-3.5 shrink-0" />
				{#if unread > 0}
					<Imposter
						as="span"
						placement="top-end"
						data-testid="notification-unread-badge"
						class="-top-0.5 -right-0.5 z-auto min-w-3.5 rounded-full bg-primary px-1 text-center text-[8px] leading-3.5 font-medium text-primary-foreground"
					>
						{unread > 99 ? '99+' : unread}
					</Imposter>
				{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		side={header ? 'bottom' : expanded ? 'top' : 'right'}
		align={header || expanded ? 'end' : 'start'}
		side_offset={8}
		collision_padding={8}
		class="w-96 max-w-[calc(100vw-1rem)] p-0"
		on_open_auto_focus={(event) => {
			const first = lines()[0];
			if (first === undefined) return;
			event.preventDefault();
			first.focus();
		}}
	>
		<Inline justify="between" gap="sm" class="min-h-12 border-b px-3 py-2">
			<p class="text-xs font-medium">
				{t('Notifications')}{#if unread > 0}<span class="ml-1.5 font-normal text-muted-foreground"
						>{unread}</span
					>{/if}
			</p>
			{#if unread > 0}
				<Button
					type="button"
					variant="ghost"
					class="px-2 text-tiny"
					onclick={() => fork(api.mark_all_notices_read(), () => {})}>{t('Mark all read')}</Button
				>
			{/if}
		</Inline>
		{#if notices.error !== undefined}<p
				class="border-b px-3 py-2 text-tiny text-destructive"
				role="alert"
			>
				{notices.error.message}
			</p>{/if}
		<Scroll name={t('Notifications')} class="max-h-[min(24rem,calc(100dvh-8rem))]" fade={false}>
			{#if $notices === undefined && notices.error === undefined}
				<p role="status" class="grid min-h-40 place-items-center px-3 py-8 text-center text-tiny text-muted-foreground">{t('Loading…')}</p>
			{:else if $notices !== undefined}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div bind:this={list} role="group" aria-keyshortcuts="j k u" onkeydown={onListKey}>
					{#if for_you.length + workspace.length === 0}
						<Stack align="center" justify="center" gap="xs" class="min-h-40 px-4 py-8 text-center" data-notice-empty>
							<Icon name="lucide:inbox" class="mb-1 size-6 text-muted-foreground" />
							<p class="text-sm font-medium">{unread > 0 ? t('No recent unread notifications') : read_count > 0 ? t('You’re all caught up') : t('No notifications yet')}</p>
							<p class="max-w-64 text-xs text-muted-foreground">{unread > 0 ? t('Older notifications are still included in your unread count.') : t('New notifications will appear here.')}</p>
						</Stack>
					{:else}
						{#if for_you.length > 0}{@render section(for_you, 'personal')}{/if}
						{#if workspace.length > 0}
							{#if for_you.length > 0}
								<button type="button" data-notice-toggle aria-expanded={workspaceShown} onclick={() => showWorkspace = !showWorkspace}
									class="min-h-11 w-full border-t px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
									<Inline as="span" gap="xs">
										<Icon name={workspaceShown ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="size-3.5 shrink-0 text-muted-foreground" />
										<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t('Workspace updates')}</span>
										{#if workspaceUnread > 0}<span class="text-tiny text-muted-foreground tabular-nums">{workspaceUnread}</span>{/if}
									</Inline>
								</button>
							{/if}
							{#if workspaceShown}{@render section(workspace, 'workspace')}{/if}
						{/if}
					{/if}
					{#if read_count > 0}
						<details class="group/read border-t" open={read_open} ontoggle={(event) => read_open = event.currentTarget.open}>
							<summary data-notice-toggle class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent [&::-webkit-details-marker]:hidden">
								<Icon name="lucide:chevron-right" class="size-3.5 shrink-0 transition-transform group-open/read:rotate-90 motion-reduce:transition-none" />
								<span class="flex-1 font-medium">{t('Read')}</span><span class="tabular-nums">{read_count}</span>
							</summary>
							{#if read_open}
								{#if read_for_you.length > 0}{@render section(read_for_you, 'personal')}{/if}
								{#if read_workspace.length > 0}
									{#if read_for_you.length > 0}<p class="border-t px-3 py-2 text-tiny text-muted-foreground">{t('Workspace updates')}</p>{/if}
									{@render section(read_workspace, 'workspace')}
								{/if}
							{/if}
						</details>
					{/if}
				</div>
			{/if}
		</Scroll>
	</Popover.Content>
</Popover.Root>
