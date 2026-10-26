<!--
	The in-app agent panel (§5.9, rules 58, 59): one conversation per tab, the transcript with each reply's receipts,
	a confirmation card for a held call, and the running turn's text as it streams. Posting answers at once; the turn
	runs after it, and everything it writes (the reply growing flush by flush, each tool call running then finished) is
	rows of the conversation's live transcript, patched in over the page's one live stream; the conversation list, each
	one's status, plan and goals are a live read too. Nothing polls and there is no second stream. Enter sends, Shift+Enter is a
	new line, Cmd/Ctrl+Enter sends now. With triage (rule 60a, P41) each triaged row carries its state: "waiting for
	more…" while pending (with respond-now), "responding" once admitted and its turn runs; messages not for the agent fold into one
	quiet "Not for the assistant" block. Files are attached with the paperclip, by paste
	or by drop (at most 8 files, 20 MiB); each uploads to `/__bolt/files/sys_conversation.inputs` when the message is sent.
	The selector switches between the member's own conversations and the envoy conversation threads they may read, segmented by
	source (newest first); delegated sub-agents live in the session rail (their tasks, live steps and answers),
	several working at once, one level deep; messages sent while a turn runs wait in the queue (edit, move up, remove); the context meter reads the
	last reply's usage; the transcript follows its tail unless the reader scrolled up ("Latest" returns); a running turn
	stops (asked first) and a stopped one resumes; a draft plan is a collapsed card above the prompt (execute, delete), an
	executed plan a strip above the transcript (revise, delete), the goals a checklist under the latest message, and a
	checkpoint one line across the transcript, opening to its summary. The session rail (the
	header's panel button, or the context meter) shows input, outputs, sub-agents and disclosures for the context, what the conversation changed,
	the work it left running in the background (its sub-agents and automation runs, each stoppable while it runs), and the connected MCP servers. The composer has no box: one top border.
	While a turn runs the accretion disc is the orb and an empty reply counts its seconds; plain Tab toggles plan mode;
	what the model no longer reads (summarized into the latest checkpoint, or before an executed plan) is dimmed; the orb names the conversation's state; reasoning streams above the reply and stays on it, folded; a
	cut reply that no turn continues is marked interrupted; a divider names the model where it changed. Consecutive
	tool calls, sub-agent messages and reasoning fold into one "Worked for Ns" group whose rows (each event's own icon, what it did, on what,
	how long) open to tabs: the code it carried, highlighted, its input and its output (`Steps`); a failed row's icon is the alert, so the call that failed reads at a glance. Code blocks copy. The open conversation is the shell's `?agent=` (`onConversation` reports a switch). The
	picker groups conversations by where they happen: the member's own (Web UI), each envoy's direct messages, and each
	envoy group chat by its name. For an administrator, a scale mark closes each triaged batch of messages; it opens to the
	decider's matrix (each message, its answer and verdict, the wait) and says when a decided reply is still to come. An
	envoy's integration conversation is read-only here (rule 61): its transcript, and no composer or controls at all.
-->
<script lang="ts">
	import { attach as attachEffect, observe as liveEdge, fork } from '@norbital-ai/ui/effect';
	import { Effect, FiberSet, Option, Predicate, Result, Schedule, Schema, Stream } from 'effect';
	import { getContext, tick, type Snippet } from 'svelte';
	import { MediaQuery, SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import { watch } from 'runed';
	import { Inline } from '@norbital-ai/ui/layout';
	import { AccretionDisc, NorbiusStrip } from '@norbital-ai/ui/brand';
	import {
		Button,
		Combobox,
		Dialog,
		formatHandle,
		Icon,
		Image,
		MarkdownEditor,
		Progress,
		ReadonlyMarkdown,
		Spinner,
		StructuredData,
		pickerRead,
		useKinds,
		virtualList,
		type CommandItem
	} from '@norbital-ai/ui';
	import type { Json } from '../../decl/values.ts';
	import type { Attachment } from '../../decl/runtime/integration.ts';
	import type { AiModel } from '../../engine/contracts.ts';
	import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
	import type { AgentRequest, ShellBolt } from '../runtime.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { LogRow } from '../../engine/contracts.ts';
	import AgentChild from './AgentChild.svelte';
	import Steps from './Steps.svelte';
	import StudioApproval from './StudioApproval.svelte';
	import StudioResult from './StudioResult.svelte';
	import MadeFiles from './MadeFiles.svelte';
	import PreviewFrame from '../preview/PreviewFrame.svelte';
	import {
		background,
		captionOf,
		checkpointSections,
		childStatus,
		contextView,
		doingOf,
		failedVerbs,
		modelDividers,
		ORB,
		orbState,
		previewsOf,
		callableWords,
		revisable,
		runState,
		stepView
	} from './view.ts';

	let {
		api,
		bolt,
		t,
		request,
		unconfigured = false,
		admin = false,
		envoys = {},
		onConversation
	}: {
		api: ShellApi;
		bolt: Pick<ShellBolt, 'observe' | 'fileUrl'>;
		t: (key: string) => string;
		request: AgentRequest;
		onClose: () => void;
		/** The host binds no AI provider: say so plainly (a send still fails with the fixed reply and an `agent.failed` event). */ unconfigured?: boolean;
		/** The viewer is an administrator: each triaged batch shows its `decision.made` events (the log refuses anyone else). */ admin?: boolean;
		/** Each envoy's display name (`ShellBoot.envoys`), for the picker's groups. */ envoys?: {
			readonly [envoy: string]: string;
		};
		/** The open conversation changed (`null`: a new one), for the shell's `?agent=`. */ onConversation?: (
			id: string | null
		) => void;
	} = $props();

	const KEY = 'bolt.agent.conversation';
	const remembered = Result.getOrElse(
		Result.try({
			try: () => sessionStorage.getItem(KEY),
			catch: (cause) => ({ _tag: 'ConversationStorageFailed' as const, cause })
		}),
		() => null
	);
	// svelte-ignore state_referenced_locally
	let conversation = $state<string | null>(
		request.conversation === undefined ? remembered : request.conversation
	);
	// the transcript loads lazily: a live window of the latest messages (`from` its first seq; null: the whole conversation),
	// and older pages read once as the reader scrolls up (`edge`: the first seq read and whether more lie before it)
	const WINDOW = 60,
		OLDER = 50;
	let live = $state<AgentRow[]>([]),
		older = $state<AgentRow[]>([]);
	/** The open conversation is an envoy's integration thread: read-only (rule 61). */
	let thread = $state(false);
	/** The open conversation is an automation's inference transcript: read-only, like a thread. */
	let automation = $state(false);
	/** The conversation's files (`sys_conversation.inputs` / `outputs`): what came in, and what its work made. */
	type ConversationFiles = NonNullable<AgentRow['files']>;
	let inputs = $state<ConversationFiles>([]);
	let outputs = $state<ConversationFiles>([]);
	let from = $state<number | null>(null),
		edge = $state<{ first: number; more: boolean } | null>(null),
		loadingOlder = $state(false);
	/**
	 * Messages this panel sent that the live transcript does not carry yet: shown at once (a bubble, or in the queue while a
	 * turn runs), each until the stored row it became arrives. A failed send leaves the outbox and returns to the composer.
	 */
	let outbox = $state<(AgentRow & { stored?: string })[]>([]);
	const rows = $derived([...older, ...live, ...outbox]);
	const before = $derived(
		from === null ? null : edge === null ? from : edge.more ? edge.first : null
	);
	/** L-BOLT-436: the message this panel just posted (working while it waits in the queue), and a send this panel saw fail. */
	let sent = $state<string | null>(null),
		sendFailed = $state(false);
	// svelte-ignore state_referenced_locally
	let draft = $state(request.prompt ?? '');
	let error = $state<string | null>(null);
	/**
	 * The composer's `/plan` (or Tab) or `/compact`, lifted out of the draft into a chip. `/compact` lasts one send; plan
	 * mode stays until it is removed or its plan executes, and a draft plan holds it (the engine plans until it runs).
	 */
	let mode = $state<'plan' | 'compact' | null>(null);
	let attached = $state<File[]>([]);
	let picker = $state<HTMLInputElement | null>(null);
	/** Browsers often report no type for these, so the extension names it (the host checks the type again). */
	const BY_EXTENSION: { readonly [ext: string]: string } = {
		heic: 'image/heic',
		heif: 'image/heif',
		pdf: 'application/pdf',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		...Object.fromEntries(
			['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'yaml', 'yml'].map((e) => [e, 'text/plain'])
		)
	};
	function attach(files: readonly File[]): void {
		const typed = files.map((f) =>
			f.type !== ''
				? f
				: new File([f], f.name, {
						type: BY_EXTENSION[f.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? ''
					})
		);
		const all = [...attached, ...typed];
		if (typed.some((f) => f.type === '' || f.size === 0))
			return void (error = t('Attach a nonempty image, PDF, DOCX, XLSX or text document.'));
		if (all.length > 8 || all.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024)
			return void (error = t('Attach at most 8 files totaling 20 MiB.'));
		error = null;
		attached = all;
	}
	function paste(event: ClipboardEvent): void {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		attach(files);
	}
	function drop(event: DragEvent): void {
		event.preventDefault();
		attach([...(event.dataTransfer?.files ?? [])]);
	}
	async function createFile(): Promise<void> {
		if (draft.trim() === '') draft = `${t('Create a file')}: `;
		if (railEl !== null && getComputedStyle(railEl).position === 'absolute') rail = false;
		await tick();
		const composer = picker?.form?.querySelector('textarea');
		composer?.focus();
		composer?.setSelectionRange(composer.value.length, composer.value.length);
	}

	/** The member's own conversations and the envoy conversation threads they may read (the selector, and the open one's status, plan, goals and model): a live read. */
	let list = $state<AgentConversation[]>([]);
	let models = $state<AiModel[]>([]);
	/** The model a new conversation runs when none is picked (the host's default). */
	let modelDefault = $state<string | null>(null);
	/** The model a new conversation starts on; an open one's is its own. */
	let picked = $state<string | null>(null);
	/** The MCP servers this member's policies name: the session rail's Connectors. */
	let connectors = $state<readonly { name: string; description: string }[]>([]);
	/** The session rail is open. */
	let rail = $state(false);
	let railEl = $state<HTMLElement | null>(null);
	let railToggle = $state<HTMLButtonElement | null>(null);
	let chatEl = $state<HTMLDivElement | null>(null);
	let panelRemWidth = $state(0);
	let navigating = $state(false);
	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	function sessionMotion(node: HTMLElement, options: { x: number; duration: number }) {
		return fly(node, {
			...options,
			duration: reducedMotion.current || typeof node.animate !== 'function' ? 0 : options.duration,
			easing: cubicOut
		});
	}
	function measureSession(node: HTMLDivElement): () => void {
		const measure = () => {
			panelRemWidth =
				node.getBoundingClientRect().width /
				parseFloat(getComputedStyle(node.ownerDocument.documentElement).fontSize);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}
	async function openRail(): Promise<void> {
		navigating = false;
		focus = null;
		previewing = false;
		rail = true;
		await tick();
		railEl?.querySelector<HTMLButtonElement>('[data-rail-close]')?.focus({ preventScroll: true });
	}
	function closeRail(): void {
		rail = false;
		railToggle?.focus({ preventScroll: true });
	}
	async function openChild(id: string): Promise<void> {
		navigating = true;
		focus = id;
		await tick();
		railEl?.querySelector<HTMLButtonElement>('[data-rail-back]')?.focus({ preventScroll: true });
	}
	async function backToChildren(): Promise<void> {
		navigating = true;
		const id = focus;
		focus = null;
		await tick();
		const child = [...(railEl?.querySelectorAll<HTMLElement>('[data-subagent]') ?? [])].find(
			(row) => row.dataset['subagent'] === id
		);
		child?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
	}
	function railKeydown(event: KeyboardEvent): void {
		if (!rail || event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
		const target = event.target;
		if (
			!(target instanceof Node) ||
			(!railEl?.contains(target) && !chatEl?.contains(target) && !railToggle?.contains(target))
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		closeRail();
	}
	/** The sub-agent open in the session rail. */
	let focus = $state<string | null>(null);
	const current = $derived(list.find((c) => c.id === conversation));
	const status = $derived(current?.status ?? 'idle');
	/** An instance or envoy name in words: `field_ops` → `Field ops`. */
	const human = (s: string) => s.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
	/**
	 * Where a conversation happens, the picker's group: the member's own in-app conversations (Web UI), then each envoy's
	 * direct messages, then each envoy group chat by its name. `order` keeps Web UI first and an envoy's DMs before its groups.
	 */
	function sourceOf(c: AgentConversation): { order: number; label: string } {
		// an automation's inferences, after every conversation a person has
		if (c.run != null) return { order: 3, label: t('Automations') };
		if (c.integration === null) return { order: 0, label: t('Web UI') };
		const name = envoys[c.envoy ?? ''] ?? human(c.envoy ?? c.integration);
		return c.kind === 'group'
			? { order: 2, label: `${name} (${t('Group')}: ${c.title ?? c.thread ?? ''})` }
			: { order: 1, label: `${name} (DM)` };
	}
	/** A conversation's own line: its title, else a DM's peer (the provider's address) or the group's thread. */
	const nameOf = (c: AgentConversation) =>
		c.title ??
		(c.integration === null || c.thread === null
			? t('Conversation')
			: c.peer === null
				? formatHandle(null, c.thread)
				: `${c.peer} (${formatHandle(null, c.thread)})`);
	// svelte-ignore state_referenced_locally
	const conversations = liveEdge(() =>
		bolt.observe<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] } })
	);
	watch(
		() => $conversations,
		(value) => {
			list = value === undefined ? [] : [...value.rows];
		}
	);
	let actions: FiberSet.FiberSet<void, never> | null = null;
	const action = <E extends { readonly message: string }>(work: Effect.Effect<void, E>) =>
		work.pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					error = cause.message;
				})
			)
		);
	function dispatch<E extends { readonly message: string }>(work: Effect.Effect<void, E>): void {
		if (actions !== null) fork(FiberSet.run(actions, action(work)));
	}
	const lifetime = attachEffect(() =>
		Effect.gen(function* () {
			const owned = yield* FiberSet.make<void, never>();
			actions = owned;
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					if (actions === owned) actions = null;
				})
			);
			yield* FiberSet.run(
				owned,
				action(
					Effect.suspend(() => api.agent.models()).pipe(
						Effect.tap((answer) =>
							Effect.sync(() => {
								models = [...answer.models];
								modelDefault = answer.default;
								connectors = answer.mcp;
							})
						),
						Effect.asVoid
					)
				)
			);
			yield* Effect.never;
		})
	);
	const refused = (
		answer: Result.Result<
			Effect.Success<ReturnType<ShellApi['agent']['stop']>>,
			Effect.Error<ReturnType<ShellApi['agent']['stop']>>
		>
	) =>
		answer._tag === 'Failure'
			? answer.failure.message
			: answer.success.kind === 'refused'
				? answer.success.message
				: null;
	const transcript = liveEdge(() =>
		conversation === null
			? null
			: bolt.observe<{
					rows: AgentRow[];
					from?: number;
					thread?: true;
					automation?: true;
					inputs?: ConversationFiles;
					outputs?: ConversationFiles;
				}>({
					read: { m: 'transcript', a: [conversation, { tail: WINDOW }] }
				})
	);
	watch(
		() => conversation,
		(id) => {
			onConversation?.(id);
			thread = false;
			automation = false;
		}
	);
	watch(
		() => [$transcript, transcript.error] as const,
		([value, cause]) => {
			if (cause?._tag === 'ReadFailed' && cause.code === 'notFound') return fresh();
			if (value === undefined) return;
			live = [...value.rows];
			from = value.from ?? null;
			thread = value.thread === true;
			automation = value.automation === true;
			inputs = value.inputs ?? [];
			outputs = value.outputs ?? [];
			if (
				outbox.some(
					(item) => item.stored !== undefined && value.rows.some((row) => row.id === item.stored)
				)
			)
				outbox = outbox.filter(
					(item) => item.stored === undefined || !value.rows.some((row) => row.id === item.stored)
				);
		}
	);
	// the shell's `?agent=` moved (back, forward, a link) while the panel is open
	watch(
		() => request.conversation,
		(id) => {
			if (id !== undefined && id !== conversation) {
				if (id === null) fresh();
				else select(id);
			}
		},
		{ lazy: true }
	);

	function send(event: SubmitEvent | KeyboardEvent, now = false): void {
		event.preventDefault();
		const text = draft.trim() || (mode === 'compact' ? '/compact' : '');
		if (text === '' && attached.length === 0) return;
		error = null;
		pinned = true;
		if (revising !== null) {
			// a queued message is edited in place; a delivered one is superseded by the revision (sys_message.revise)
			const id = revising.id;
			dispatch(
				Effect.result(api.agent.revise(id, text)).pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							error = refused(answer);
							if (error === null) {
								draft = '';
								revising = null;
							}
						})
					),
					Effect.asVoid
				)
			);
			return;
		}
		const about =
			request.about === undefined
				? ''
				: `(${t('About')} ${request.about.collection}/${request.about.id}) `;
		const files = attached,
			sentMode = mode === 'compact' ? 'compact' : planning ? 'plan' : undefined;
		// on screen before any round trip: the conversation's creation and the post follow behind it
		const local = `local:${crypto.randomUUID()}`;
		outbox.push({
			id: local,
			seq: Number.MAX_SAFE_INTEGER,
			role: 'user',
			text: about + text,
			state: status === 'running' ? 'queued' : null,
			tag: null,
			files: files.map((f) => ({ name: f.name, mime: f.type }))
		});
		draft = '';
		attached = [];
		if (mode === 'compact') mode = null;
		const failed = (message: string) => {
			outbox = outbox.filter((o) => o.id !== local);
			draft = text;
			attached = files;
			error = message;
		};
		const existing = conversation,
			model = picked;
		dispatch(
			Effect.gen(function* () {
				let id = existing;
				if (id === null) {
					const started = yield* Effect.result(
						api.agent.start(
							(text.split('\n')[0] ?? '').slice(0, 80) || undefined,
							model ?? undefined
						)
					);
					if (started._tag === 'Failure' || started.success.kind !== 'committed')
						return yield* Effect.sync(() =>
							failed(
								started._tag === 'Failure'
									? started.failure.message
									: started.success.kind === 'refused'
										? started.success.message
										: t('The request failed.')
							)
						);
					const decoded = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String }))(
						started.success.output
					);
					if (decoded._tag === 'Failure')
						return yield* Effect.sync(() => failed(t('The request failed.')));
					id = decoded.success.id;
					const startedId = id;
					yield* Effect.try({
						try: () => sessionStorage.setItem(KEY, startedId),
						catch: (cause) => ({ _tag: 'ConversationStorageFailed' as const, cause })
					}).pipe(Effect.ignore);
					yield* Effect.sync(() => {
						conversation = startedId;
						picked = null;
					});
				}
				const refs: Attachment[] = [];
				for (const file of files) {
					const uploaded = yield* Effect.result(api.agent.upload(file));
					if (uploaded._tag === 'Failure')
						return yield* Effect.sync(() => failed(`${file.name}: ${uploaded.failure.message}`));
					refs.push(uploaded.success);
				}
				const answer = yield* Effect.result(api.agent.post(id, about + text, now, refs, sentMode));
				yield* Effect.sync(() => {
					sendFailed = answer._tag === 'Failure' || answer.success.kind === 'refused';
					if (answer._tag === 'Failure') return failed(answer.failure.message);
					if (answer.success.kind === 'refused') return failed(answer.success.message);
					const output = answer.success.kind === 'committed' ? answer.success.output : null;
					const posted = Predicate.isObject(output) ? output['id'] : undefined;
					sent = typeof posted === 'string' ? posted : null;
					const stored = sent;
					// the stored row may already be here (the live patch can beat the post's answer)
					outbox =
						stored === null || stored === '' || live.some((row) => row.id === stored)
							? outbox.filter((item) => item.id !== local)
							: outbox.map((item) => (item.id === local ? { ...item, stored } : item));
				});
			})
		);
	}
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
	const empty = $derived(draft.trim() === '' && attached.length === 0);
	const lastPending = $derived(rows.findLast((r) => r.state === 'pending')?.id);
	const lastReply = $derived(rows.findLastIndex((r) => r.role === 'assistant'));
	/** A triaged row's state (rule 60a), derived from the engine's markers and the turn's status; no label once it settles. */
	function triageLabel(row: AgentRow, i: number): string | null {
		if (row.state === 'pending') return t('waiting for more…');
		return status === 'running' && row.state === 'consumed' && i > lastReply
			? t('responding')
			: null;
	}
	function respondNow(): void {
		if (conversation === null) return;
		dispatch(
			Effect.result(api.agent.respondNow(conversation)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
					})
				),
				Effect.asVoid
			)
		);
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
			if (!planLocked) mode = mode === 'plan' ? null : 'plan';
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		send(event, event.metaKey || event.ctrlKey);
	}
	function fresh(): void {
		conversation = null;
		live = [];
		older = [];
		from = null;
		edge = null;
		outbox = [];
		sent = null;
		sendFailed = false;
		revising = null;
		mode = null;
		pinned = true;
		log = [];
		expanded.clear();
		Result.getOrElse(
			Result.try(() => sessionStorage.removeItem(KEY)),
			() => undefined
		);
	}
	function select(id: string): void {
		if (id === conversation) return;
		fresh();
		conversation = id;
		dispatch(
			Effect.try({
				try: () => sessionStorage.setItem(KEY, id),
				catch: (cause) => ({ _tag: 'ConversationStorageFailed' as const, cause })
			}).pipe(Effect.ignore)
		);
	}
	const when = (at: string) =>
		new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	/** Every conversation, grouped by where it happens (a group heading starts where its label changes), latest first within. */
	const options = $derived(
		list
			.map((c, i) => ({ c, i, s: sourceOf(c) }))
			.sort((a, b) => a.s.order - b.s.order || a.s.label.localeCompare(b.s.label) || a.i - b.i)
			.map(({ c, s }) => ({
				value: c.id,
				label: nameOf(c),
				// the picker says which run is live, stopped, or idle; a failed turn is its transcript's last row
				description: `${when(c.at)} · ${c.status === 'running' ? t('Running') : c.status === 'stopped' ? t('Stopped') : t('Idle')}`,
				group: s.label
			}))
	);
	/**
	 * The open conversation's `decision.made` events, newest first (the log is an administrator's): its tail is read whenever
	 * the transcript moves, and every 2 s while a message waits on triage (a `wait` decision moves no row).
	 */
	let log = $state<LogRow[]>([]);
	/** The decisions a reader opened, by event. */
	const expanded = new SvelteSet<string>();
	const decisions = liveEdge(() => {
		const frame = $transcript;
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
	/** One `decision.made` event's attributes as the decision matrix reads them (`decisionEvent`); a missing answer is a dash. */
	const DecisionAnswer = Schema.Struct({
		type: Schema.optionalKey(Schema.String),
		choice: Schema.optionalKey(Schema.String),
		score: Schema.optionalKey(Schema.Number),
		noul: Schema.optionalKey(Schema.Number),
		confidence: Schema.optionalKey(Schema.Number)
	});
	type DecisionAnswer = typeof DecisionAnswer.Type;
	const Said = Schema.Struct({
		from: Schema.optionalKey(Schema.String),
		text: Schema.optionalKey(Schema.String)
	});
	const DecisionAttributes = Schema.Struct({
		use: Schema.optionalKey(Schema.String),
		action: Schema.optionalKey(Schema.String),
		error: Schema.optionalKey(Schema.String),
		questions: Schema.optionalKey(Schema.Array(Schema.String)),
		answers: Schema.optionalKey(Schema.Record(Schema.String, DecisionAnswer)),
		verdicts: Schema.optionalKey(Schema.Array(Schema.String)),
		state: Schema.optionalKey(
			Schema.Struct({
				directive: Schema.optionalKey(Schema.String),
				assistant: Schema.optionalKey(Schema.String),
				pending: Schema.optionalKey(
					Schema.Array(Schema.Struct({ ...Said.fields, id: Schema.optionalKey(Schema.String) }))
				),
				earlier: Schema.optionalKey(Schema.Array(Said))
			})
		)
	});
	type DecisionAttributes = typeof DecisionAttributes.Type;
	const NO_DECISION: DecisionAttributes = {};
	/** An event that is no decision the matrix can read shows as an empty one. */
	const decisionOf = (a: Json): DecisionAttributes =>
		Option.getOrElse(Schema.decodeUnknownOption(DecisionAttributes)(a), () => NO_DECISION);
	const answerOf = (a: DecisionAnswer | undefined) =>
		a === undefined
			? '—'
			: a.type === 'choice'
				? String(a.choice ?? '—')
				: a.type === 'score'
					? `${a.score ?? 0} (${a.confidence ?? 0})`
					: a.type === 'noul'
						? String(a.noul ?? 0)
						: '—';
	// the host's models by human label, grouped by provider; a conversation on a class (`default`) shows the host's default
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
	const chosenModel = $derived.by(() => {
		const id = current?.model ?? picked ?? modelDefault;
		return models.some((m) => m.id === id)
			? id
			: models.some((m) => m.id === modelDefault)
				? modelDefault
				: null;
	});
	const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id;
	function pickModel(model: string | null): void {
		if (model === null) return;
		if (conversation === null) return void (picked = model);
		dispatch(
			Effect.result(api.agent.setModel(conversation, model)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
					})
				),
				Effect.asVoid
			)
		);
	}

	// stop and resume (a stop cancels what was queued; resume recalls the stopped work): this conversation's, or a sub-agent's
	function control(stop: boolean, id = conversation, onRefused?: () => void): void {
		if (id === null) return;
		dispatch(
			Effect.result(stop ? api.agent.stop(id) : api.agent.resume(id)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
						if (error !== null) onRefused?.();
					})
				),
				Effect.asVoid
			)
		);
	}
	const childControl = (id: string, stop: boolean, onRefused: () => void) =>
		control(stop, id, onRefused);
	/** Execute starts the draft (plan mode ends with it); delete drops the plan. */
	function plan(execute: boolean): void {
		if (conversation === null) return;
		starting = execute;
		dispatch(
			Effect.result(
				execute ? api.agent.executePlan(conversation) : api.agent.discardPlan(conversation)
			).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
						if (error === null) mode = null;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						starting = false;
					})
				),
				Effect.asVoid
			)
		);
	}
	let starting = $state(false),
		draftOpen = $state(false);
	/** Staging asks before a stop, and before deleting a plan that is running. */
	let confirming = $state<'stop' | 'plan' | null>(null);
	const drafting = $derived(current?.plan?.status === 'draft');
	const planLocked = $derived(drafting);
	const planning = $derived(mode === 'plan' || drafting);
	const planState = (p: NonNullable<AgentConversation['plan']>) =>
		p.status === 'draft' ? t('Planning') : p.status === 'active' ? t('Executing') : t('Verified');
	const planTitle = (body: string) =>
		(
			body.split('\n').find((l) => /^#{1,3}\s+\S/.test(l.trim())) ??
			body.split('\n').find((l) => l.trim() !== '') ??
			''
		)
			.replace(/^#+\s*/, '')
			.trim();

	// the queue: messages posted while a turn runs wait here until its next step takes them
	const queued = $derived(
		rows.filter((r) => r.role === 'user' && r.state === 'queued' && r.report === undefined)
	);
	let revising = $state<AgentRow | null>(null);
	function revise(row: AgentRow): void {
		revising = row;
		draft = row.text ?? '';
		mode = null;
	}
	function dequeue(row: AgentRow): void {
		dispatch(
			Effect.result(api.agent.dequeue(row.id)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
						if (revising?.id === row.id) {
							revising = null;
							draft = '';
						}
					})
				),
				Effect.asVoid
			)
		);
	}
	function moveUp(i: number): void {
		if (conversation === null) return;
		const ids = queued.map((r) => r.id);
		const previous = ids[i - 1],
			selected = ids[i];
		if (previous === undefined || selected === undefined) return;
		[ids[i - 1], ids[i]] = [selected, previous];
		dispatch(
			Effect.result(api.agent.reorder(conversation, ids)).pipe(
				Effect.tap((answer) =>
					Effect.sync(() => {
						error = refused(answer);
					})
				),
				Effect.asVoid
			)
		);
	}

	// the context meter: the last reply's context against its model's window, and what the conversation's turns cost
	const usages = $derived(rows.flatMap((r) => (r.usage === undefined ? [] : [r.usage])));
	const meter = $derived.by(() => {
		const last = usages.findLast((u) => u.context !== undefined && u.window !== undefined);
		const costs = usages.filter((u) => typeof u.cost === 'number');
		return {
			percent:
				last?.context === undefined || last.window === undefined || last.window === 0
					? null
					: Math.min(100, (last.context / last.window) * 100),
			context: last?.context,
			window: last?.window,
			input: usages.reduce((n, u) => n + u.input, 0),
			output: usages.reduce((n, u) => n + u.output, 0),
			cost: costs.length === 0 ? null : costs.reduce((n, u) => n + (u.cost ?? 0), 0)
		};
	});
	const k = (n: number | undefined) =>
		n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	const usd = (n: number) =>
		new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 4
		}).format(n);

	// the context view (L-BOLT-546): what the model no longer reads stays in the transcript, folded and dimmed
	const view = $derived(contextView(rows, current?.plan));
	const outside = (r: AgentRow) => view.outside.has(r.id);
	/** The executed plan the agent works from: the strip above the transcript. */
	const settled = $derived(
		current?.plan != null && current.plan.status !== 'draft' ? current.plan : null
	);
	const ORIGIN = {
		manual: 'you asked for it',
		requested: 'the assistant asked for it',
		automatic: 'the context was full'
	} as const;
	const dividers = $derived(modelDividers(rows));
	// a posted message is working while it waits in the queue for a turn (then the status says so); a triaged one awaiting
	// its decision is waiting, and a cancelled one (a stop) is gone
	const posted = $derived(sent === null ? undefined : rows.find((r) => r.id === sent));
	const orb = $derived(
		orbState({ status, rows, pending: posted?.state === 'queued', failed: sendFailed })
	);
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
			const timer = setInterval(() => (now = Date.now()), 1_000);
			return () => clearInterval(timer);
		}
	);
	const thinking = $derived(since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000)));

	// the transcript follows its tail while the reader is there; a scroll up (only the reader scrolls up) pauses it and
	// "Jump to latest" returns; reaching the tail again resumes it
	let port = $state<HTMLOListElement | null>(null);
	let pinned = $state(true);
	let lastTop = 0;
	const atTail = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 32;
	/** The page of messages before the loaded ones, prepended with the reader's place kept. */
	class AgentPanelFailed extends Schema.TaggedError<AgentPanelFailed>()('AgentPanelFailed', {
		message: Schema.String,
		cause: Schema.Defect()
	}) {}
	function loadOlder(): void {
		const id = conversation,
			at = before;
		if (loadingOlder || id === null || at === null) return;
		loadingOlder = true;
		dispatch(
			Effect.gen(function* () {
				const answer = yield* Effect.result(api.agent.older(id, at, OLDER));
				const shown = yield* Effect.sync(() => {
					loadingOlder = false;
					if (answer._tag === 'Failure' || id !== conversation || port === null) return null;
					const own = port,
						fromBottom = own.scrollHeight - own.scrollTop;
					older = [...answer.success.rows, ...older];
					edge = { first: answer.success.first, more: answer.success.more };
					return { own, fromBottom };
				});
				if (shown === null) return;
				yield* Effect.tryPromise({
					try: () => tick(),
					catch: (cause) =>
						new AgentPanelFailed({ message: t('The transcript could not be rendered.'), cause })
				});
				yield* Effect.sync(() => {
					if (id === conversation && port === shown.own)
						shown.own.scrollTop = shown.own.scrollHeight - shown.fromBottom;
				});
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						loadingOlder = false;
					})
				)
			)
		);
	}
	function scrolled(): void {
		if (port === null) return;
		if (port.scrollTop < 240) loadOlder();
		if (port.scrollTop < lastTop - 2) pinned = false;
		else if (atTail(port)) pinned = true;
		lastTop = port.scrollTop;
	}
	function latest(smooth = true): void {
		pinned = true;
		port?.scrollTo({
			top: port.scrollHeight,
			behavior:
				smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto'
		});
	}
	watch(
		() => [rows, status],
		() => {
			void tick().then(() => {
				if (pinned) latest();
			});
		}
	);
	/** A row shown on its own: a person's message, a confirmation card, a reply's text, a checkpoint or a verdict. */
	const shown = (r: AgentRow) =>
		// a bare `/compact` is the checkpoint's own line, not a message
		(r.role === 'user' &&
			r.report === undefined &&
			r.text !== '/compact' &&
			(r.state !== 'queued' || thread) &&
			(!!r.text || (r.files?.length ?? 0) > 0)) ||
		((r.state === 'confirm' || r.state === 'approved') && r.call !== undefined) ||
		(r.role === 'assistant' && !!r.text) ||
		(r.role === 'system' && (r.tag === 'compact' || r.tag === 'verdict') && !!r.text);
	// The work between chat messages folds into one group: tool calls, received sub-agent messages and reasoning
	// (a reply's own reasoning ahead of its text). A person's message, a reply's text or a card ends the group.
	// Spawning a sub-agent is a step; its detached work lives in the session rail. Rows behind the context boundary
	// stay dimmed (L-BOLT-546).
	// For an administrator, each triaged batch closes with its decision: the newest `decision.made` naming a message decides
	// it, and the mark follows the batch's last message; `awaiting` is a decided reply not written yet.
	type Decided = { event: LogRow; d: DecisionAttributes };
	// Messages not for the agent (triage's `ignore`, or chatter) fold into one quiet block that carries its decision, so the
	// transcript stays message → work → reply, turn by turn.
	type Item =
		| { row: AgentRow; index: number }
		| { steps: AgentRow[] }
		| { decision: Decided; awaiting: boolean }
		| { ignored: AgentRow[]; decision?: Decided };
	const decided = $derived.by(() => {
		const by = new Map<string, Decided>();
		for (const event of log) {
			const d = decisionOf(event.attributes);
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
			// a member's own conversation answers every message: only a channel thread shows its triage marks
			if (!thread && x.d.action === 'respond') return out;
			if (block !== undefined && 'ignored' in block && x.d.action !== 'respond') block.decision = x;
			else out.push({ decision: x, awaiting: x.d.action === 'respond' && index > replied });
			return out;
		}, []);
	});
	// a long conversation windows its items (measured, keyed by their first row) inside the transcript's scroll port
	const itemKey = (i: number) => {
		const it = items[i]!;
		return 'row' in it
			? it.row.id
			: 'steps' in it
				? `steps:${it.steps[0]!.id}`
				: 'ignored' in it
					? `ignored:${it.ignored[0]!.id}`
					: `decision:${it.decision.event.id}`;
	};
	const turns = virtualList({ count: () => items.length, key: itemKey, estimate: 56 });
	/** A step still being written: a running call, or reasoning whose reply is still streaming. */
	const active = (s: AgentRow) => s.tool?.running === true || s.state === 'streaming';
	/** The group's wall time: its first step's start to its last step's end (a call's `ms`), whole seconds. */
	function worked(steps: readonly AgentRow[]): number | null {
		const first = steps[0]?.at,
			last = steps.at(-1)!;
		if (first === undefined || last.at === undefined) return null;
		return Math.max(
			1,
			Math.round((Date.parse(last.at) + (last.tool?.ms ?? 0) - Date.parse(first)) / 1000)
		);
	}
	// the session rail: what this conversation changed, and the work it left running (its sub-agents and automation runs)
	const changes = $derived(rows.flatMap((r) => r.receipts ?? []));
	const tasks = $derived(background(rows));
	const children = $derived(tasks.filter((task) => task.kind === 'agent'));
	const childStates = new SvelteMap<string, ReturnType<typeof childStatus> | null>();
	let showCompleted = $state(false);
	const childrenLoading = $derived(children.every((child) => childStates.get(child.id) == null));
	const workingChildren = $derived(
		children.filter((child) => childStates.get(child.id) === 'running')
	);
	const doneChildren = $derived(children.filter((child) => childStates.get(child.id) === 'done'));
	// Keyed rows move into the completed group without restarting their live reads.
	const orderedChildren = $derived([
		...children.filter((child) => childStates.get(child.id) !== 'done'),
		...doneChildren
	]);
	function childState(id: string, state: ReturnType<typeof childStatus> | null): void {
		const focused = railEl?.ownerDocument.activeElement;
		const foldingFocused =
			state === 'done' &&
			!showCompleted &&
			focused?.closest('[data-subagent]')?.getAttribute('data-subagent') === id;
		childStates.set(id, state);
		if (foldingFocused)
			void tick().then(() =>
				railEl?.querySelector<HTMLButtonElement>('[data-subagent-completed-toggle]')?.focus()
			);
	}
	watch(
		() => conversation,
		() => {
			showCompleted = false;
			childStates.clear();
		}
	);
	/** The runs' ids as one value, so a transcript patch that starts no run does not restart their read. */
	const runIds = $derived(
		tasks
			.filter((w) => w.kind === 'run')
			.map((w) => w.id)
			.join(' ')
	);
	/** Each run's status, re-read every few seconds while the rail shows them (as Settings → Automations does). */
	const runs = liveEdge(() =>
		!rail || runIds === ''
			? null
			: Stream.fromEffectSchedule(
					Effect.forEach(runIds.split(' '), (id) => Effect.option(api.run(id)), {
						concurrency: 4
					}).pipe(
						Effect.map(
							(views) =>
								new Map(views.flatMap((v) => (Option.isSome(v) ? [[v.value.id, v.value]] : [])))
						)
					),
					Schedule.spaced('3 seconds')
				)
	);
	const stopRun = (id: string) => dispatch(api.stopRun(id).pipe(Effect.asVoid));
	// a turn under way that has written nothing yet: "Thinking…" with its seconds
	const quiet = $derived(
		status === 'running' && !rows.some((r) => r.state === 'streaming' || r.state === 'running')
	);
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
	// `/` commands (only as the draft's first character) and `@` mentions: a collection, then one of its records
	const commands = $derived<readonly CommandItem[]>([
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
	const kinds = useKinds();
	/** A stored file's link (a made file's card, a workspace screenshot). */
	const fileHref = (id: string) => bolt.fileUrl({ id });
	// the previewer: the latest bundle built (or chosen by the agent with `preview_show`), in the session rail's Preview
	// section; the header's Preview button is the one way to open it (a dot while it shows a bundle not yet seen), and its
	// frame mounts only while open
	let previewing = $state(false),
		seenPreview = $state<string | null>(null);
	const shownPreview = $derived(previewsOf(rows).at(-1) ?? null);
	const previewInRail = $derived(previewing && shownPreview !== null && !thread);
	const showingPreview = $derived(rail && previewInRail);
	// The host is usually a 40rem sheet; keep the transcript intact beneath its session view.
	const railOverlay = $derived(panelRemWidth < (previewInRail ? 88 : 64));
	watch(
		() => (showingPreview ? (shownPreview?.key ?? null) : null),
		(key) => {
			if (key !== null) seenPreview = key;
		}
	);
	function togglePreview(): void {
		if (showingPreview) return void (previewing = false);
		previewing = true;
		focus = null;
		rail = true;
	}
	function mentions(q: string): Effect.Effect<CommandItem[], Error> {
		return Effect.suspend(() => {
			const slash = q.indexOf('/');
			if (slash === -1)
				return Effect.succeed(
					Object.keys(kinds.catalog ?? {})
						.filter((c) => !c.startsWith('sys_') && c.toLowerCase().includes(q.toLowerCase()))
						.slice(0, 20)
						.map((c) => ({
							id: c,
							label: c.replace(/_/g, ' '),
							icon: 'lucide:database',
							group: t('Collections'),
							insert: `@${c}/`,
							keep: true as const
						}))
				);
			const c = q.slice(0, slash),
				target = kinds.catalog?.[c];
			if (target === undefined || kinds.query === undefined) return Effect.succeed([]);
			return kinds
				.query(c, pickerRead(target, target.label, { limit: 8 }, q.slice(slash + 1)))
				.pipe(
					Effect.map((page) =>
						page.rows.map((r) => {
							const label =
								target.label
									.map((f) => r[f])
									.filter((x) => x !== null && x !== undefined && x !== '')
									.join(' · ') || String(r['id']);
							return {
								id: String(r['id']),
								label,
								group: c.replace(/_/g, ' '),
								insert: `[@${label}](${c}/${r.id}) `
							};
						})
					)
				);
		});
	}
	// hook:view-ui — inside the shell's sheet the panel's header is the sheet's (one header: mark, title, conversations); the
	// sheet adds full screen and close, and its left edge resizes it
	const toSheet = getContext<((s: Snippet | null) => void) | undefined>(
		Symbol.for('ui.sheet.header')
	);
	watch(
		() => toSheet,
		(sheet) => {
			if (sheet === undefined) return;
			sheet(head);
			return () => sheet(null);
		}
	);
	const receiptsOf = (row: AgentRow) => row.receipts ?? [];
</script>

{#snippet decisionToggle({ event, d }: Decided, cls: string)}
	{@const open = expanded.has(event.id)}
	<button
		type="button"
		data-decision-toggle
		aria-expanded={open}
		aria-label={t('Decision')}
		title={when(event.at)}
		class="{cls} flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {d.error ===
		undefined
			? ''
			: 'text-destructive'}"
		onclick={() => (open ? expanded.delete(event.id) : expanded.add(event.id))}
	>
		<Icon name="lucide:scale" class="size-3.5" /><span>{t(d.action ?? 'decided')}</span>
	</button>
{/snippet}
{#snippet matrix({ event, d }: Decided)}
	<div class="mt-2 rounded-md border border-border/70 bg-muted/20 p-2 text-xs" data-decision-matrix>
		<table class="w-full">
			<thead
				><tr class="text-left text-muted-foreground"
					><th class="pb-1 pr-2 font-medium">{t('Message')}</th><th class="pb-1 pr-2 font-medium"
						>{t('Answer')}</th
					><th class="pb-1 font-medium">{t('Verdict')}</th></tr
				></thead
			>
			<tbody>
				{#each d.state?.pending ?? [] as p, i (i)}
					<tr class="border-t border-border/60 align-top" data-decision-row={`m${i}`}>
						<td class="py-1 pr-2 whitespace-pre-wrap"
							><span class="text-muted-foreground">{p.from ?? ''}:</span> {p.text ?? ''}</td
						>
						<td class="py-1 pr-2 tabular-nums">{answerOf(d.answers?.[`m${i}`])}</td>
						<td class="py-1">{d.verdicts?.[i] ?? '—'}</td>
					</tr>
				{/each}
				<tr class="border-t border-border/60" data-decision-row="wait">
					<td class="py-1 pr-2 text-muted-foreground">{t('Wait')}</td><td
						class="py-1 pr-2 tabular-nums">{answerOf(d.answers?.['wait'])}</td
					><td class="py-1">{d.action ?? '—'}</td>
				</tr>
			</tbody>
		</table>
		{#if d.error !== undefined}<p class="mt-1 text-destructive">{t('failed')}: {d.error}</p>{/if}
		{#if d.state !== undefined}
			<details class="mt-1 text-muted-foreground" data-decision-context>
				<summary class="cursor-pointer">{t('Context')} · {when(event.at)}</summary>
				<p class="mt-1">
					<span class="font-medium">{t('Directive')}</span>: {d.state.directive ?? ''}
				</p>
				<p><span class="font-medium">{t('Assistant')}</span>: {d.state.assistant ?? ''}</p>
				{#each d.state.earlier ?? [] as p, i (i)}<p class="whitespace-pre-wrap opacity-80">
						<span>{p.from ?? ''}:</span>
						{p.text ?? ''}
					</p>{/each}
			</details>
		{/if}
	</div>
{/snippet}
{#snippet attachments(row: AgentRow)}{#each row.files ?? [] as f, i (i)}{@const href =
			f.id === undefined ? null : fileHref(f.id)}<span
			class="mt-1 block text-xs text-muted-foreground"
			data-attachment
		>
			{#if href !== null && f.mime.startsWith('image/')}<Image
					src={`${href}?preview=512`}
					alt={f.name}
					class="mb-1 min-h-16 max-w-full rounded"
					imageClass="max-h-32 object-contain"
				/>{/if}{t('Attached')}: {#if href !== null}<a
					{href}
					target="_blank"
					rel="noreferrer"
					class="underline">{f.name}</a
				>{:else}{f.name}{/if}</span
		>{/each}{/snippet}
{#snippet head()}
	<!-- Panel header: the mark, the name, the conversation picker as plain text, then new (the sheet adds full screen and close) -->
	<Inline gap="sm" class="w-full min-w-0" data-agent-head>
		<!-- the mark says the conversation's state; while a turn runs it is the accretion disc. In the shell's sheet the slot is
		     the header's leading action on a phone, so the name starts where the top bar's title does -->
		<span class="grid shrink-0 place-items-center {toSheet === undefined ? '' : 'max-md:size-11'}">
			{#if orb === 'working'}<AccretionDisc
					size={20}
					label={t(ORB.working.label)}
					class="text-muted-foreground"
				/>
			{:else}<span class="shrink-0" title={t(ORB[orb].label)} data-orb={orb}
					><NorbiusStrip
						state={orb === 'failed' ? 'error' : orb}
						size={18}
						label={t(ORB[orb].label)}
					/></span
				>{/if}
		</span>
		<span class="shrink-0 text-sm font-semibold">{t('Norbius')}</span>
		<Combobox
			variant="ghost"
			searchable
			class="min-w-0 flex-1"
			{options}
			value={conversation}
			{...current === undefined ? {} : { display: nameOf(current) }}
			placeholder={list.length === 0 ? t('No conversations yet') : t('New conversation')}
			aria-label={t('Conversations')}
			onChange={(id) => (id === null ? fresh() : select(id))}
		/>
		{#if shownPreview !== null && !thread}<Button
				size="icon-sm"
				variant="ghost"
				class="relative shrink-0"
				aria-label={t(shownPreview.key === seenPreview ? 'Preview' : 'New preview')}
				title={t(shownPreview.key === seenPreview ? 'Preview' : 'New preview')}
				aria-pressed={showingPreview}
				onclick={togglePreview}
				data-open-preview
				><Icon name="lucide:eye" class="size-4" />{#if shownPreview.key !== seenPreview}<span
						class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
						data-preview-unseen
					></span>{/if}</Button
			>{/if}
		<Button
			bind:ref={railToggle}
			size="icon-sm"
			variant="ghost"
			class="shrink-0"
			aria-label={t('Session')}
			title={t('Session')}
			aria-pressed={rail}
			onclick={() => (rail ? closeRail() : openRail())}
			data-rail-toggle><Icon name="lucide:sliders-horizontal" class="size-4" /></Button
		>
		<Button
			size="icon-sm"
			variant="ghost"
			class="shrink-0"
			aria-label={t('New conversation')}
			title={t('New conversation')}
			onclick={fresh}><Icon name="lucide:plus" class="size-4" /></Button
		>
	</Inline>
{/snippet}

{#snippet card(title: string, aside: string, body: Snippet, extra?: Snippet)}
	<details class="group/card min-w-0">
		<summary
			class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
		>
			<span>{title}</span>
			<Icon
				name="lucide:chevron-right"
				class="size-3.5 transition-transform duration-150 group-open/card:rotate-90 motion-reduce:transition-none"
			/>
			<span class="flex-1"></span>
			{#if aside !== ''}<span class="shrink-0 text-xs tabular-nums">{aside}</span>{/if}
			{@render extra?.()}
		</summary>
		<div class="pt-1 pb-4 text-xs leading-5">{@render body()}</div>
	</details>
{/snippet}

{#snippet session()}
	<!-- One session frame: files and helpers stay visible; secondary session metadata opens in place. -->
	<aside
		bind:this={railEl}
		transition:sessionMotion={{ x: 6, duration: 160 }}
		inert={!rail}
		class="absolute inset-y-0 right-0 z-30 flex w-full shrink-0 {previewInRail
			? '@min-[88rem]:relative @min-[88rem]:w-[56rem] @min-[88rem]:border-l-0'
			: focus === null
				? '@5xl:relative @5xl:w-[21rem] @5xl:border-l-0'
				: '@5xl:relative @5xl:w-[30rem] @5xl:border-l-0'} max-w-full flex-col overflow-hidden border-l border-border bg-card p-3 {!rail
			? 'pointer-events-none'
			: ''}"
		aria-label={t('Session')}
		data-agent-rail
	>
		<div class="mb-2 flex min-h-8 shrink-0 items-center justify-between gap-1 px-1">
			<p class="text-sm text-muted-foreground">{t(focus === null ? 'Session' : 'Subagents')}</p>
			<span class="flex-1"></span>
			<Button
				size="icon-sm"
				variant="ghost"
				class="shrink-0 text-muted-foreground hover:text-foreground"
				aria-label={t('Close')}
				title={t('Close')}
				onclick={closeRail}
				data-rail-close><Icon name="lucide:x" class="size-4" /></Button
			>
		</div>
		{#if focus !== null}
			<!-- one sub-agent, opened from the list: its whole live view -->
			<div
				class="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-background"
				in:sessionMotion={{ x: 4, duration: navigating ? 120 : 0 }}
				data-rail-view="agent"
			>
				{#key focus}<AgentChild
						{bolt}
						{t}
						id={focus}
						control={childControl}
						onBack={backToChildren}
					/>{/key}
			</div>
		{:else}
			<div
				class="grid min-h-0 content-start divide-y divide-border overflow-auto rounded-2xl border border-border bg-background px-5 [&>section]:py-4"
				in:sessionMotion={{ x: -4, duration: navigating ? 120 : 0 }}
				data-rail-view="overview"
			>
				{#if previewing && shownPreview !== null && !thread}
					<!-- the one previewer: the latest bundle; open (the header's Preview button), it fills the widened rail -->
					<section class="min-w-0 overflow-hidden" data-rail="preview">
						<div class="flex h-[70vh] min-h-80 flex-col" data-agent-preview={shownPreview.url}>
							<!-- the bundle is the frame's version: another bundle (or a rebuild) reloads it, the same one never does -->
							<PreviewFrame
								src={shownPreview.url}
								version={shownPreview.key}
								title={t('Preview')}
								label={shownPreview.about?.['message']}
								{t}
								onClose={() => (previewing = false)}
							>
								{#snippet details()}
									{#if shownPreview.about !== undefined}<p data-preview-caption>
											{captionOf(shownPreview.about, kinds.zone)}
										</p>{:else}<p>{shownPreview.url}</p>{/if}
								{/snippet}
							</PreviewFrame>
						</div>
					</section>
				{/if}
				{#each [['Input', inputs], ['Outputs', outputs]] as const as [title, files] (title)}
					<section class="min-w-0" data-rail={title === 'Input' ? 'inputs' : 'outputs'}>
						<div class="mb-2 flex min-h-8 items-center justify-between gap-2">
							<h3 class="text-sm text-muted-foreground">{t(title)}</h3>
							{#if !thread && !automation}<Button
									size="icon-sm"
									variant="ghost"
									class="text-muted-foreground hover:text-foreground"
									aria-label={t(title === 'Input' ? 'Attach files' : 'Create a file')}
									title={t(title === 'Input' ? 'Attach files' : 'Create a file')}
									onclick={title === 'Input' ? () => picker?.click() : createFile}
									data-rail-attach={title === 'Input' ? '' : undefined}
									data-rail-create={title === 'Outputs' ? '' : undefined}
									><Icon name="lucide:plus" class="size-4" /></Button
								>{:else if files.length > 0}<span class="text-xs text-muted-foreground tabular-nums"
									>{files.length}</span
								>{/if}
						</div>
						{#if files.length === 0}<p class="text-sm leading-6 text-muted-foreground">
								{t(
									title === 'Input'
										? 'Files you share appear here.'
										: 'Ask Norbius to create a file.'
								)}
							</p>
						{:else}<MadeFiles {files} {fileHref} {t} rail />{/if}
						{#if title === 'Input' && attached.length > 0}<p
								class="mt-2 text-xs text-muted-foreground"
								role="status"
							>
								{attached.length}
								{t('ready to send')}
							</p>{/if}
					</section>
				{/each}
				{#if children.length > 0}
					<section class="min-w-0" data-rail="tasks">
						<div
							class="mb-2 flex min-h-8 items-center justify-between gap-2 text-sm text-muted-foreground"
						>
							<h3>{t('Subagents')}</h3>
							<span
								class="tabular-nums"
								data-subagent-summary
								aria-live="polite"
								aria-atomic="true"
								aria-label={childrenLoading
									? t('Loading…')
									: t('{working} of {total} subagents working')
											.replace('{working}', String(workingChildren.length))
											.replace('{total}', String(children.length))}
								>{childrenLoading ? '…' : workingChildren.length}/{children.length}</span
							>
						</div>
						<ul id="agent-children" class="-mx-2 grid">
							{#each orderedChildren as child (child.id)}
								{#if child.id === doneChildren[0]?.id}
									<li class="min-w-0">
										<button
											type="button"
											class="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:min-h-11"
											aria-expanded={showCompleted}
											aria-controls={doneChildren.map((done) => `agent-child-${done.id}`).join(' ')}
											onclick={() => (showCompleted = !showCompleted)}
											data-subagent-completed-toggle
										>
											<Icon
												name="lucide:chevron-right"
												class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {showCompleted
													? 'rotate-90'
													: ''}"
											/>
											{t('Completed')} <span class="tabular-nums">{doneChildren.length}</span>
										</button>
									</li>
								{/if}
								<li
									id={`agent-child-${child.id}`}
									class="min-w-0"
									data-subagent-completed={childStates.get(child.id) === 'done' ? '' : undefined}
									hidden={childStates.get(child.id) === 'done' && !showCompleted}
								>
									<AgentChild
										{bolt}
										{t}
										id={child.id}
										compact
										onOpen={() => openChild(child.id)}
										onState={(state) => childState(child.id, state)}
										control={childControl}
									/>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#if runIds !== ''}
					<section class="min-w-0" data-rail="runs">
						<h3 class="mb-2 text-sm text-muted-foreground">{t('Automations')}</h3>
						<ul class="grid gap-1">
							{#each tasks.filter((task) => task.kind === 'run') as task (task.id)}
								{@const run = runs.current?.get(task.id)}
								{@const state = run === undefined ? null : runState(run.status)}
								<li
									class="flex min-h-10 min-w-0 items-center gap-2 text-sm"
									data-run={task.id}
									data-run-state={state}
								>
									<Icon name="lucide:zap" class="size-4 shrink-0 text-muted-foreground" />
									<span class="min-w-0 flex-1 truncate" title={run?.automation}
										>{run === undefined
											? t('Automation run')
											: human(run.automation.replaceAll('.', ' '))}</span
									>
									<span class="shrink-0 text-xs text-muted-foreground"
										>{state === null
											? t('Loading…')
											: t(ORB[state === 'running' ? 'working' : state].label)}</span
									>
									{#if state === 'running'}<Button
											size="icon-sm"
											variant="ghost"
											class="shrink-0 text-muted-foreground"
											aria-label={t('Stop run')}
											title={t('Stop run')}
											onclick={() => stopRun(task.id)}
											data-run-stop
											><Icon name="lucide:square" class="size-3.5 fill-current" /></Button
										>{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#snippet contextBody()}
					<div class="grid gap-2">
						<p class="text-muted-foreground">
							{t(
								'How much of this conversation the assistant can still keep in mind. Older messages are summarized when it fills.'
							)}
						</p>
						<div class="grid gap-1">
							<div class="flex items-baseline justify-between gap-2 tabular-nums">
								<span class="text-muted-foreground">{t('Context')}</span>
								<span>{k(meter.context)} / {k(meter.window)}</span>
							</div>
							<Progress
								value={meter.percent ?? 0}
								class="h-1.5 w-full"
								aria-label={t('Context window used')}
							/>
						</div>
						<dl class="grid gap-1 tabular-nums">
							{#if chosenModel !== null}<div class="flex justify-between gap-2">
									<dt class="text-muted-foreground">{t('Model')}</dt>
									<dd class="min-w-0 truncate" data-context-model>{modelLabel(chosenModel)}</dd>
								</div>{/if}
							<div class="flex justify-between gap-2">
								<dt class="text-muted-foreground">{t('Input')}</dt>
								<dd>{k(meter.input)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-muted-foreground">{t('Output')}</dt>
								<dd>{k(meter.output)}</dd>
							</div>
							{#if meter.cost !== null}<div class="flex justify-between gap-2">
									<dt class="text-muted-foreground">{t('Cost')}</dt>
									<dd>{usd(meter.cost)}</dd>
								</div>{/if}
						</dl>
					</div>
				{/snippet}
				{#snippet contextBar()}
					<Progress
						value={meter.percent ?? 0}
						class="h-1.5 w-10"
						aria-label={t('Context window used')}
					/>
				{/snippet}
				<div data-rail="context">
					{@render card(
						t('Context'),
						meter.percent === null ? '—' : `${Math.round(meter.percent)}%`,
						contextBody,
						contextBar
					)}
				</div>
				{#snippet changesBody()}
					<ul class="grid gap-1.5">
						{#each changes as c, i (i)}
							<li class="flex min-w-0 items-center gap-2" data-change={c.outcome}>
								<Icon
									name={c.outcome === 'committed' ? 'lucide:circle-check' : 'lucide:clock'}
									class="size-3.5 shrink-0 text-muted-foreground"
								/>
								<span class="min-w-0 flex-1 truncate">{callableWords(c.callable)}</span>
								<span class="shrink-0 text-muted-foreground"
									>{c.outcome === 'committed' ? '' : t('Awaiting approval')}</span
								>
							</li>
						{:else}<li class="text-muted-foreground">{t('Nothing changed yet.')}</li>{/each}
					</ul>
				{/snippet}
				<div data-rail="changes">
					{@render card(
						t('Changes'),
						changes.length === 0 ? '' : String(changes.length),
						changesBody
					)}
				</div>
				{#if connectors.length > 0}
					{#snippet connectorsBody()}
						<ul class="grid gap-1.5">
							{#each connectors as c (c.name)}
								<li class="flex min-w-0 items-center gap-2" data-connector={c.name}>
									<span class="size-1.5 shrink-0 rounded-full bg-success"></span>
									<span class="min-w-0 flex-1 truncate">{human(c.name)}</span>
									{#if c.description !== ''}<span class="min-w-0 truncate text-muted-foreground"
											>{c.description}</span
										>{/if}
								</li>
							{/each}
						</ul>
					{/snippet}
					<div data-rail="connectors">
						{@render card(
							t('Connectors'),
							`${connectors.length} ${t('connected')}`,
							connectorsBody
						)}
					</div>
				{/if}
			</div>
		{/if}
	</aside>
{/snippet}

<!-- hook:agent-ui — the panel is one card surface edge to edge (the sheet's body padding given back); the transcript and the composer
	keep the centred 48rem column -->
<div
	{@attach lifetime}
	class="-m-4 flex h-[calc(100%+2rem)] min-h-0 flex-col bg-card"
	style:background-color="var(--card)"
	data-agent-panel
>
	{#if toSheet === undefined}<div class="shrink-0 border-b px-4 py-2">{@render head()}</div>{/if}
	<div class="@container relative flex min-h-0 flex-1 overflow-x-clip" {@attach measureSession}>
		<div
			bind:this={chatEl}
			class="flex min-w-0 flex-1 flex-col"
			inert={rail && railOverlay}
			data-agent-chat
		>
			<div class="relative flex min-h-0 w-full flex-1 flex-col">
				{#snippet transcriptTab()}
					<div class="flex h-full min-h-0 w-full flex-col">
						{#if settled !== null}
							<!-- Current work strip: the executed plan the agent works from, kept in view while the transcript scrolls; it opens
			over the transcript, not into it -->
							<div class="relative z-20 mx-auto w-full max-w-3xl shrink-0 px-4 pt-3" data-now-strip>
								<div
									class="grid gap-1 rounded-xl border border-border/70 bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
								>
									<details class="group/plan" data-plan={settled.status}>
										<summary
											class="flex cursor-pointer list-none items-center gap-2 rounded text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
										>
											<Icon
												name={settled.status === 'verified'
													? 'lucide:circle-check'
													: 'lucide:notebook-pen'}
												class="size-3.5 shrink-0 text-muted-foreground"
											/>
											<span class="min-w-0 flex-1 truncate font-medium"
												>{planTitle(settled.body) || t('Plan')}</span
											>
											<span class="shrink-0 text-muted-foreground"
												>{t('Plan')} {settled.revision} · {planState(settled)}</span
											>
										</summary>
										<div
											class="absolute inset-x-4 top-full mt-1 max-h-[50dvh] overflow-auto rounded-xl border border-border/70 bg-background px-3 py-2 text-xs shadow-lg"
										>
											<ReadonlyMarkdown value={settled.body} />
											<div class="mt-2 flex justify-end gap-1 border-t border-border/60 pt-2">
												{#if settled.status === 'active'}<Button
														size="sm"
														variant="ghost"
														disabled={!empty}
														onclick={() => (mode = 'plan')}>{t('Revise plan')}</Button
													>{/if}
												<Button
													size="sm"
													variant="ghost"
													onclick={() =>
														status === 'running' ? (confirming = 'plan') : plan(false)}
													>{t('Delete plan')}</Button
												>
											</div>
										</div>
									</details>
								</div>
							</div>
						{/if}
						<!-- the scroll port spans the panel; its padding centres a readable column (Codex's) -->
						<ol
							bind:this={port}
							onscroll={scrolled}
							class="min-h-0 w-full flex-1 space-y-5 overflow-auto px-[max(1rem,calc((100%-46rem)/2),env(safe-area-inset-left))] py-4 text-sm leading-6"
							aria-live="polite"
							aria-label={t('Conversation transcript')}
						>
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
							{#if before !== null}
								<li class="flex justify-center" data-older>
									<button
										type="button"
										class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
										disabled={loadingOlder}
										onclick={loadOlder}
										>{loadingOlder ? t('Loading…') : t('Earlier messages')}</button
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
									<li
										{@attach turns.measure(itemKey(at))}
										data-role="steps"
										data-outside-context={item.steps.every(outside) || undefined}
										data-failed={failures.length > 0 || undefined}
									>
										<details class="group/work" open={working}>
											<summary
												class="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
												data-working={working || undefined}
											>
												{#if working}<span class="agent-shimmer">{t(doingOf(item.steps))}</span
													>{:else}<span>{t('Worked for')} {secs === null ? '' : `${secs}s`}</span
													>{/if}
												<span
													>· {`${item.steps.length} ${t(item.steps.length === 1 ? 'step' : 'steps')}`}</span
												>
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
													class="size-3 transition-transform group-open/work:rotate-90"
												/>
											</summary>
											<Steps steps={item.steps} {t} />
										</details>
										{#each item.steps as st (st.id)}
											<StudioResult step={st} {t} zone={kinds.zone} />
											{#if !thread && st.tool?.approval !== undefined}
												<!-- a live change the host holds for the person: approved here, it runs as them -->
												<StudioApproval {api} step={st} {t} />
											{/if}
										{/each}
										{#if item.steps.some((st) => (st.files?.length ?? 0) > 0)}
											<!-- what the work made (a screenshot, a document): outside the fold -->
											<MadeFiles
												files={item.steps.flatMap((st) => st.files ?? [])}
												{fileHref}
												{t}
											/>
										{/if}
									</li>
								{:else if 'ignored' in item}
									{@const dec = item.decision}
									<!-- messages not for the agent: one quiet block, each sender and text, and the decision that left them -->
									<li
										{@attach turns.measure(itemKey(at))}
										data-role="ignored"
										data-decision={dec?.event.id}
										data-action={dec?.d.action}
										class="ml-auto w-fit max-w-[85%] rounded-xl border border-dashed border-border/80 px-3 py-2 text-xs text-muted-foreground"
									>
										<div class="flex items-center gap-1.5">
											<Icon name="lucide:message-circle-off" class="size-3.5 shrink-0" /><span
												class="font-medium">{t('Not for the assistant')}</span
											>
											{#if dec !== undefined}{@render decisionToggle(dec, 'ml-auto')}{/if}
										</div>
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
										{#if dec !== undefined && expanded.has(dec.event.id)}{@render matrix(dec)}{/if}
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
											{@render decisionToggle(item.decision, '')}
										</div>
										{#if expanded.has(event.id)}{@render matrix(item.decision)}{/if}
									</li>
								{:else}
									{@const { row, index } = item}
									{#if row.role === 'user'}
										{@const label = triageLabel(row, index)}
										<li
											{@attach turns.measure(itemKey(at))}
											class="ml-auto w-fit max-w-[85%] rounded-[1.25rem] bg-muted px-4 py-2.5 break-words whitespace-pre-wrap"
											class:opacity-60={row.state === 'pending' || row.tag === 'ambient'}
											data-role="user"
											data-outside-context={outside(row) || undefined}
											data-pending={row.state === 'pending' || undefined}
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
												</div>{:else}<span data-text>{row.text}</span>{/if}{@render attachments(
												row
											)}
											{#if !thread && row.state === 'consumed' && revisable(row)}<Button
													size="sm"
													variant="ghost"
													class="mt-1 h-6 px-1 text-xs"
													onclick={() => revise(row)}>{t('Revise')}</Button
												>{/if}
											{#if label !== null}
												<span
													class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground"
													data-triage={row.state === 'pending' ? 'waiting' : 'responding'}
													data-role={row.id === lastPending ? 'waiting' : undefined}
												>
													<span>{label}</span>
													{#if !thread && row.id === lastPending}<Button
															size="sm"
															variant="ghost"
															onclick={respondNow}>{t('Respond now')}</Button
														>{/if}
												</span>
											{/if}
										</li>
									{:else if !thread && (row.state === 'confirm' || row.state === 'approved') && row.call}
										{@const call = row.call}
										{@const busy = answering.has(row.id) || row.state === 'approved'}
										<li
											{@attach turns.measure(itemKey(at))}
											class="rounded-xl border border-border/70 bg-background p-3 shadow-sm"
											data-role="confirm"
										>
											<p class="text-sm font-medium text-foreground">
												{t('Allow Norbius to do this?')}
											</p>
											<details class="mt-1 text-xs text-muted-foreground">
												<summary class="cursor-pointer">{t('Details')}</summary>
												<div class="mt-1 max-h-48 min-w-0 overflow-auto">
													<StructuredData value={call.input} name={t('Input')} />
												</div>
											</details>
											<Inline gap="xs" class="mt-2" align="center">
												{#if row.state === 'confirm'}<Button
														size="sm"
														disabled={busy}
														onclick={() => confirm(row, true)}>{t('Approve')}</Button
													>
													<Button
														size="sm"
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
									{:else if row.role === 'assistant' && row.text}
										{@const model = dividers.get(row.id)}
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
													/><span>{t('Switched to')} {modelLabel(model)}</span><span
														class="h-px flex-1 bg-border"
													></span>
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
											{#each receiptsOf(row) as r, i (i)}
												<p class="text-xs text-muted-foreground" data-receipt>
													{r.outcome === 'pendingApproval' ? t('Awaiting approval') : t('Done')}: {r.callable}
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
									<span class="agent-shimmer">{t('Thinking…')}</span>
									<span class="tabular-nums">{thinking}s</span>
								</li>
							{/if}
							{#if current?.goals?.length}
								<!-- the goals: one checklist under the latest message, each step's state at a glance -->
								<li data-goals>
									<ol
										class="grid gap-1.5 rounded-xl border border-border/70 px-4 py-3"
										aria-label={t('Goal steps')}
									>
										{#each current.goals as g (g.id)}
											<li class="flex min-w-0 items-start gap-2" data-goal={g.status}>
												{#if g.status === 'done'}<Icon
														name="lucide:circle-check"
														class="mt-1 size-4 shrink-0 text-muted-foreground"
													/>
												{:else if g.status === 'doing'}<Spinner
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
								</li>
							{/if}
						</ol>
						{#if !pinned}
							<Button
								size="sm"
								variant="secondary"
								class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-md"
								aria-label={t('Jump to latest')}
								onclick={() => latest()}
								data-latest
							>
								<Icon name="lucide:arrow-down" class="size-4" />{t('Latest')}</Button
							>
						{/if}
					</div>
				{/snippet}

				{@render transcriptTab()}
			</div>
			{#if thread || automation}
				<p
					class="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground"
					data-agent-read-only
				>
					{automation
						? t("An automation's inference, recorded as it ran. Read-only here — start a new conversation to retry or ask again.")
						: t('An integration conversation, answered by its envoy. Read-only here.')}
				</p>
			{:else}
				{#if drafting && current?.plan}
					{@const p = current.plan}
					<!-- Draft plan: a collapsed card above the prompt, reviewed by expanding it, executed or deleted from its header -->
					<div class="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3" data-draft-plan>
						<section
							class="rounded-lg border border-border bg-muted/20"
							aria-label={t('Draft plan')}
							aria-busy={starting}
						>
							<div class="flex items-center gap-1 px-2 py-1.5">
								<Button
									variant="ghost"
									size="sm"
									class="min-w-0 px-1"
									aria-expanded={draftOpen}
									onclick={() => (draftOpen = !draftOpen)}
								>
									<Icon
										name="lucide:chevron-down"
										class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {draftOpen
											? 'rotate-180'
											: ''}"
									/>
									<span class="truncate">{t('Draft plan')}</span>
								</Button>
								<span
									class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
									title={`${t('Revision')} ${p.revision}`}>r{p.revision}</span
								>
								<Button
									size="icon-sm"
									variant="ghost"
									class="shrink-0"
									aria-label={t('Delete plan')}
									title={t('Delete plan and return to Agent mode')}
									disabled={starting}
									onclick={() => plan(false)}
								>
									<Icon name="lucide:trash-2" class="size-3.5" />
								</Button>
								<Button
									size="sm"
									class="shrink-0 px-2"
									aria-label={starting ? t('Starting…') : t('Execute plan')}
									disabled={starting || status === 'running' || !empty}
									onclick={() => plan(true)}
									data-execute-plan
								>
									<Icon
										name={starting ? 'lucide:loader-circle' : 'lucide:play'}
										class="size-3.5 {starting ? 'animate-spin motion-reduce:animate-none' : ''}"
									/>
									<span aria-live="polite">{starting ? t('Starting…') : t('Execute')}</span>
								</Button>
							</div>
							{#if draftOpen}
								<div
									class="overflow-auto border-t border-border/60 px-3 py-2 text-sm leading-relaxed"
									style="height: 28dvh"
								>
									<ReadonlyMarkdown value={p.body} />
								</div>
							{/if}
						</section>
					</div>
				{/if}
				{#if planning || mode === 'compact'}
					<!-- Mode line: between the transcript and the composer's top border -->
					<p
						class="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2 text-tiny text-muted-foreground"
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
				<div
					class="shrink-0 border-t border-border bg-card pb-[max(0.75rem,env(safe-area-inset-bottom))]"
					data-agent-composer
				>
					<div
						class="mx-auto flex w-full max-w-3xl flex-col gap-2 pt-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
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
							<!-- the queue: a thin rail behind the composer -->
							<div class="grid w-full gap-1 text-xs" data-agent-queue>
								<span class="text-muted-foreground">{t('Queued')} · {queued.length}</span>
								<ol class="max-h-32 divide-y overflow-auto rounded-lg border border-border/70">
									{#each queued as q, i (q.id)}
										<li class="flex items-center gap-1 px-2 py-0.5" data-queued={q.id}>
											<span class="min-w-0 flex-1 truncate" title={q.text ?? ''}
												>{q.text || t('Attached message')}</span
											>
											{#if i > 0}<Button
													size="icon-sm"
													variant="ghost"
													aria-label={t('Move up')}
													onclick={() => moveUp(i)}
													><Icon name="lucide:arrow-up" class="size-3.5" /></Button
												>{/if}
											{#if !q.id.startsWith('local:')}<!-- still posting: nothing to edit or remove yet -->
												<Button size="sm" variant="ghost" class="px-1" onclick={() => revise(q)}
													>{t('Edit')}</Button
												>
												<Button
													size="icon-sm"
													variant="ghost"
													aria-label={t('Remove')}
													onclick={() => dequeue(q)}
													><Icon name="lucide:x" class="size-3.5" /></Button
												>
											{/if}
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
									>{revising.state === 'queued'
										? t('Editing a queued message.')
										: t('Revising a message: sending supersedes it.')}</span
								>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									class="-my-1 shrink-0 px-2 text-xs hover:bg-background"
									onclick={() => {
										revising = null;
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
							onsubmit={send}
							class="relative flex w-full flex-col"
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
										{#if chip === 'compact' || !planLocked}<button
												type="button"
												class="grid size-4 place-items-center rounded-full opacity-70 hover:opacity-100"
												aria-label={t('Remove')}
												onclick={() => (mode = null)}
												><Icon name="lucide:x" class="size-3" /></button
											>{/if}
									</span>
								</Inline>
							{/if}
							<MarkdownEditor
								value={draft}
								onChange={(v) => (draft = v)}
								rows={2}
								{commands}
								commandStart="text"
								{mentions}
								aria-label={t('Message')}
								class="[&_textarea]:max-h-40 [&_textarea]:min-h-14 [&_textarea]:resize-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0 [&_textarea]:py-3 [&_textarea]:text-sm [&_textarea]:leading-relaxed [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0 dark:[&_textarea]:bg-transparent"
								placeholder={t('Ask anything · / for commands')}
								onkeydown={keydown}
								onpaste={paste}
							/>
							{#if attached.length > 0}
								<Inline gap="xs" class="flex-wrap pb-1" data-attached>
									{#each attached as f, i (i)}
										<button
											type="button"
											class="inline-flex h-10 max-w-48 items-center gap-2 overflow-hidden rounded-md border border-border/70 px-2 text-xs"
											aria-label={`${t('Remove')} ${f.name}`}
											onclick={() => {
												attached = attached.filter((_, j) => j !== i);
											}}
										>
											<Icon
												name={f.type.startsWith('image/') ? 'lucide:image' : 'lucide:file-text'}
												class="size-4 shrink-0"
											/><span class="truncate">{f.name}</span><Icon
												name="lucide:x"
												class="size-3 shrink-0"
											/>
										</button>
									{/each}
								</Inline>
							{/if}
							<input
								bind:this={picker}
								type="file"
								multiple
								class="sr-only"
								aria-hidden="true"
								tabindex="-1"
								accept="image/*,text/*,application/pdf,application/json,application/xml,.docx,.xlsx,.md,.csv,.tsv,.log,.yaml,.yml"
								onchange={(e) => {
									attach([...(e.currentTarget.files ?? [])]);
									e.currentTarget.value = '';
								}}
							/>
							<Inline gap="xs" class="pb-2">
								<!-- the attach glyph lines up with the text above it -->
								<Button
									type="button"
									size="icon-sm"
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
									onclick={openRail}
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
										value={chosenModel}
										placeholder={t('Model')}
										aria-label={t('Model')}
										onChange={pickModel}
									/>
								{/if}
								{#if status === 'running' && empty}<Button
										type="button"
										size="icon-sm"
										class="shrink-0 rounded-full"
										aria-label={t('Stop')}
										title={t('Stop')}
										onclick={() => (confirming = 'stop')}
										data-agent-stop
										><Icon name="lucide:square" class="size-3.5 fill-current" /></Button
									>
								{:else if status === 'stopped' && empty}<Button
										type="button"
										size="icon-sm"
										class="shrink-0 rounded-full"
										aria-label={t('Resume')}
										title={t('Resume')}
										onclick={() => control(false)}
										data-agent-resume><Icon name="lucide:play" class="size-4" /></Button
									>
								{:else}<Button
										type="submit"
										size="icon-sm"
										class="shrink-0 rounded-full"
										aria-label={status === 'running' ? t('Queue message') : t('Send')}
										title={status === 'running' ? t('Queue message') : t('Send')}
										disabled={empty && mode !== 'compact'}
									>
										<Icon
											name={status === 'running' ? 'lucide:list-plus' : 'lucide:arrow-up'}
											class="size-4"
										/>
									</Button>{/if}
							</Inline>
						</form>
					</div>
				</div>
			{/if}
		</div>
		{#if rail}{@render session()}{/if}
	</div>
</div>

<svelte:document onkeydown={railKeydown} />

<!-- Ask before stopping a response, and before deleting a plan while it runs -->
<Dialog.Root
	open={confirming !== null}
	onOpenChange={(o) => {
		if (!o) confirming = null;
	}}
>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title
				>{confirming === 'plan' ? t('Delete this plan?') : t('Stop this response?')}</Dialog.Title
			>
			<Dialog.Description
				>{confirming === 'plan'
					? t('The agent stops working from it. Conversation history stays available.')
					: t(
							'The current response will stop. Completed work is kept; queued messages are cancelled.'
						)}</Dialog.Description
			>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirming = null)}
				>{confirming === 'plan' ? t('Keep plan') : t('Keep working')}</Button
			>
			<Button
				variant="destructive"
				onclick={() => {
					const c = confirming;
					confirming = null;
					if (c === 'plan') plan(false);
					else control(true);
				}}
				data-confirm>{confirming === 'plan' ? t('Delete plan') : t('Stop response')}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
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
	/* a rail card's detail eases open instead of appearing at once */
	[data-agent-rail] details[open] > :not(summary) {
		animation: rail-card-in 150ms var(--ease-out, ease-out);
	}
	[data-subagent-completed]:not([hidden]) {
		animation: rail-card-in 120ms var(--ease-out, ease-out);
	}
	@keyframes rail-card-in {
		from {
			opacity: 0;
			transform: translateY(-2px);
		}
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
		[data-agent-rail] details[open] > :not(summary),
		[data-subagent-completed]:not([hidden]) {
			animation: none;
		}
		[data-streaming] .agent-reply :global([data-markdown] > :last-child::after) {
			animation: none;
		}
	}
</style>
