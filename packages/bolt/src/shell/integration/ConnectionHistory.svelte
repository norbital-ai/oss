<!--
	Built-in message & delivery history for any conversation connection (`sys_message`), shared by
	personal `/connections` and administrator Settings → Integrations → Connections.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { watch } from '@norbital-ai/ui/behaviors';
	import { Button, format, format_handle, Spinner, StateBadge, type UiContext } from '@norbital-ai/ui';
	import type { InstanceMessage } from '../../protocol/schema.ts';

	let {
		ctx,
		driver,
		instance,
		load,
		locale,
		t
	}: {
		ctx: UiContext;
		driver: string;
		instance: string;
		load: (before?: string) => Effect.Effect<readonly InstanceMessage[], { readonly message: string }>;
		locale: string;
		t: (key: string) => string;
	} = $props();

	const when = (value: string) =>
		value !== '' ? format({ kind: 'instant' }, value, { locale }) : '—';

	const scope = $derived({ instance, load });
	let request = $state.raw<{ scope: typeof scope; before?: string } | undefined>();
	let window = $state.raw<
		{ scope: typeof scope; rows: InstanceMessage[]; more: boolean } | undefined
	>();
	const log = $derived(window?.scope === scope ? window : undefined);

	const messages = observe_once(() => {
		const current = scope;
		const before = request?.scope === current ? request.before : undefined;
		return current.instance === ''
			? null
			: current.load(before).pipe(Effect.map((rows) => ({ scope: current, before, rows })));
	});

	watch(
		() => messages.current,
		(answer) => {
			if (answer === undefined) return;
			window = {
				scope: answer.scope,
				rows:
					answer.before === undefined ? [...answer.rows] : [...(log?.rows ?? []), ...answer.rows],
				more: answer.rows.length === 100
			};
		}
	);

	const readLog = (older = false) =>
		Effect.sync(() => {
			if (messages.loading) return;
			const before = older ? log?.rows.at(-1)?.seq : undefined;
			if (older && before === undefined) return;
			request = { scope, ...(before === undefined ? {} : { before }) };
		});
</script>

<div class="flex flex-col gap-2 text-sm" data-instance-messages>
	<div class="flex items-center justify-between">
		<p class="text-xs text-muted-foreground">
			{t('Messages and delivery history on this connection, newest first.')}
		</p>
		<Button variant="ghost" disabled={messages.loading} onclick={() => fork(readLog())}>
			{t('Refresh')}
		</Button>
	</div>
	{#if messages.error !== undefined}
		<p role="alert" class="text-xs text-destructive">
			{messages.error.message}
		</p>
	{/if}
	{#if log === undefined}
		{#if messages.loading}
			<p
				role="status"
				aria-busy="true"
				class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
			>
				<Spinner class="size-3" />{t('Loading…')}
			</p>
		{/if}
	{:else if log.rows.length === 0}
		<p class="text-xs text-muted-foreground">{t('No messages on this instance yet.')}</p>
	{:else}
		<ol class="flex flex-col gap-1.5">
			{#each log.rows as x (x.id)}
				<li
					class="rounded-md border border-border/70 px-2.5 py-1.5"
					data-direction={x.direction}
					data-instance-message={x.id}
				>
					<p class="flex items-center gap-2 text-xs text-muted-foreground">
						<span class="font-medium text-foreground">
							{x.direction === 'inbound' ? '←' : '→'}
							{x.direction === 'inbound'
								? format_handle(driver, x.sender ?? '', x.sender_name)
								: t('sent')}
						</span>
						<span class="min-w-0 truncate">
							{x.kind === 'group' ? (x.title ?? x.thread) : format_handle(driver, x.thread ?? '')}
						</span>
						<span class="flex-1"></span>
						{#if x.direction === 'outbound' && x.status !== null}
							<StateBadge {ctx} state={x.status} label={t(x.status)} />
						{/if}
						<time class="tabular-nums">{when(x.at)}</time>
					</p>
					<p class="whitespace-pre-wrap">
						{x.text ?? ''}{#if x.files > 0}
							<span class="text-xs text-muted-foreground">
								· {x.files} {t(x.files === 1 ? 'file' : 'files')}
							</span>
						{/if}
					</p>
					{#if x.error}
						<p
							class="text-xs {x.status === 'skipped'
								? 'text-muted-foreground'
								: 'text-destructive'}"
						>
							{x.error}
						</p>
					{/if}
					{#if x.delivery.length > 0}
						<details class="text-xs" data-delivery-timeline>
							<summary class="cursor-pointer text-muted-foreground">{t('Delivery')}</summary>
							<ol class="mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-2">
								{#each x.delivery as e, n (n)}
									<li data-delivery-kind={e.kind}>
										<span class="font-medium">
											{t(e.kind === 'auto_replied' ? 'auto-replied' : e.kind)}
										</span>{#if e.presumed}
											<span class="text-muted-foreground">({t('presumed')})</span>
										{/if}{#if e.approximate}
											<span class="text-muted-foreground">({t('approximate')})</span>
										{/if}
										<time class="tabular-nums text-muted-foreground">{when(e.at)}</time>
										{#if e.provider !== 'bolt'}
											<span class="text-muted-foreground">· {e.provider}</span>
										{/if}
										{#if e.code}<code class="text-muted-foreground">{e.code}</code>{/if}
										{#if e.reason}<span class="text-muted-foreground">— {e.reason}</span>{/if}
									</li>
								{/each}
							</ol>
						</details>
					{/if}
				</li>
			{/each}
		</ol>
		{#if log.more}
			<Button variant="ghost" disabled={messages.loading} onclick={() => fork(readLog(true))}>
				{t('Older')}
			</Button>
		{/if}
	{/if}
</div>
