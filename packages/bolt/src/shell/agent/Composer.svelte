<script lang="ts">
	import { Effect } from 'effect';
	import { MediaQuery } from 'svelte/reactivity';
	import { Button, Combobox, Icon, Input, MarkdownEditor, Popover, type CommandItem, type ModelExposure } from '@norbital-ai/ui';
	import { Inline } from '@norbital-ai/ui/layout';
	import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
	import type { AiModel } from '@norbital-ai/host-api';
	import type { ManifestItem } from '../finder/manifest.ts';
	import type { NavNode } from '../nav.ts';
	import type { AgentDraft } from './drafts.ts';
	import type { OutboxRow } from './outbox.svelte.ts';
	import { recordMentions, type FinderRead } from '../finder/model.ts';
	import { commandKey } from '../keyboard.ts';
	import { context_meter, token_count as k } from './usage.ts';
	import Attachments from './Attachments.svelte';
	let { t, unconfigured, status, rows, queued, draft = $bindable(''), mode = $bindable(null),
		attached = $bindable([]), stored_files = $bindable([]), revising = $bindable(null), picker = $bindable(null),
		revision_pending, drafting, empty, error, models, chosen_model, on_pick_model, meter, catalog, read, nav, entries,
		file_href, on_attach, on_send, on_revise, on_dequeue, on_cancel_local, on_move, on_open_rail, on_stop, on_resume }: {
		t: (key: string) => string;
		unconfigured: boolean;
		status: AgentConversation['status'];
		rows: readonly AgentRow[];
		queued: readonly AgentRow[];
		draft?: string;
		mode?: AgentDraft['mode'];
		attached?: File[];
		stored_files?: NonNullable<AgentRow['files']>;
		revising?: AgentRow | null;
		picker?: HTMLInputElement | null;
		revision_pending: boolean;
		drafting: boolean;
		empty: boolean;
		error: string | null;
		models: readonly AiModel[];
		chosen_model: string | null;
		on_pick_model: (id: string | null) => void;
		meter: ReturnType<typeof context_meter>;
		catalog: Readonly<Record<string, ModelExposure>>;
		/** The finder's record search read. */
		read: FinderRead;
		nav: readonly NavNode[];
		entries: readonly ManifestItem[];
		file_href: (id: string) => string;
		on_attach: (files: readonly File[]) => void;
		on_send: (event?: SubmitEvent | KeyboardEvent | MouseEvent, now?: boolean, schedule?: string) => void;
		on_revise: (row: AgentRow) => void;
		on_dequeue: (row: AgentRow) => void;
		on_cancel_local: (row: OutboxRow) => void;
		on_move: (from: number, to: number) => void;
		on_open_rail: () => void;
		on_stop: () => void;
		on_resume: () => void;
	} = $props();
	const touch = new MediaQuery('pointer: coarse');
	const planning = $derived(mode === 'plan' || drafting);
	const scheduled = $derived(rows.filter((row) => row.role === 'user' && row.state === 'scheduled'));
	let dragFrom = $state<number | null>(null);
	function paste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		on_attach(files);
	}
	function drop(event: DragEvent): void {
		event.preventDefault();
		on_attach([...(event.dataTransfer?.files ?? [])]);
	}
	function keydown(event: KeyboardEvent): void {
		// plain Tab toggles plan mode (L-BOLT-541); an open `/` or `@` menu takes Tab first, a modified Tab moves focus
		if (
			event.key === 'Tab' &&
			!event.shiftKey &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.isComposing
		) {
			event.preventDefault();
			if (!drafting) mode = mode === 'plan' ? null : 'plan';
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		// a soft keyboard has no Shift+Enter: its Return is the new line, and Send sends
		if (touch.current && !commandKey(event)) return;
		on_send(event, commandKey(event));
	}
	/** The schedule popover, and the time picked in it (`datetime-local`: the person's clock). */
	let scheduling = $state(false),
		sendAt = $state('');
	/** `at` as a `datetime-local` value. */
	const localMinute = (at: number) =>
		new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	const sendsAt = (at: string) =>
		new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(at)
		);
	function schedule(event: MouseEvent, target: string): void {
		scheduling = false;
		sendAt = '';
		on_send(event, false, target);
	}
	const modelOptions = $derived(
		[...models]
			.sort(
				(a, b) =>
					(a.provider ?? '').localeCompare(b.provider ?? '') || a.label.localeCompare(b.label)
			)
			.map((m) => ({
				value: m.id,
				label: m.label,
				keywords: m.id,
				...(m.provider === undefined ? {} : { group: m.provider })
			}))
	);
	// Slash commands and @ mentions share the same app/model search grammar.
	const agentCommands = $derived<readonly CommandItem[]>([
		{
			id: 'plan',
			label: '/plan',
			description: t('Plan first; you approve before it acts'),
			icon: 'lucide:list-checks',
			run: () => (mode = 'plan')
		},
		{
			id: 'compact',
			label: '/compact',
			description: t('Summarize the conversation into a checkpoint'),
			icon: 'lucide:shrink',
			run: () => (mode = 'compact')
		},
		{
			id: 'export',
			label: '/export',
			description: t('Download this conversation as Markdown'),
			icon: 'lucide:download',
			run: exportTranscript
		}
	]);
	function exportTranscript(): void {
		const text = rows
			.filter((r) => r.text)
			.map((r) => `**${r.role}**: ${r.text}`)
			.join('\n\n');
		const a = Object.assign(document.createElement('a'), {
			href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })),
			download: 'conversation.md'
		});
		a.click();
		URL.revokeObjectURL(a.href);
	}
	function mentions(q: string) {
		return recordMentions(catalog, read, q, t, {
			nav,
			entries
		});
	}
	function commands(q: string) {
		return recordMentions(catalog, read, q, t, {
			nav,
			entries,
			prefix: '/'
		}).pipe(
			Effect.map((scopes) => [
				...(!/\s/.test(q)
					? agentCommands.filter((command) =>
							`${command.label} ${command.description}`.toLowerCase().includes(q.toLowerCase())
						)
					: []),
				...scopes
			])
		);
	}

</script>

				{#if planning || mode === 'compact'}
					<!-- Mode line: between the transcript and the composer's top border -->
					<p
						class="mx-auto w-full agent-column shrink-0 px-4 pb-2 text-tiny text-muted-foreground"
						data-mode-banner
					>
						{mode === 'compact'
							? t('Summarize this conversation and keep its transcript available.')
							: t(
									'Discuss the approach here. Expand the draft Plan above the prompt to review it.'
								)}
					</p>
				{/if}
				<!-- Composer: no box — one top border across the panel separates it from the transcript; below it notices and
		the queue, a borderless text area and its icon row (attach, context meter, model, a round send) -->
				<div class="shrink-0 border-t border-border bg-card pb-3" data-agent-composer>
					<div
						class="mx-auto flex w-full agent-column flex-col gap-2 pt-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
					>
						{#if unconfigured}
							<p
								role="alert"
								class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
								data-ai-unconfigured
							>
								{t(
									'The assistant is not set up yet. Ask an administrator to connect an AI provider.'
								)}
							</p>
						{/if}
						{#if queued.length > 0}
							<details open class="group/queue rounded-xl border border-border/70 bg-muted/20" data-agent-queue>
								<summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
									<Icon name="lucide:list-plus" class="size-3.5 shrink-0 text-muted-foreground" />
									<span class="font-medium">{t('Queued instructions')}</span>
									<span class="text-muted-foreground tabular-nums">{queued.length}</span>
									<Icon name="lucide:chevron-down" class="ml-auto size-3.5 text-muted-foreground transition-transform group-open/queue:rotate-180 motion-reduce:transition-none" />
								</summary>
								<p class="px-3 pb-2 text-xs text-muted-foreground">{t('Steers the current task at the next step.')}</p>
								<ol class="max-h-52 divide-y divide-border/60 overflow-auto border-t border-border/60">
									{#each queued as q, i (q.id)}
										{@const local = q.id.startsWith('local:')}
										<li class="group/queued flex items-start gap-2 px-2 py-2 {local ? 'opacity-70' : ''}" class:bg-muted={revising?.id === q.id}
											data-queued={q.id} aria-busy={local}
											ondragover={(event) => event.preventDefault()}
											ondrop={(event) => { event.preventDefault(); if (dragFrom !== null) on_move(dragFrom, i); dragFrom = null; }}>
											<Button type="button" size="icon" variant="ghost" class="size-8 shrink-0 cursor-grab active:cursor-grabbing"
												aria-label={t(touch.current ? 'Move up' : 'Reorder message')} title={t(touch.current ? 'Move up' : 'Drag or use the arrow keys to reorder')} disabled={local || (touch.current && i === 0)}
												draggable={!local} ondragstart={() => { dragFrom = i; }} ondragend={() => { dragFrom = null; }}
												onclick={() => { if (touch.current) on_move(i, i - 1); }}
												onkeydown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); on_move(i, i + (event.key === 'ArrowUp' ? -1 : 1)); } }}>
												<Icon name={touch.current ? 'lucide:arrow-up' : 'lucide:grip-vertical'} class="size-3.5 text-muted-foreground" />
											</Button>
											<div class="min-w-0 flex-1 py-1">
												<button type="button" class="line-clamp-2 w-full rounded-sm text-left text-sm break-words whitespace-pre-wrap outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50" disabled={local} onclick={() => on_revise(q)} title={q.text ?? ''}>
													{q.text || t('Attached message')}
												</button>
												{#if (q.files?.length ?? 0) > 0}<span class="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Icon name="lucide:paperclip" class="size-3" />{q.files?.length} {t('Attachments')}</span>{/if}
											</div>
											<div class="flex shrink-0 items-center gap-0.5">
												{#if local}<span class="py-2 text-xs text-muted-foreground" role="status">{t('Sending…')}</span>
												{:else}
													<Button type="button" size="icon" variant="ghost" class="size-8" aria-label={t('Move down')} title={t('Move down')} disabled={i === queued.length - 1} onclick={() => on_move(i, i + 1)}><Icon name="lucide:arrow-down" class="size-3.5" /></Button>
													<Button type="button" size="icon" variant="ghost" class="size-8" aria-label={t('Edit')} title={t('Edit')} onclick={() => on_revise(q)}><Icon name="lucide:pencil" class="size-3.5" /></Button>
												{/if}
												<Button type="button" size="icon" variant="ghost" class="size-8" aria-label={t('Remove')} title={t('Remove')} onclick={() => local ? on_cancel_local(q) : on_dequeue(q)}><Icon name="lucide:x" class="size-3.5" /></Button>
											</div>
										</li>
									{/each}
								</ol>
							</details>
						{/if}
						{#if scheduled.length > 0}
							<!-- what is held for a time or for the agent finishing: editable and removable until it goes -->
							<div class="grid w-full gap-1 text-xs" data-agent-scheduled>
								<span class="text-muted-foreground">{t('Scheduled')} · {scheduled.length}</span>
								<ol class="max-h-40 divide-y overflow-auto rounded-lg border border-border/70">
									{#each scheduled as s (s.id)}
										{@const local = s.id.startsWith('local:')}
										<li
											class="flex items-center gap-1 px-1.5 py-1 {local ? 'opacity-70' : ''}"
											data-scheduled={s.id}
										>
											<Icon
												name="lucide:timer"
												class="size-3.5 shrink-0 text-muted-foreground/60"
											/>
											<span class="min-w-0 flex-1 truncate" title={s.text ?? ''}
												>{s.text || t('Attached message')}</span
											>
											<span class="shrink-0 text-muted-foreground"
												>{s.due === undefined ? t('When Norbius finishes') : sendsAt(s.due)}</span
											>
											{#if !local}<Button
													variant="ghost"
													class="h-6 shrink-0 px-1.5 text-xs"
													onclick={() => on_revise(s)}>{t('Edit')}</Button
												>{/if}
											<Button
												size="icon"
												variant="ghost"
												class="size-6 shrink-0"
												aria-label={t('Remove')}
												onclick={() => (local ? on_cancel_local(s) : on_dequeue(s))}
												><Icon name="lucide:x" class="size-3.5" /></Button
											>
										</li>
									{/each}
								</ol>
							</div>
						{/if}
						{#if revising !== null}
							<Inline
								gap="sm"
								class="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2"
								data-revising
							>
								<Icon name="lucide:message-square-pen" class="size-3.5 shrink-0 text-primary" />
								<span class="min-w-0 flex-1 text-xs text-muted-foreground"
									>{revising.state === 'queued' || revising.state === 'scheduled'
										? t('Editing a queued message.')
										: t('Editing an earlier message. Sending adds a correction to this conversation.')}</span
								>
								<Button
									type="button"
									variant="ghost"
									class="-my-1 shrink-0 px-2 text-xs hover:bg-background"
									onclick={() => {
										revising = null;
										stored_files = [];
										attached = [];
										draft = '';
									}}>{t('Cancel')}</Button
								>
							</Inline>
						{/if}
						{#if status === 'stopped'}<p class="text-xs text-muted-foreground" data-stopped>
								{t('Stopped. Resume the stopped work, or send a follow-up.')}
							</p>{/if}
						{#if error !== null}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
						<form
							onsubmit={on_send}
							class="relative flex w-full flex-col"
							inert={revision_pending}
							aria-busy={revision_pending}
							ondragover={(e) => e.preventDefault()}
							ondrop={drop}
						>
							{#if mode === 'compact' || planning}
								{@const chip = mode === 'compact' ? 'compact' : 'plan'}
								<Inline gap="xs" class="pt-1" data-mode={chip}>
									<span
										class="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs"
										title={chip === 'plan' ? t('Switch between Agent and Plan (Tab)') : undefined}
									>
										<Icon
											name={chip === 'plan' ? 'lucide:list-todo' : 'lucide:scan-text'}
											class="size-3 shrink-0"
										/>/{chip}
										{#if chip === 'compact' || !drafting}<button
												type="button"
												class="grid size-4 place-items-center rounded-full opacity-70 hover:opacity-100"
												aria-label={t('Remove')}
												onclick={() => (mode = null)}
												><Icon name="lucide:x" class="size-3" /></button
											>{/if}
									</span>
								</Inline>
							{/if}
							{#if attached.length + stored_files.length > 0}
								<Attachments files={[...stored_files, ...attached]} file_href={file_href} {t} on_remove={(file) => { attached = attached.filter((f) => f !== file); stored_files = stored_files.filter((f) => f !== file); }} />
							{/if}
							<MarkdownEditor
								value={draft}
								on_change={(v) => (draft = v)}
								rows={2}
								{commands}
								command_start="word"
								{mentions}
								aria-label={t('Message')}
								class="[&_textarea]:max-h-40 [&_textarea]:min-h-14 [&_textarea]:resize-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0 [&_textarea]:py-3 [&_textarea]:text-sm [&_textarea]:leading-relaxed [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0 dark:[&_textarea]:bg-transparent"
								placeholder={t('Ask anything · @ to reference anything')}
								onkeydown={keydown}
								onpaste={paste}
							/>

							<input
								bind:this={picker}
								type="file"
								multiple
								class="sr-only"
								aria-hidden="true"
								tabindex="-1"
								accept="image/*,audio/*,text/*,application/pdf,application/json,application/xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.md,.csv,.tsv,.log,.yaml,.yml"
								onchange={(e) => {
									on_attach([...(e.currentTarget.files ?? [])]);
									e.currentTarget.value = '';
								}}
							/>
							<Inline gap="xs" class="pb-2">
								<!-- the attach glyph lines up with the text above it -->
								<Button
									type="button"
									size="icon"
									variant="ghost"
									class="-ml-2 shrink-0 text-muted-foreground"
									aria-label={t('Attach media or files')}
									title={t('Attach media or files')}
									onclick={() => picker?.click()}><Icon name="lucide:plus" class="size-4" /></Button
								>
								<button
									type="button"
									data-context-meter
									class="flex h-8 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground tabular-nums hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:min-h-11"
									aria-label={`${t('Context window used')}: ${k(meter.context)} / ${k(meter.window)}`}
									onclick={on_open_rail}
								>
									<Icon name="lucide:chart-pie" class="size-3.5" /><span
										>{meter.percent === null ? '—' : `${Math.round(meter.percent)}%`}</span
									>
								</button>
								<span class="flex-1"></span>
								{#if models.length > 1}
									<Combobox
										variant="ghost"
										searchable
										class="w-auto max-w-[45%] text-muted-foreground"
										options={modelOptions}
										value={chosen_model}
										placeholder={t('Model')}
										aria-label={t('Model')}
										on_change={on_pick_model}
									/>
								{/if}
								{#if !empty && revising === null}
									<Popover.Root bind:open={scheduling}>
										<Popover.Trigger
											type="button"
											class="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:size-11"
											aria-label={t('Schedule message')}
											title={t('Schedule message')}
											data-agent-schedule
										>
											<Icon name="lucide:timer" class="size-4" />
										</Popover.Trigger>
										<Popover.Content side="top" align="end" class="grid w-64 gap-2 p-2">
											{#if status === 'running'}
												<Button
													type="button"
													variant="outline"
													class="w-full"
													onclick={(e) => schedule(e, 'finish')}
													data-schedule-finish>{t('When Norbius finishes')}</Button
												>
											{/if}
											<Input
												type="datetime-local"
												min={localMinute(Date.now())}
												bind:value={sendAt}
												aria-label={t('Send at')}
											/>
											<Button
												type="button"
												class="w-full"
												disabled={sendAt === '' || Date.parse(sendAt) <= Date.now()}
												onclick={(e) => schedule(e, new Date(sendAt).toISOString())}
												data-schedule-at>{t('Schedule')}</Button
											>
										</Popover.Content>
									</Popover.Root>
								{/if}
								{#if status === 'running' && empty}<Button
										type="button"
										size="icon"
										class="shrink-0 rounded-full"
										aria-label={t('Stop')}
										title={t('Stop')}
										onclick={on_stop}
										data-agent-stop
										><Icon name="lucide:square" class="size-3.5 fill-current" /></Button
									>
								{:else if status === 'stopped' && empty}<Button
										type="button"
										size="icon"
										class="shrink-0 rounded-full"
										aria-label={t('Resume')}
										title={t('Resume')}
										onclick={on_resume}
										data-agent-resume><Icon name="lucide:play" class="size-4" /></Button
									>
								{:else}<Button
										type="submit"
										size="icon"
										class="shrink-0 rounded-full"
										aria-label={status === 'running' ? t('Send at the next step') : t('Send')}
										title={status === 'running' ? t('Send at the next step') : t('Send')}
										disabled={revision_pending || (empty && mode !== 'compact')}
									>
										<Icon
											name={status === 'running' ? 'lucide:corner-up-right' : 'lucide:arrow-up'}
											class="size-4"
										/>
									</Button>{/if}
							</Inline>
						</form>
					</div>
				</div>
<style>
	.agent-column { max-width: var(--agent-column-width); }
</style>
