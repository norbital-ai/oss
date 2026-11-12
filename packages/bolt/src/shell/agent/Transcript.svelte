<script lang="ts">
	import { Effect, Stream } from 'effect';
	import { observe as liveEdge } from '@norbital-ai/ui/effect';
	import { Button, Icon, ReadonlyMarkdown, Spinner, StructuredData, virtual_list, type UiContext } from '@norbital-ai/ui';
	import { Inline, Scroll } from '@norbital-ai/ui/layout';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { watch } from 'runed';
	import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
	import type { LogRow } from '../../engine/contracts.ts';
	import type { ShellApi } from '../api-types.ts';
	import { everySecond } from '../seconds.ts';
	import { based } from '../nav.ts';
	import { date_time } from '../i18n.ts';
	import { CLIENT_NAVIGATION, type ClientNavigation } from './navigation.ts';
	import { getContext, untrack } from 'svelte';
	import Steps from './Steps.svelte';
	import StudioApproval from './StudioApproval.svelte';
	import Question from './Question.svelte';
	import Attachments from './Attachments.svelte';
	import Decisions from './Decisions.svelte';
	import DecisionToggle from './DecisionToggle.svelte';
	import { decision_of, type Decided } from './decisions.ts';
	import { AgentPanelFailed, refused } from './actions.ts';
	import { checkpointSections, contextView, doingOf, failedVerbs, modelDividers, revisable, waiting_question } from './view.ts';
	let { ctx, api, t, zone, admin, conversation, rows, status, sent, thread, automation, goals, plan, before,
		loading_older, load_older, port = $bindable(null), pinned = $bindable(true), latest,
		load_failed, on_retry, decision_frame, dispatch, on_error, file_href, model_label,
		on_revise, revision_pending, on_restart, restart }: {
		ctx: UiContext;
		api: ShellApi;
		t: (key: string) => string;
		zone: string | undefined;
		admin: boolean;
		conversation: string | null;
		rows: AgentRow[];
		status: AgentConversation['status'];
		sent: string | null;
		thread: boolean;
		automation: boolean;
		goals: AgentConversation['goals'] | undefined;
		plan: AgentConversation['plan'] | undefined;
		before: number | null;
		loading_older: boolean;
		load_older: () => void;
		port?: HTMLElement | null;
		pinned?: boolean;
		latest: () => void;
		load_failed: boolean;
		on_retry: () => void;
		decision_frame: string | undefined;
		dispatch: (work: Effect.Effect<void, { readonly message: string }>) => void;
		on_error: (problem: string | null) => void;
		file_href: (id: string) => string;
		model_label: (id: string) => string;
		on_revise: (row: AgentRow) => void;
		revision_pending: boolean;
		on_restart: (row: AgentRow) => void;
		restart: { from: string | null; pending: boolean; error: string | null };
	} = $props();
	const atTail = (el: HTMLElement) => el.scrollTop >= -1;
	const clientNavigation = getContext<ClientNavigation | undefined>(CLIENT_NAVIGATION);
	const pending_question = $derived(waiting_question(rows));
	/** Confirmations whose answer is still being carried out: a publish can take minutes while the workspace rebuilds. */
	const answering = new SvelteSet<string>();
	const confirmFailed = new SvelteMap<string, string>();
	function confirm(row: AgentRow, approve: boolean): void {
		if (answering.has(row.id)) return;
		answering.add(row.id);
		confirmFailed.delete(row.id);
		dispatch(
			Effect.result(api.agent.confirm(row.id, approve)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						const problem = refused(answer);
						// on success the card stays busy until the server's `approved` state replaces its buttons
						if (problem === null) return;
						confirmFailed.set(row.id, problem);
						answering.delete(row.id);
					})
				),
				Effect.asVoid
			)
		);
	}
	const lastPending = $derived(rows.findLast((r) => r.state === 'pending')?.id);
	const lastReply = $derived(rows.findLastIndex((r) => r.role === 'assistant'));
	/** A triaged row's state (rule 60a), derived from the engine's markers and the turn's status; no label once it settles. */
	function triageLabel(row: AgentRow, i: number): string | null {
		if (row.state === 'pending') return t('reading…');
		return status === 'running' && row.state === 'consumed' && i > lastReply
			? t('responding')
			: null;
	}
	function respond_now(): void {
		if (conversation === null) return;
		dispatch(
			Effect.result(api.agent.respond_now(conversation)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						on_error(refused(answer));
					})
				),
				Effect.asVoid
			)
		);
	}
	/**
	 * The open conversation's `decision.made` events, newest first (the log is an administrator's): its tail is read whenever
	 * the transcript gains a row; streaming tokens do not reread the log.
	 */
	let log = $state<LogRow[]>([]);
	/** The decisions (by event) and steps (by row) a reader opened. */
	const expanded = new SvelteSet<string>();
	/** Step groups (by item key) the reader opened or closed: their choice outlasts the next step's re-render. */
	const folded = new SvelteMap<string, boolean>();
	/** The transcript's rows, not their streaming text: a decision lands with a new row, so a streamed token reads no log. */
	const decisions = liveEdge(() => {
		const frame = decision_frame;
		return !admin || conversation === null || frame === undefined
			? null
			: Stream.fromEffect(api.logs({ conversation, text: 'decision.made' }));
	});
	watch(
		() => $decisions,
		(entries) => {
			if (entries !== undefined) log = [...entries];
		}
	);

	watch(() => conversation, () => { log = []; expanded.clear(); });
	// the context view (L-BOLT-546): what the model no longer reads stays in the transcript, folded and dimmed
	const view = $derived(contextView(rows, plan));
	const outside = (r: AgentRow) => view.outside.has(r.id);
	const ORIGIN = {
		manual: 'you asked for it',
		requested: 'the assistant asked for it',
		automatic: 'the context was full'
	} as const;
	const dividers = $derived(modelDividers(rows));
	const approval_cards = $derived.by(() => {
		const approvals = new Set<string>(), cards = new Set<string>();
		for (const row of rows) {
			const approval = row.tool?.approval;
			if (approval === undefined || approvals.has(approval)) continue;
			approvals.add(approval);
			cards.add(row.id);
		}
		return cards;
	});
	/** A cut reply the turn did not continue (stopped, or its process died) is interrupted (L-BOLT-548). */
	const interrupted = (r: AgentRow) => r.tag === 'cut' && status !== 'running';
	// a running turn with no text yet counts its seconds (L-BOLT-548)
	let since = $state<number | null>(null),
		now = $state(Date.now());
	watch(
		() => status,
		(s) => {
			if (s !== 'running') return void (since = null);
			since = now = Date.now();
			return everySecond((at) => (now = at));
		}
	);
	const thinking = $derived(since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000)));

	// Detached, the reader keeps their place: the bottom-origin port holds its distance from the tail, so whatever arrives
	// or grows below (a reply, its stream, a row's measured height) would push the rows in view up. The first row in view holds.
	let held: { readonly el: Element; readonly top: number } | null = null;
	function hold(own: HTMLElement): void {
		const edge = own.getBoundingClientRect().top;
		const el = [...(own.querySelector('ol')?.children ?? [])].find((child) => {
			const box = child.getBoundingClientRect();
			return box.height > 0 && box.bottom > edge;
		});
		held = el === undefined ? null : { el, top: el.getBoundingClientRect().top };
	}
	function restore(): void {
		if (pinned || port === null || held === null || !held.el.isConnected) return;
		const by = held.el.getBoundingClientRect().top - held.top;
		if (by !== 0) port.scrollTop += by;
	}
	$effect(() => {
		void rows;
		untrack(restore);
	});
	const keep_place = (list: HTMLElement) => {
		const observer = new ResizeObserver(restore);
		observer.observe(list);
		return () => observer.disconnect();
	};

	function scrolled(): void {
		if (port === null) return;
		pinned = atTail(port);
		if (pinned) held = null;
		else hold(port);
		if (!pinned && port.scrollHeight - port.clientHeight + port.scrollTop < 240) load_older();
	}
	/** A row shown on its own: a person's message, a confirmation card, a reply's text, a checkpoint or a verdict. */
	const shown = (r: AgentRow) =>
		// a bare `/compact` is the checkpoint's own line, not a message
		(r.role === 'user' &&
			r.report === undefined &&
			r.text !== '/compact' &&
			(r.state !== 'queued' || thread) &&
			r.state !== 'scheduled' &&
			(!!r.text || (r.files?.length ?? 0) > 0)) ||
		((r.state === 'confirm' || r.state === 'approved') && r.call !== undefined) ||
		(r.role === 'assistant' && (!!r.text || r.question !== undefined)) ||
		(r.role === 'system' && (r.tag === 'compact' || r.tag === 'verdict') && !!r.text);
	// The work between chat messages folds into one group: tool calls, received sub-agent messages and reasoning
	// (a reply's own reasoning ahead of its text). A person's message, a reply's text or a card ends the group.
	// Spawning a sub-agent is a step; its detached work lives in the session rail. Rows behind the context boundary
	// stay dimmed (L-BOLT-546).
	// For an administrator, each triaged batch closes with its decision: the newest `decision.made` naming a message decides
	// it, and the mark follows the batch's last message; `awaiting` is a decided reply not written yet.
	
	// Messages not for the agent (triage's `ignore`, or chatter) fold into one quiet block that carries its decision, so the
	// transcript stays message → work → reply, turn by turn.
	type Item =
		| { row: AgentRow; index: number }
		| { steps: [AgentRow, ...AgentRow[]] }
		| { decision: Decided; awaiting: boolean }
		| { ignored: [AgentRow, ...AgentRow[]]; decision?: Decided };
	const decided = $derived.by(() => {
		const by = new Map<string, Decided>();
		for (const event of log) {
			const d = decision_of(event.attributes);
			for (const p of d.state?.pending ?? [])
				if (p.id !== undefined && !by.has(p.id)) by.set(p.id, { event, d });
		}
		return by;
	});
	const items = $derived.by(() => {
		const closes = new Map<string, string>(); // event id → the batch's last message in the transcript
		for (const r of rows) {
			const x = decided.get(r.id);
			if (x !== undefined) closes.set(x.event.id, r.id);
		}
		const replied = rows.findLastIndex((r) => r.role === 'assistant' && !!r.text);
		return rows.reduce<Item[]>((out, row, index) => {
			const last = out.at(-1);
			if (
				row.tool !== undefined ||
				row.report !== undefined ||
				(row.role === 'assistant' && !!row.reasoning)
			) {
				if (last !== undefined && 'steps' in last) last.steps.push(row);
				else out.push({ steps: [row] });
			}
			const aside = row.role === 'user' && row.tag === 'ambient';
			if (aside && shown(row)) {
				if (last !== undefined && 'ignored' in last) last.ignored.push(row);
				else out.push({ ignored: [row] });
			} else if (row.tool === undefined && shown(row)) out.push({ row, index });
			const x = decided.get(row.id),
				block = out.at(-1);
			if (x === undefined || closes.get(x.event.id) !== row.id) return out;
			// the row is the record: an ambient row was not answered, so a `respond` decision naming it is stale (a
			// re-run after a restart) and must not leave a phantom "reply pending" for ever
			if (row.tag === 'ambient' && x.d.action !== 'ignore') return out;
			// a member's own conversation answers every message: only a channel thread shows its triage marks
			if (!thread && x.d.action === 'respond') return out;
			if (block !== undefined && 'ignored' in block && x.d.action !== 'respond') block.decision = x;
			else out.push({ decision: x, awaiting: x.d.action === 'respond' && index > replied });
			return out;
		}, []);
	});
	// a long conversation windows its items (measured, keyed by their first row) inside the transcript's scroll port
	const itemKey = (i: number) => {
		const it = items[i];
		if (it === undefined) throw new RangeError('Transcript item index is outside its measured range.');
		return 'row' in it
			? it.row.id
			: 'steps' in it
				? `steps:${it.steps[0].id}`
				: 'ignored' in it
					? `ignored:${it.ignored[0].id}`
					: `decision:${it.decision.event.id}`;
	};
	const turns = virtual_list({ count: () => items.length, key: itemKey, estimate: 56, tail: () => pinned });
	/** On a channel thread, each reply's inputs: the messages its turn took since its previous reply. */
	const replying = $derived.by(() => {
		const by = new Map<string, AgentRow[]>();
		if (!thread) return by;
		const open = new Map<string, AgentRow[]>();
		for (const r of rows) {
			if (r.turn === undefined) continue;
			if (r.role === 'user' && r.tag !== 'ambient')
				open.set(r.turn, [...(open.get(r.turn) ?? []), r]);
			else if (r.role === 'assistant' && !!r.text && (open.get(r.turn)?.length ?? 0) > 0) {
				const inputs = open.get(r.turn);
				if (inputs !== undefined) by.set(r.id, inputs);
				open.delete(r.turn);
			}
		}
		return by;
	});
	const said = (r: AgentRow) => `${r.author ? `${r.author}: ` : ''}${r.text ?? ''}`;
	/** A step still being written: a running call, or reasoning whose reply is still streaming. */
	const active = (s: AgentRow) => s.tool?.running === true || s.state === 'streaming';
	/** The group's wall time: its first step's start to its last step's end (a call's `ms`), whole seconds. */
	function worked(steps: readonly AgentRow[]): number | null {
		const first = steps[0]?.at,
			last = steps.at(-1);
		if (first === undefined || last === undefined || last.at === undefined) return null;
		return Math.max(
			1,
			Math.round((Date.parse(last.at) + (last.tool?.ms ?? 0) - Date.parse(first)) / 1000)
		);
	}
	// Between steps show the whole run's elapsed time, not a claim about the current model wait. A steps group that already
	// says it is working is that line: do not repeat it below.
	const workingGroup = $derived(
		status === 'running' &&
			items.some(
				(item, index) => 'steps' in item && (index === items.length - 1 || item.steps.some(active))
			)
	);
	const quiet = $derived(
		status === 'running' &&
			!workingGroup &&
			!rows.some((r) => r.state === 'streaming' || r.state === 'running')
	);
	/** The "Open page" row's link is the URL the person shares, not the logical path it shows. */
	let copiedNavigation = $state<string | null>(null);
	function copyNavigation(path: string): void {
		const clipboard = navigator.clipboard;
		if (clipboard === undefined) return;
		const url = new URL(based(path), location.href).href;
		dispatch(
			Effect.tryPromise({
				try: () => clipboard.writeText(url),
				catch: (cause) =>
					new AgentPanelFailed({ message: t('The link could not be copied.'), cause })
			}).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						copiedNavigation = path;
					})
				),
				Effect.andThen(Effect.sleep('1500 millis')),
				Effect.ensuring(
					Effect.sync(() => {
						if (copiedNavigation === path) copiedNavigation = null;
					})
				)
			)
		);
	}
	/** A sent message's text, copied from the actions under it. */
	let copiedMessage = $state<string | null>(null);
	function copyMessage(row: AgentRow): void {
		const clipboard = navigator.clipboard;
		if (clipboard === undefined) return;
		dispatch(
			Effect.tryPromise({
				try: () => clipboard.writeText(row.text ?? ''),
				catch: (cause) =>
					new AgentPanelFailed({ message: t('The text could not be copied.'), cause })
			}).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						copiedMessage = row.id;
					})
				),
				Effect.andThen(Effect.sleep('1500 millis')),
				Effect.ensuring(
					Effect.sync(() => {
						if (copiedMessage === row.id) copiedMessage = null;
					})
				)
			)
		);
	}
	/** When a message was sent: "Just now" for a minute, then its time of day, or its date before today. */
	function sentAt(at: string): string {
		const sent = new Date(at);
		if (Date.now() - sent.getTime() < 60_000) return t('Just now');
		return sent.toDateString() === new Date().toDateString()
			? sent.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
			: sent.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	/** Each code block of a reply gets a copy button (the Markdown renders plain `pre`; this re-adds it after each render). */
	function copyable(el: HTMLElement): () => void {
		const add = () => {
			for (const pre of el.querySelectorAll('pre')) {
				if (pre.querySelector('[data-copy]') !== null) continue;
				pre.classList.add('relative', 'group/code');
				const b = Object.assign(document.createElement('button'), {
					type: 'button',
					textContent: t('Copy')
				});
				b.dataset['copy'] = '';
				b.className =
					'absolute top-1.5 right-1.5 rounded-md bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-foreground';
				b.onclick = () => {
					const clipboard = navigator.clipboard;
					if (clipboard === undefined) return;
					const text = pre.querySelector('code')?.textContent ?? '';
					dispatch(
						Effect.tryPromise({
							try: () => clipboard.writeText(text),
							catch: (cause) =>
								new AgentPanelFailed({ message: t('The text could not be copied.'), cause })
						}).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									b.textContent = t('Copied');
								})
							),
							Effect.andThen(Effect.sleep('1500 millis')),
							Effect.ensuring(
								Effect.sync(() => {
									b.textContent = t('Copy');
								})
							)
						)
					);
				};
				pre.append(b);
			}
		};
		add();
		const watcher = new MutationObserver(add);
		watcher.observe(el, { childList: true, subtree: true });
		return () => watcher.disconnect();
	}

</script>

{#snippet attachments(row: AgentRow)}
	{#if (row.files?.length ?? 0) > 0}<Attachments files={row.files ?? []} file_href={file_href} {t} />{/if}
{/snippet}
					<!-- the scroll port spans the panel; its padding centres a readable column (Codex's) -->
					<Scroll
						name={t('Conversation transcript')}
						axis="both"
						size="fill"
						fade={false}
						bind:ref={port}
						onscroll={scrolled}
						class="flex h-auto min-h-0 w-full flex-1 flex-col-reverse overflow-auto overscroll-contain [scrollbar-gutter:auto]"
						style={`overflow-anchor: ${pinned ? 'none' : 'auto'}`}
						data-agent-transcript
					>
					<ol class="min-h-full w-full shrink-0 space-y-5 agent-transcript py-4 text-sm leading-6" aria-live="polite" {@attach keep_place}>
						{#if conversation === null && rows.length === 0 && status !== 'running' && sent === null}
							<li
								class="flex min-h-56 items-center justify-center text-center text-muted-foreground"
								data-agent-empty
							>
								<p class="max-w-sm">
									{t(
										'Start a conversation. Ask for help or switch to Plan to work through an approach.'
									)}
								</p>
							</li>
						{/if}
						{#if conversation !== null && rows.length === 0 && load_failed}
							<li
								class="flex min-h-56 flex-col items-center justify-center gap-3 text-center"
								data-agent-error
								role="alert"
							>
								<p class="max-w-sm text-sm text-destructive">
									{t('The conversation could not load.')}
								</p>
								<Button variant="outline" onclick={on_retry}
									>{t('Retry')}</Button
								>
							</li>
						{/if}
						{#if before !== null}
							<li class="flex justify-center" data-older>
								<button
									type="button"
									class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
									disabled={loading_older}
									onclick={load_older}
									>{loading_older ? t('Loading…') : t('Earlier messages')}</button
								>
							</li>
						{/if}
						{#if turns.on}<li
								aria-hidden="true"
								style="height:{turns.before}px"
								{@attach turns.anchor}
							></li>{/if}
						{#each turns.slice(items) as item, j (itemKey(turns.start + j))}
							{@const at = turns.start + j}
							{#if 'steps' in item}
								<!-- the work between two messages: one quiet line, open while it runs, each step opening to its input and result -->
								{@const working =
									status === 'running' && (at === items.length - 1 || item.steps.some(active))}
								{@const secs = worked(item.steps)}
								{@const failures = failedVerbs(item.steps)}
								<!-- what it did: its reasoning opens with the steps but is no step of its own -->
								{@const calls = item.steps.filter((step) => step.tool !== undefined).length}
								{@const key = itemKey(at)}
								{@const open = folded.get(key) ?? working}
								<li
									{@attach turns.measure(itemKey(at))}
									data-role="steps"
									data-outside-context={item.steps.every(outside) || undefined}
									data-failed={failures.length > 0 || undefined}
								>
									<details
										class="group/work min-w-0 w-full"
										{open}
										ontoggle={(event) => {
											if (event.currentTarget.open !== open)
												folded.set(key, event.currentTarget.open);
										}}
									>
										<summary
											class="flex min-h-8 w-full pointer-coarse:min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
											data-working={working || undefined}
										>
											{#if working}<span class="agent-shimmer">{t(doingOf(item.steps))}</span
												>{:else}<span>{t('Worked for')} {secs === null ? '' : `${secs}s`}</span
												>{/if}
											<span>· {`${calls} ${t(calls === 1 ? 'step' : 'steps')}`}</span>
											{#if failures.length > 0}{@const named = `${failures.length} ${t(failures.length === 1 ? 'step failed' : 'steps failed')}: ${failures.map(t).join(', ')}`}<span
													role="img"
													aria-label={named}
													title={named}
													data-failed-steps
													><Icon
														name="lucide:circle-alert"
														class="size-3 text-destructive"
													/></span
												>{/if}
											<Icon
												name="lucide:chevron-right"
												class="ml-auto size-3.5 shrink-0 transition-transform group-open/work:rotate-90 motion-reduce:transition-none"
											/>
										</summary>
										<Steps {ctx} steps={item.steps} {t} opened={expanded} />
									</details>
									{#each item.steps.filter((step) => approval_cards.has(step.id)) as st (st.id)}
										<!-- a live change the host holds for the person: at the call that asked for it -->
										<div class="my-2">
											{#key st.tool?.approval}<StudioApproval {api} step={st} {t} {zone} />{/key}
										</div>
									{/each}
									{#each item.steps as st (st.id)}
										{#if !thread && st.tool?.navigation !== undefined && clientNavigation !== undefined && conversation !== null}
											{@const path = st.tool.navigation}
											{@const id = conversation}
											<div class="group/nav relative my-2">
												<Button
													variant="outline"
													class="w-full justify-start gap-2 pr-10"
													onclick={() => clientNavigation.open(path, id)}
												>
													<Icon name="lucide:arrow-up-right" class="size-4" />
													<span>{t('Open page')}</span><span
														class="ml-auto truncate text-xs text-muted-foreground">{path}</span
													>
												</Button>
												<button
													type="button"
													class="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/nav:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:none)]:opacity-100"
													aria-label={t('Copy')}
													title={t('Copy')}
													onclick={() => copyNavigation(path)}
												>
													<Icon
														name={copiedNavigation === path ? 'lucide:check' : 'lucide:copy'}
														class="size-3.5"
													/>
												</button>
											</div>
										{/if}
									{/each}
									{#if item.steps.some((st) => (st.files?.length ?? 0) > 0)}
										<!-- what the work made (a screenshot, a document): outside the fold -->
										<Attachments
											files={item.steps.flatMap((st) => st.files ?? [])}
											file_href={file_href}
											{t}
										/>
									{/if}
								</li>
							{:else if 'ignored' in item}
								{@const dec = item.decision}
								{@const n = item.ignored.length}
								<!-- messages not for the agent: one quiet block, collapsed to its count and last message, opening to each sender and text -->
								<li
									{@attach turns.measure(itemKey(at))}
									data-role="ignored"
									data-decision={dec?.event.id}
									data-action={dec?.d.action}
									class="ml-auto flex w-fit max-w-[85%] items-start gap-1.5 rounded-xl border border-dashed border-border/80 px-3 py-2 text-xs text-muted-foreground"
								>
									<details class="group/aside min-w-0" data-aside>
										<summary
											class="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden"
										>
											<Icon name="lucide:message-circle-off" class="size-3.5 shrink-0" /><span
												class="shrink-0 font-medium"
												data-aside-count
												>{`${n} ${t(n === 1 ? 'message not for the assistant' : 'messages not for the assistant')}`}</span
											><span class="truncate opacity-70 group-open/aside:hidden" data-aside-last
												>{said(item.ignored.at(-1) ?? item.ignored[0])}</span
											><Icon
												name="lucide:chevron-right"
												class="size-3 shrink-0 transition-transform group-open/aside:rotate-90"
											/>
										</summary>
										<ul class="mt-1 space-y-1">
											{#each item.ignored as r (r.id)}
												<li
													class="break-words whitespace-pre-wrap"
													data-role="user"
													data-triage="ambient"
												>
													<span class="opacity-70">{r.author ?? ''}{r.author ? ': ' : ''}</span
													><span data-text>{r.text}</span>{@render attachments(r)}
												</li>
											{/each}
										</ul>
										{#if dec !== undefined && expanded.has(dec.event.id)}<Decisions decision={dec} {t} />{/if}
									</details>
									{#if dec !== undefined}<DecisionToggle decision={dec} cls="ml-auto shrink-0" opened={expanded} {t} />{/if}
								</li>
							{:else if 'decision' in item}
								{@const { event } = item.decision}
								<!-- the decider's call on the message above: a small mark under it, opening to the matrix it answered -->
								<li
									{@attach turns.measure(itemKey(at))}
									data-role="decision"
									data-decision={event.id}
									data-action={item.decision.d.action}
									data-awaiting={item.awaiting || undefined}
								>
									<div class="flex items-center justify-end gap-2 text-xs text-muted-foreground">
										{#if item.awaiting}<span class="agent-shimmer" data-reply-pending
												>{t('reply pending')}</span
											>{/if}
										<DecisionToggle decision={item.decision} cls="" opened={expanded} {t} />
									</div>
									{#if expanded.has(event.id)}<Decisions decision={item.decision} {t} />{/if}
								</li>
							{:else}
								{@const { row, index } = item}
								{#if row.role === 'user'}
									{@const label = triageLabel(row, index)}
									<!-- the bubble holds the message alone; its time and actions sit under it, as a chat reads -->
									<li
										{@attach turns.measure(itemKey(at))}
										class="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1"
										class:opacity-60={row.state === 'pending' || row.tag === 'ambient'}
										data-role="user"
										data-outside-context={outside(row) || undefined}
										data-pending={row.state === 'pending' || undefined}
									>
										<div
											class="min-w-0 max-w-full rounded-xl bg-muted px-4 py-2.5 break-words"
										>
											<!-- an automation's prompt is authored Markdown (its sources and index fenced): rendered, code blocks and all -->
											{#if automation}<div
													{@attach copyable}
													class="agent-reply whitespace-normal"
													data-text
												>
													<ReadonlyMarkdown
														value={row.text ?? ''}
														class="prose-pre:bg-background prose-pre:text-foreground"
													/>
												</div>{:else if row.text}<div class="whitespace-pre-wrap" data-text>{row.text}</div>{/if}{@render attachments(
												row
											)}
										</div>
										{#if !thread && row.state === 'consumed'}
											<div
												class="flex items-center gap-0.5 text-xs text-muted-foreground"
												data-message-actions
											>
												{#if row.at !== undefined}<time
														class="mr-1"
														datetime={row.at}
														title={date_time(row.at)}>{sentAt(row.at)}</time
													>{/if}
												{#if (row.text ?? '') !== ''}<Button
														variant="ghost"
														size="icon"
														class="size-6"
														aria-label={t('Copy')}
														title={copiedMessage === row.id ? t('Copied') : t('Copy')}
														onclick={() => copyMessage(row)}
														><Icon
															name={copiedMessage === row.id ? 'lucide:check' : 'lucide:copy'}
															class="size-3.5"
														/></Button
													>{/if}
												{#if revisable(row)}<Button
														variant="ghost"
														size="icon"
														class="size-6"
														aria-label={t('Edit message')}
														title={t('Edit message')}
														onclick={() => on_revise(row)}
														><Icon name="lucide:pencil" class="size-3.5" /></Button
													>{/if}
												{#if revisable(row) && !automation}<Button
													variant="ghost" size="icon" class="size-7 pointer-coarse:size-11"
													aria-label={t('Restart in a new chat from this message')} title={t('Restart in a new chat from this message')}
													disabled={restart.pending || revision_pending}
													onclick={() => on_restart(row)}
												><Icon name={restart.pending && restart.from === row.id ? 'lucide:loader-circle' : 'lucide:git-branch'} class="size-3.5 {restart.pending && restart.from === row.id ? 'animate-spin motion-reduce:animate-none' : ''}" /></Button>{/if}
											</div>
										{/if}
										{#if restart.from === row.id && restart.error !== null}<p role="alert" class="max-w-full text-xs text-destructive">{restart.error}</p>{/if}
										{#if label !== null}
											<span
												class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground"
												data-triage={row.state === 'pending' ? 'waiting' : 'responding'}
												data-role={row.id === lastPending ? 'waiting' : undefined}
											>
												<span>{label}</span>
												{#if !thread && row.id === lastPending}<Button
														variant="ghost"
														onclick={respond_now}>{t('Respond now')}</Button
													>{/if}
											</span>
										{/if}
									</li>
								{:else if !thread && (row.state === 'confirm' || row.state === 'approved') && row.call}
									{@const call = row.call}
									{@const busy = answering.has(row.id) || row.state === 'approved'}
									<li
										{@attach turns.measure(itemKey(at))}
										class="rounded-xl border border-border/70 bg-background p-3"
										data-role="confirm"
									>
										<p class="text-sm font-medium text-foreground">
											{t('Allow Norbius to do this?')}
										</p>
										<details
											open={call.name === 'act'}
											class="mt-1 text-xs text-muted-foreground"
										>
											<summary class="cursor-pointer">{t('Details')}</summary>
											<div class="mt-1 max-h-48 min-w-0 overflow-auto">
												<StructuredData {ctx} value={call.input} name={t('Input')} />
											</div>
										</details>
										<Inline gap="xs" class="mt-2" align="center">
											{#if row.state === 'confirm'}<Button
													disabled={busy}
													onclick={() => confirm(row, true)}>{t('Approve')}</Button
												>
												<Button
													variant="outline"
													disabled={busy}
													onclick={() => confirm(row, false)}>{t('Decline')}</Button
												>{/if}
											{#if busy}<span class="text-xs text-muted-foreground" role="status"
													>{t('Working on it… you can keep using the app.')}</span
												>{/if}
										</Inline>
										{#if confirmFailed.has(row.id)}<p
												class="mt-2 text-sm text-destructive"
												role="alert"
											>
												{confirmFailed.get(row.id)}
											</p>{/if}
									</li>
								{:else if row.role === 'assistant' && row.question !== undefined && conversation !== null}
									<li {@attach turns.measure(itemKey(at))} data-role="question">
										<Question {api} {conversation} id={row.id} question={row.question} answered={row.answered === true || rows.some((answer) => answer.answer_to === row.id && answer.state !== 'cancelled')} pending={pending_question?.id === row.id} active={!thread && status !== 'running' && pending_question?.id === row.id} {t} />
									</li>
								{:else if row.role === 'assistant' && row.text}
									{@const model = dividers.get(row.id)}
									{@const reply_inputs = replying.get(row.id)}
									<!-- a reply is plain flowing Markdown, no bubble; while it is written its text grows patch by patch behind a caret -->
									<li
										{@attach turns.measure(itemKey(at))}
										data-role="assistant"
										data-outside-context={outside(row) || undefined}
										data-streaming={row.state === 'streaming' || undefined}
									>
										{#if model !== undefined}<p
												class="mb-3 flex items-center gap-2 text-xs text-muted-foreground"
												data-model-divider={model}
											>
												<span class="h-px flex-1 bg-border"></span><Icon
													name="lucide:cpu"
													class="size-3.5 shrink-0"
												/><span>{t('Switched to')} {model_label(model)}</span><span
													class="h-px flex-1 bg-border"
												></span>
											</p>{/if}
										{#if reply_inputs !== undefined}<p
												class="mb-1 truncate text-xs text-muted-foreground"
												data-replying-to
											>
												{t('Replying to')}: {reply_inputs.map(said).join(' · ')}
											</p>{/if}
										<div {@attach copyable} class="agent-reply">
											<ReadonlyMarkdown
												value={row.text}
												class="prose-pre:bg-muted prose-pre:text-foreground"
											/>
										</div>
										{#if interrupted(row)}<p
												class="text-xs text-muted-foreground"
												data-interrupted
											>
												{t('Interrupted')}
											</p>{/if}
										{#if row.detail}<p class="text-xs text-muted-foreground" data-detail>
												{row.detail}
											</p>{/if}
										{#each (row.receipts ?? []) as r, i (i)}
											<p class="text-xs text-muted-foreground" data-receipt>
												{r.outcome === 'pending_approval' ? t('Awaiting approval') : t('Done')}: {r.callable}
											</p>
										{/each}
									</li>
								{:else if row.role === 'system'}
									<li {@attach turns.measure(itemKey(at))} data-role="note" data-tag={row.tag}>
										{#if row.tag === 'compact'}
											<!-- a checkpoint is one line across the transcript, Codex's: what came before is summarized (and dimmed);
											it opens to the summary the agent continues from -->
											<details class="group/cp">
												<summary
													class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
													data-compaction={row.compact?.origin}
												>
													<span class="h-px flex-1 bg-border"></span>
													<Icon name="lucide:shrink" class="size-3.5 shrink-0" />
													<span>{t('Context compacted')}</span>
													{#if row.compact !== undefined}<span class="opacity-70"
															>· {t(ORIGIN[row.compact.origin])}</span
														>{/if}
													<span class="h-px flex-1 bg-border"></span>
												</summary>
												<div class="mt-2 rounded-md bg-muted/30 p-3 text-sm">
													<ReadonlyMarkdown value={checkpointSections(row.text ?? '')} />
												</div>
											</details>
										{:else}
											<details class="rounded-md border px-3 py-2 text-xs text-muted-foreground">
												<summary class="cursor-pointer">{row.text?.split('\n')[0]}</summary>
												<div class="mt-2"><ReadonlyMarkdown value={row.text ?? ''} /></div>
											</details>
										{/if}
									</li>
								{/if}
							{/if}
						{/each}
						{#if turns.after > 0}<li aria-hidden="true" style="height:{turns.after}px"></li>{/if}
						{#if quiet}
							<li class="text-xs text-muted-foreground" data-role="thinking" data-thinking>
								<span class="agent-shimmer">{t('Working…')}</span>
								<span class="tabular-nums">{thinking}s</span>
							</li>
						{/if}
						{#if goals?.length}
							<!-- the goals: one checklist under the latest message, each step's state at a glance; collapsible -->
							<li data-goals>
								<details class="group/goals rounded-xl border border-border/70 px-4 py-3" open>
									<summary
										class="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground focus-visible:ring-ring/40 rounded focus-visible:ring-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
									>
										<Icon
											name="lucide:chevron-right"
											class="size-3.5 shrink-0 transition-transform group-open/goals:rotate-90"
										/>
										<span class="font-medium">{t('Goals')}</span>
										<span class="tabular-nums"
											>{goals.filter((g) => g.status === 'done').length}/{goals
												.length}</span
										>
									</summary>
									<ol class="mt-2 grid gap-1.5" aria-label={t('Goal steps')}>
										{#each goals as g (g.id)}
											<li class="flex min-w-0 items-start gap-2" data-goal={g.status}>
												{#if g.status === 'done'}<Icon
														name="lucide:circle-check"
														class="mt-1 size-4 shrink-0 text-muted-foreground"
													/>
												{:else if g.status === 'doing' && status === 'running'}<Spinner
														class="mt-1 size-4 shrink-0"
														label={t('In progress')}
													/>
												{:else}<Icon
														name="lucide:circle-dashed"
														class="mt-1 size-4 shrink-0 text-muted-foreground"
													/>{/if}
												<span
													class="min-w-0 {g.status === 'pending' ? 'text-muted-foreground' : ''}"
													>{g.text}</span
												>
											</li>
										{/each}
									</ol>
								</details>
							</li>
						{/if}
					</ol>
					</Scroll>
					{#if !pinned}
						<Button
							variant="secondary"
							class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-md"
							aria-label={t('Jump to latest')}
							onclick={() => latest()}
							data-latest
						>
							<Icon name="lucide:arrow-down" class="size-4" />{t('Latest')}</Button
						>
					{/if}
<style>
	.agent-transcript {
		padding-left: max(1rem, calc((100% - var(--agent-column-width)) / 2 + 1rem), env(safe-area-inset-left));
		padding-right: max(1rem, calc((100% - var(--agent-column-width)) / 2 + 1rem), env(safe-area-inset-right));
	}
	/* the active step's words: a light band sweeping across muted text (still under reduced motion) */
	.agent-shimmer {
		background: linear-gradient(
				90deg,
				var(--color-muted-foreground) 35%,
				var(--color-foreground) 50%,
				var(--color-muted-foreground) 65%
			)
			0 0 / 250% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: agent-shimmer 1.8s linear infinite;
	}
	@keyframes agent-shimmer {
		from {
			background-position: 100% 0;
		}
		to {
			background-position: -150% 0;
		}
	}
	/* what the model no longer reads (summarized, or before an executed plan) stays, dimmed */
	[data-outside-context] {
		opacity: 0.5;
	}
	/* a reply being written ends in a blinking caret */
	[data-streaming] .agent-reply :global([data-markdown] > :last-child::after) {
		content: '▍';
		margin-left: 0.1em;
		animation: agent-caret 1s steps(2) infinite;
	}
	@keyframes agent-caret {
		to {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.agent-shimmer {
			animation: none;
			color: var(--color-muted-foreground);
		}
		[data-streaming] .agent-reply :global([data-markdown] > :last-child::after) {
			animation: none;
		}
	}
</style>
