<!--
	The sidebar's notification bell: the unread count on the bell and the installed
	app's badge, and a popover of the member's notices, sorted so the reader need not (`notices.ts`). The live inbox
	refreshes the full unread count independently of the displayed page. Opening a line marks it read and follows its
	link. In the list, j/k or the arrows move and u marks the line read.
-->
<script lang="ts">
	import { attach, observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Queue, Schema, type Stream } from 'effect';
	import { getContext } from 'svelte';
	import { watch } from 'runed';
	import { SOUNDS, noticeArrivals, type Sounds } from './sounds.ts';
	import { Button, Icon, Popover, cn } from '@norbital-ai/ui';
	import { Imposter, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { noticePath } from '../protocol/wire.ts';
	import { noticeAge, sortNotices, type NoticeGroup } from './notices.ts';
	import type { NoticeRow } from '../protocol/schema.ts';
	import type { ShellApi } from './api-types.ts';

	type InboxAnswer = { rows: NoticeRow[]; unread: number };
	let {
		api,
		bolt,
		t,
		expanded = true,
		header = false,
		onArrival,
		onNavigate
	}: {
		api: Pick<ShellApi, 'markNoticesRead' | 'markAllNoticesRead'>;
		bolt: {
			readonly observe: (query: {
				readonly read: { readonly m: 'inbox'; readonly a: readonly [] };
			}) => Stream.Stream<InboxAnswer, { readonly message: string }>;
		};
		t: (key: string) => string;
		expanded?: boolean;
		/** In a phone's top bar: the list drops below the bell, kept inside the screen. */
		header?: boolean;
		/** A notice arrived (the chime's moment). */
		onArrival?: () => void;
		onNavigate: (href: string) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const notices = observe(() => bolt.observe({ read: { m: 'inbox', a: [] } }));
	const sorted = $derived(sortNotices($notices?.rows ?? []));
	const unread = $derived($notices?.unread ?? 0);
	let open = $state(false),
		showWorkspace = $state(false),
		list = $state<HTMLElement | null>(null);
	// everything else is said first; with nothing else to say, the workspace's own news is the list
	const workspaceShown = $derived(showWorkspace || sorted.forYou.length === 0);
	const now = $derived(open ? Date.now() : 0);
	const workspaceUnread = $derived(
		sorted.workspace.reduce((count, group) => count + group.unread.length, 0)
	);
	const sounds = getContext<Sounds | undefined>(SOUNDS);
	const arrivals = noticeArrivals();
	watch(
		() => $notices,
		(answer) => {
			if (answer === undefined || !arrivals(answer.rows)) return;
			sounds?.play('notification');
			onArrival?.();
		}
	);

	const markRead = (ids: readonly string[]) => {
		if (ids.length > 0) fork(api.markNoticesRead(ids), () => {});
	};
	function openGroup(group: NoticeGroup, newest: NoticeRow): void {
		markRead(group.unread);
		if (newest.link === null) return;
		open = false;
		onNavigate(noticePath(newest.link));
	}
	const lines = () => [...(list?.querySelectorAll<HTMLElement>('[data-notice]') ?? [])];
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
			markRead(
				[...sorted.forYou, ...sorted.workspace].find((group) => group.key === key)?.unread ?? []
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

{#snippet section(groups: readonly NoticeGroup[])}
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
						data-read={!fresh}
						onclick={() => openGroup(group, newest)}
						class="w-full px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
					>
						<Inline as="span" gap="xs">
							<span
								class={cn('size-1.5 shrink-0 rounded-full', fresh && 'bg-primary')}
								aria-hidden="true"
							></span>
							<span
								class={cn(
									'min-w-0 flex-1 truncate text-xs',
									fresh ? 'font-medium' : 'text-muted-foreground'
								)}>{newest.title}</span
							>
							<time class="shrink-0 text-tiny text-muted-foreground tabular-nums" datetime={newest.at}
								>{noticeAge(newest.at, now)}</time
							>
						</Inline>
						{#if detail !== ''}<span class="block truncate pl-2.5 text-tiny text-muted-foreground"
								>{detail}</span
							>{/if}
					</button>
				</li>
			{/if}
		{/each}
	</Stack>
{/snippet}

<Popover.Root bind:open>
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
		sideOffset={8}
		collisionPadding={8}
		class="w-96 max-w-[calc(100vw-1rem)] p-0"
		onOpenAutoFocus={(event) => {
			const first = lines()[0];
			if (first === undefined) return;
			event.preventDefault();
			first.focus();
		}}
	>
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
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
					onclick={() => fork(api.markAllNoticesRead(), () => {})}>{t('Mark all read')}</Button
				>
			{/if}
		</Inline>
		{#if notices.error !== undefined}<p
				class="border-b px-3 py-2 text-tiny text-destructive"
				role="alert"
			>
				{notices.error.message}
			</p>{/if}
		<Scroll name={t('Notifications')} class="max-h-96">
			{#if $notices === undefined && notices.error === undefined}
				<p role="status" class="px-3 py-8 text-center text-tiny text-muted-foreground">
					{t('Loading…')}
				</p>
			{:else if sorted.forYou.length + sorted.workspace.length === 0}
				<Stack align="center" gap="xs" class="px-3 py-8 text-center">
					<Icon name="lucide:bell-off" class="size-6 text-muted-foreground" />
					<span class="text-tiny text-muted-foreground">{t('Nothing here yet')}</span>
				</Stack>
			{:else}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div bind:this={list} role="group" aria-keyshortcuts="j k u" onkeydown={onListKey}>
					{#if sorted.forYou.length > 0}
						{@render section(sorted.forYou)}
					{/if}
					{#if sorted.workspace.length > 0}
						{#if sorted.forYou.length > 0}
							<button
								type="button"
								aria-expanded={workspaceShown}
								onclick={() => (showWorkspace = !showWorkspace)}
								class="w-full border-t px-3 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
							>
								<Inline as="span" gap="xs">
									<Icon
										name={workspaceShown ? 'lucide:chevron-down' : 'lucide:chevron-right'}
										class="size-3 shrink-0 text-muted-foreground"
									/>
									<span class="min-w-0 flex-1 truncate text-tiny text-muted-foreground"
										>{t('Workspace updates')}</span
									>
									{#if workspaceUnread > 0}<span class="text-tiny text-muted-foreground tabular-nums"
											>{workspaceUnread}</span
										>{/if}
								</Inline>
							</button>
						{/if}
						{#if workspaceShown}
							{@render section(sorted.workspace)}
						{/if}
					{/if}
				</div>
			{/if}
		</Scroll>
	</Popover.Content>
</Popover.Root>
