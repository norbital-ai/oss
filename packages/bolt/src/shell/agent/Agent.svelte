<!--
	The in-app agent panel (§5.9, rules 58, 59): one conversation per tab, the transcript with each reply's receipts,
	a confirmation card for a held call, and the running turn's text as it streams. Posting answers at once; the turn
	runs after it, and everything it writes (the reply growing flush by flush, each tool call running then finished) is
	rows of the conversation's live transcript, patched in over the page's one live stream; the conversation list, each
	one's status, plan and goals are a live read too. Nothing polls and there is no second stream. Enter sends (under a coarse
	pointer it is a new line and the Send button sends), Shift+Enter is a new line, Cmd/Ctrl+Enter sends now; the timer beside send schedules the message for a time or for when the agent finishes,
	and what is scheduled lists above the composer (edit, remove). With triage (rule 60a, P41) each triaged row carries its state: "reading…"
	while pending (with respond-now), "responding" once admitted and its turn runs; every message that came in is
	shown, and consecutive ones not for the agent fold into one quiet block, collapsed to its count and last message; on a
	channel thread each reply names the messages it answers ("Replying to"). Files are attached with the paperclip, by paste
	or by drop (at most 8 files); each uploads to `/__bolt/files/sys_conversation.inputs` when the message is sent.
	The selector's footer switches conversation views (newest first): the member's own (Web UI) and one per envoy
	whose channel conversations they may read (automations' inference transcripts are the command center's); dots switch views, and Cmd/Ctrl+Right Arrow advances while search is focused;
	search filters every view at once (each count follows its matches). Only Web UI conversations are writable; delegated sub-agents live in the session rail (their tasks, live steps and answers),
	several working at once, one level deep; a message sent while a turn runs steers it, waiting in the queue until the step ends (edit, reorder, remove); the context meter reads the
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
	how long) open to tabs: the code it carried, highlighted, its input and its output (`Steps`); a failed row's icon is the alert, so the call that failed reads at a glance. Code blocks copy. The open conversation is the shell's `?agent=` (`on_conversation` reports a switch). The
	envoy tab heads its direct messages and each group chat by its name. For an administrator, a scale mark closes each triaged batch of messages; it opens to the
	decider's matrix (each message, its answer and verdict, the wait) and says when a decided reply is still to come. An
	envoy's channel conversation or an automation's transcript is read-only here (rule 61): its transcript, a "Read-only —"
	notice where the composer was, and no controls at all.
-->
<script lang="ts">
	import { attach as attachEffect, observe as liveEdge, fork } from '@norbital-ai/ui/effect';
	import { Deferred, Effect, FiberSet, Predicate, Schema, Stream } from 'effect';
	import { getContext, tick, untrack, type Snippet } from 'svelte';
	import { readPreference, writePreference } from '../preferences.ts';
	import { humanise, date_time, BRIEF_TIMESTAMP } from '../i18n.ts';
	import { MediaQuery } from 'svelte/reactivity';
	import { cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import { watch } from 'runed';
	import { Inline } from '@norbital-ai/ui/layout';
	import { AccretionDisc, NorbiusStrip } from '@norbital-ai/ui/brand';
	import { Button, Combobox, Dialog, format_handle, Icon, type ModelExposure } from '@norbital-ai/ui';
	import type { AiModel } from '../../engine/contracts.ts';
	import type { AgentConversation, AgentRow } from '../../protocol/wire.ts';
	import type { AgentRequest, ShellBolt } from '../runtime.ts';
	import { ConversationsReadAnswer, RestartChat, TranscriptReadAnswer, type ShellError } from '../api-types.ts';
	import { agent_drafts } from './drafts.ts';
	import { message_outbox, type OutboxRow } from './outbox.svelte.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { StudioView } from '../studio/model.ts';
	import SessionRail from './SessionRail.svelte';
	import { context_meter } from './usage.ts';
	import Transcript from './Transcript.svelte';
	import { AgentPanelFailed, refused } from './actions.ts';
	import PlanCards from './PlanCards.svelte';
	import Composer from './Composer.svelte';
	import PreviewFrame from '../preview/PreviewFrame.svelte';
	import { attention } from './chime.ts';
	import { SOUNDS, type Sounds } from '../sounds.ts';
	import { CLIENT_NAVIGATION, navigationEvents, type ClientNavigation } from './navigation.ts';
	import {
		CLIENT_PAGE_ACTION,
		pageActions,
		pageConversationStarted,
		type ClientPageAction
	} from './navigation.ts';
	import { studio_events } from '../studio/events.ts';
	import { commandKey, shortcutLabel } from '../keyboard.ts';
	import type { NavNode } from '../nav.ts';
	import type { ManifestItem } from '../finder/manifest.ts';
	import type { FinderRead } from '../finder/model.ts';
	import { captionOf, ORB, orbState, previewsOf, currentPreview } from './view.ts';

	let {
		api,
		bolt,
		read,
		t,
		request,
		unconfigured = false,
		admin = false,
		envoys = {},
		catalog = {},
		zone,
		nav = [],
		entries = [],
		on_conversation,
		storage_key
	}: {
		api: ShellApi;
		bolt: Pick<ShellBolt, 'observe' | 'file_url'>;
		/** The finder's record search read (mentions and commands). */
		read: FinderRead;
		t: (key: string) => string;
		request: AgentRequest;
		/** The host binds no AI provider: say so plainly (a send still fails with the fixed reply and an `agent.failed` event). */ unconfigured?: boolean;
		/** The viewer is an administrator: each triaged batch shows its `decision.made` events (the log refuses anyone else). */ admin?: boolean;
		/** The same authorized apps offered by Find. */
		nav?: readonly NavNode[];
		entries?: readonly ManifestItem[];
		catalog?: Readonly<Record<string, ModelExposure>>;
		zone?: string;
		/** Each envoy's display name (`ShellBoot.envoys`), for the picker's groups. */ envoys?: {
			readonly [envoy: string]: string;
		};
		/** The open conversation changed (`null`: a new one), for the shell's `?agent=`. */ on_conversation?: (
			id: string | null
		) => void;
		/** The `localStorage` key of the last opened conversation, one per workspace and member; none: nothing is remembered. */ storage_key?:
			string | undefined;
	} = $props();

	// svelte-ignore state_referenced_locally
	const remembered = readPreference(storage_key);
	// svelte-ignore state_referenced_locally
	let conversation = $state<string | null>(
		request.conversation === undefined ? remembered : request.conversation
	);
	const drafts = untrack(() => agent_drafts(bolt, storage_key));
	const initial_draft = untrack(() => drafts.get(conversation));

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
	const outbox = message_outbox();
	const rows = $derived([...older, ...live, ...outbox.rows]);
	const before = $derived(
		from === null ? null : edge === null ? from : edge.more ? edge.first : null
	);
	/** L-BOLT-436: the message this panel just posted (working while it waits in the queue), and a send this panel saw fail. */
	let sent = $state<string | null>(null),
		sendFailed = $state(false);
	// svelte-ignore state_referenced_locally
	let draft = $state(initial_draft?.text ?? request.prompt ?? '');
	let error = $state<string | null>(null);
	/**
	 * The composer's `/plan` (or Tab) or `/compact`, lifted out of the draft into a chip. `/compact` lasts one send; plan
	 * mode stays until it is removed or its plan executes, and a draft plan holds it (the engine plans until it runs).
	 */
	let mode = $state<'plan' | 'compact' | null>(initial_draft?.mode ?? null);
	let attached = $state<File[]>([...(initial_draft?.files ?? [])]);
	let stored_files = $state<NonNullable<AgentRow['files']>>([...(initial_draft?.stored_files ?? [])]);
	let revision_pending = $state(false);
	let picker = $state<HTMLInputElement | null>(null);
	/** Browsers often report no type for these, so the extension names it (the host checks the type again). */
	const BY_EXTENSION: { readonly [ext: string]: string } = {
		heic: 'image/heic',
		heif: 'image/heif',
		pdf: 'application/pdf',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		doc: 'application/msword',
		xls: 'application/vnd.ms-excel',
		ppt: 'application/vnd.ms-powerpoint',
		odt: 'application/vnd.oasis.opendocument.text',
		ods: 'application/vnd.oasis.opendocument.spreadsheet',
		odp: 'application/vnd.oasis.opendocument.presentation',
		rtf: 'application/rtf',
		mp3: 'audio/mpeg',
		m4a: 'audio/mp4',
		wav: 'audio/wav',
		ogg: 'audio/ogg',
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
			return void (error = t(
				'Attach a nonempty image, document, spreadsheet, slides, recording or text file.'
			));
		if (all.length + stored_files.length > 8) return void (error = t('Attach at most 8 files.'));
		error = null;
		attached = all;
		for (const file of typed) uploadAhead(file);
	}
	/** Each file goes up on attach: a person takes seconds to write their words. */
	type UploadedAttachment = Effect.Success<ReturnType<ShellApi['agent']['upload']>>;
	const uploads = new WeakMap<File, Deferred.Deferred<UploadedAttachment, ShellError>>();
	function uploadAhead(file: File): void {
		const done = Deferred.makeUnsafe<UploadedAttachment, ShellError>();
		uploads.set(file, done);
		dispatch(
			Effect.exit(api.agent.upload(file)).pipe(
				Effect.flatMap((exit) => Deferred.done(done, exit)),
				Effect.asVoid
			)
		);
	}
	const upload_files = Effect.fn('AgentPanel.uploadFiles')(function* (files: readonly File[]) {
		const refs: UploadedAttachment[] = [];
		for (const file of files) {
			const ahead = uploads.get(file);
			const uploaded = yield* Effect.result(ahead === undefined ? api.agent.upload(file) : Deferred.await(ahead));
			if (uploaded._tag === 'Failure') {
				uploads.delete(file);
				return yield* Effect.fail(new AgentPanelFailed({ message: `${file.name}: ${uploaded.failure.message}`, cause: uploaded.failure }));
			}
			refs.push(uploaded.success);
		}
		return refs;
	});

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
	let previewToggle = $state<HTMLButtonElement | null>(null);
	let previewEl = $state<HTMLElement | null>(null);
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
	function railKeydown(event: KeyboardEvent): void {
		if (
			(!rail && !showingPreview) ||
			event.key !== 'Escape' ||
			event.defaultPrevented ||
			event.isComposing
		)
			return;
		const target = event.target;
		if (
			showingPreview &&
			target instanceof Node &&
			(previewEl?.contains(target) || previewToggle?.contains(target))
		) {
			event.preventDefault();
			event.stopPropagation();
			closePreview();
			return;
		}
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
	const chime = getContext<Sounds | undefined>(SOUNDS);
	const attentionOf = attention();
	const clientNavigation = getContext<ClientNavigation | undefined>(CLIENT_NAVIGATION);
	const clientPageAction = getContext<ClientPageAction | undefined>(CLIENT_PAGE_ACTION);
	const navigationsOf = navigationEvents();
	const pageActionsOf = pageActions();
	// the open conversation's rows once its transcript has answered: what it held on opening is history, never an event
	watch([() => conversation, () => $transcript], ([id, loaded]) => {
		const ready = loaded === undefined ? null : id,
			rows = loaded?.rows ?? [];
		const kind = attentionOf(ready, rows);
		if (kind !== null) chime?.play(kind);
		for (const item of navigationsOf(ready, rows)) {
			if (id === null) continue;
			clientNavigation?.open(item.path, id);
			clientPageAction?.arrived(item.id);
		}
		for (const item of pageActionsOf(id, rows)) {
			if (id !== null && !thread) clientPageAction?.run(item.action, id, item.id);
		}
	});
	/** The selector tab a conversation sits in: the member's own (Web UI) or its envoy's. */
	const tabOf = (c: AgentConversation) =>
		c.integration === null ? 'web' : `envoy:${c.envoy ?? c.integration}`;
	const envoyName = (c: AgentConversation) =>
		envoys[c.envoy ?? ''] ?? humanise(c.envoy ?? c.integration ?? '');
	/** A conversation's own line: its title, else a DM's peer (the provider's address) or the group's thread. */
	const nameOf = (c: AgentConversation) =>
		c.title ??
		(c.integration === null || c.thread === null
			? t('Conversation')
			: c.peer === null
				? format_handle(null, c.thread)
				: `${c.peer} (${format_handle(null, c.thread)})`);
	// svelte-ignore state_referenced_locally
	const conversations = liveEdge(() =>
		bolt.observe({ read: { m: 'conversations', a: [] } }, ConversationsReadAnswer)
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
					save_draft();
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
	const transcript = liveEdge(() =>
		conversation === null
			? null
			: bolt.observe({
					read: { m: 'transcript', a: [conversation, { tail: WINDOW }] }
				}, TranscriptReadAnswer)
	);
	watch(
		() => conversation,
		(id) => {
			on_conversation?.(id);
			thread = false;
			automation = false;
			// the last opened one outlives the tab; a new session (or one no longer found) forgets it
			writePreference(storage_key, id);
		}
	);
	watch(
		() => [$transcript, transcript.error] as const,
		([value, cause]) => {
			if (cause?._tag === 'ReadFailed' && cause.code === 'not_found') return fresh();
			if (value === undefined) return;
			live = [...value.rows];
			from = value.from ?? null;
			thread = value.thread === true;
			automation = value.automation === true;
			inputs = (value.inputs ?? []).map((file) => ({ ...file, name: file.name ?? 'file', mime: file.mime ?? '' }));
			outputs = (value.outputs ?? []).map((file) => ({ ...file, name: file.name ?? 'file', mime: file.mime ?? '' }));
			outbox.arrived(value.rows);
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

	let asked: string | undefined;
	watch(
		() => request.send,
		(id) => {
			if (id === undefined || id === asked) return;
			asked = id;
			draft = request.prompt ?? '';
			send();
		}
	);
	function send(
		event?: SubmitEvent | KeyboardEvent | MouseEvent,
		now = false,
		schedule?: string
	): void {
		event?.preventDefault();
		const text = draft.trim() || (mode === 'compact' ? '/compact' : '');
		if (revision_pending || (text === '' && attached.length === 0 && stored_files.length === 0)) return;
		error = null;
		latest();
		if (revising !== null) {
			const id = revising.id;
			const original_files = stored_files;
			const new_files = attached;
			revision_pending = true;
			dispatch(
				Effect.gen(function* () {
					const uploaded = yield* upload_files(new_files);
					const answer = yield* Effect.result(api.agent.revise(id, text, [...original_files, ...uploaded]));
					yield* Effect.sync(() => {
						if (revising?.id !== id) return;
						error = refused(answer);
						if (error === null) {
							draft = '';
							attached = [];
							stored_files = [];
							revising = null;
						}
					});
				}).pipe(Effect.ensuring(Effect.sync(() => { revision_pending = false; })))
			);
			return;
		}
		const about =
			request.about === undefined
				? ''
				: `(${t('About')} ${request.about.model}/${request.about.id}) `;
		const originals = stored_files.flatMap((file) => file.id === undefined ? [] : [{ id: file.id, name: file.name, mime: file.mime }]);
		if (originals.length !== stored_files.length) {
			error = t('Remove the unavailable attachment before sending.');
			return;
		}
		const files = attached,
			sentMode = mode === 'compact' ? 'compact' : planning ? 'plan' : undefined;
		// on screen before any round trip: the conversation's creation and the post follow behind it
		const local = `local:${crypto.randomUUID()}`;
		outbox.add({
			id: local,
			seq: Number.MAX_SAFE_INTEGER,
			role: 'user',
			text: about + text,
			state: schedule !== undefined ? 'scheduled' : status === 'running' ? 'queued' : null,
			...(schedule === undefined || schedule === 'finish' ? {} : { due: schedule }),
			tag: null,
			files: [...originals, ...files.map((f) => ({ name: f.name, mime: f.type }))]
		});
		draft = '';
		attached = [];
		stored_files = [];
		if (mode === 'compact') mode = null;
		const failed = (message: string) => {
			outbox.remove(local);
			draft = text;
			attached = files;
			stored_files = originals;
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
					yield* Effect.sync(() => {
						pageConversationStarted(startedId);
						drafts.delete(null);
						conversation = startedId;
						picked = null;
					});
				}
				const uploaded = yield* Effect.result(upload_files(files));
				if (uploaded._tag === 'Failure') return yield* Effect.sync(() => failed(uploaded.failure.message));
				const refs = uploaded.success;
				const answer = yield* Effect.result(
					api.agent.post(id, about + text, now, [...originals, ...refs], sentMode, schedule)
				);
				yield* Effect.sync(() => {
					sendFailed = answer._tag === 'Failure' || answer.success.kind === 'refused';
					if (answer._tag === 'Failure') return failed(answer.failure.message);
					if (answer.success.kind === 'refused') return failed(answer.success.message);
					const output = answer.success.kind === 'committed' ? answer.success.output : null;
					const posted = Predicate.isObject(output) ? output['id'] : undefined;
					sent = typeof posted === 'string' ? posted : null;
					const stored = sent;
					// A live patch can arrive before its post answer; cancellation can too.
					if (outbox.acknowledge(local, stored, live) && stored !== null)
						dispatch(
							Effect.result(api.agent.dequeue(stored)).pipe(
								Effect.tap((answer) =>
									Effect.sync(() => {
										error = refused(answer);
									})
								),
								Effect.asVoid
							)
						);
				});
			})
		);
	}
	const empty = $derived(draft.trim() === '' && attached.length === 0 && stored_files.length === 0);
	function switch_conversation(id: string | null): void {
		save_draft();
		error = null;
		conversation = id;
		live = [];
		older = [];
		from = null;
		edge = null;
		outbox.clear();
		sent = null;
		sendFailed = false;
		const saved = drafts.get(id);
		draft = saved?.text ?? '';
		revising = saved?.revising ?? null;
		stored_files = [...(saved?.stored_files ?? [])];
		attached = [...(saved?.files ?? [])];
		mode = saved?.mode ?? null;
		latest();
	}
	function fresh(): void {
		switch_conversation(null);
	}
	function select(id: string): void {
		if (id === conversation) return;
		switch_conversation(id);
	}
	/** The selector's search, across every view, and its open view. */
	let query = $state(''),
		tab = $state('web');
	// an automation's inference transcript opens here from the command center, never from the selector
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return list.filter(
			(c) =>
				c.run == null &&
				(q === '' || `${nameOf(c)} ${c.thread ?? ''} ${c.peer ?? ''}`.toLowerCase().includes(q))
		);
	});
	/**
	 * The tabs the list holds (Web UI always, then each envoy by name): the server lists only the envoy threads this member
	 * may read, so a tab is here exactly when it has rows to show.
	 */
	const counted = (name: string, title: string, icon: string) => ({
		name, title, icon, count: matches.filter((c) => tabOf(c) === name).length
	});
	const web_tab = $derived(counted('web', t('Web UI'), 'lucide:message-square'));
	const tabs = $derived.by(() => {
		const envoyTabs = new Map<string, string>();
		for (const c of list)
			if (c.integration !== null && c.run == null) envoyTabs.set(tabOf(c), envoyName(c));
		return [
			web_tab,
			...[...envoyTabs]
				.sort((a, b) => a[1].localeCompare(b[1]))
				.map(([name, title]) => counted(name, title, 'lucide:bot'))
		];
	});
	const shownTab = $derived(tabs.some((x) => x.name === tab) ? tab : 'web');
	const viewIndex = $derived(tabs.findIndex((x) => x.name === shownTab));
	const currentView = $derived(tabs[viewIndex] ?? web_tab);
	function viewShortcut(event: KeyboardEvent): void {
		if (
			!(event.target instanceof HTMLInputElement) ||
			event.target !== document.activeElement ||
			!commandKey(event) ||
			event.altKey ||
			event.shiftKey ||
			event.isComposing ||
			event.key !== 'ArrowRight'
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		const next = tabs[(viewIndex + 1) % tabs.length];
		if (next !== undefined) tab = next.name;
	}
	/** The open tab's matches; in an envoy's tab its direct messages first, then each group chat under its name. */
	const options = $derived(
		matches
			.filter((c) => tabOf(c) === shownTab)
			.map((c, i) => ({
				c,
				i,
				group:
					c.integration === null
						? undefined
						: c.kind === 'group'
							? `${t('Group')}: ${c.title ?? c.thread ?? ''}`
							: t('Direct messages')
			}))
			.sort(
				(a, b) =>
					Number(a.c.kind === 'group') - Number(b.c.kind === 'group') ||
					(a.group ?? '').localeCompare(b.group ?? '') ||
					a.i - b.i
			)
			.map(({ c, group }) => ({
				value: c.id,
				label: nameOf(c),
				// the picker says which run is live, stopped, or idle; a failed turn is its transcript's last row
				description: `${date_time(c.at, undefined, BRIEF_TIMESTAMP)} · ${c.status === 'running' ? t('Running') : c.status === 'stopped' ? t('Stopped') : t('Idle')}`,
				// envoy and automation sessions are read-only
				...(shownTab === 'web' ? {} : { icon: 'lucide:lock' }),
				...(group === undefined ? {} : { group })
			}))
	);
	// the host's models by human label, grouped by provider; a conversation on a class (`default`) shows the host's default
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
			Effect.result(api.agent.set_model(conversation, model)).pipe(
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
				execute ? api.agent.execute_plan(conversation) : api.agent.discard_plan(conversation)
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
	let starting = $state(false);
	/** Staging asks before a stop, and before deleting a plan that is running. */
	let confirming = $state<'stop' | 'plan' | null>(null);
	const drafting = $derived(current?.plan?.status === 'draft');
	const planning = $derived(mode === 'plan' || drafting);

	// the queue: messages posted while a turn runs wait here until the step ends and the next takes them
	const queued = $derived(
		rows.filter((r) => r.role === 'user' && r.state === 'queued' && r.report === undefined)
	);
	let revising = $state<AgentRow | null>(initial_draft?.revising ?? null);
	function save_draft(): void {
		if (draft === '' && attached.length === 0 && stored_files.length === 0 && revising === null && mode === null) drafts.delete(conversation);
		else drafts.set(conversation, $state.snapshot({ text: draft, files: attached, stored_files, revising, mode }));
	}
	watch(() => [draft, attached, stored_files, revising, mode], save_draft);
	let restart_from = $state<AgentRow | null>(null);
	let restart_pending = $state(false);
	let restart_error = $state<string | null>(null);
	function restart_chat(row: AgentRow): void {
		if (restart_pending) return;
		const original = conversation;
		restart_from = row;
		restart_pending = true;
		restart_error = null;
		dispatch(Effect.gen(function* () {
			const answer = yield* Effect.result(api.agent.restart(row.id));
			const problem = refused(answer);
			if (problem !== null) {
				restart_error = problem;
				return;
			}
			if (answer._tag !== 'Success' || answer.success.kind !== 'committed') {
				restart_error = t('The chat could not be restarted.');
				return;
			}
			const decoded = Schema.decodeUnknownResult(RestartChat)(answer.success.output);
			if (decoded._tag === 'Failure') {
				restart_error = t('The new chat could not be opened. Find it in your conversations.');
				return;
			}
			if (conversation !== original) return;
			const result = decoded.success;
			select(result.conversation);
			pageConversationStarted(result.conversation);
			draft = result.message.text ?? '';
			stored_files = [...(result.message.files ?? [])];
			mode = result.mode === 'plan' || result.mode === 'compact' ? result.mode : null;
			restart_from = null;
			save_draft();
			yield* Effect.promise(async () => {
				await tick();
				picker?.form?.querySelector('textarea')?.focus();
			});
		}).pipe(Effect.ensuring(Effect.sync(() => { restart_pending = false; }))));
	}

	function revise(row: AgentRow): void {
		if (revision_pending) return;
		stored_files = [...(row.files ?? [])];
		attached = [];
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
							stored_files = [];
							attached = [];
							draft = '';
						}
					})
				),
				Effect.asVoid
			)
		);
	}
	/** Moves one queued message to `to` (0 is next): a reorder, never a new post. */
	function moveTo(i: number, to: number): void {
		if (conversation === null || to < 0 || to >= queued.length || to === i) return;
		const ids = queued.map((r) => r.id);
		// a message still posting has no stored id yet; it takes its place once the post answers
		if (ids.some((id) => id.startsWith('local:'))) return;
		const [selected] = ids.splice(i, 1);
		if (selected === undefined) return;
		ids.splice(to, 0, selected);
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
	/** A local message still posting: hide it now, and dequeue its stored row when the post answers. */
	function cancelLocal(row: OutboxRow): void {
		outbox.cancel(row);
		if (row.stored !== undefined) dequeue({ ...row, id: row.stored });
	}

	const meter = $derived(context_meter(rows));

	// a posted message is working while it waits in the queue for a turn (then the status says so); a triaged one awaiting
	// its decision is waiting, and a cancelled one (a stop) is gone
	const posted = $derived(sent === null ? undefined : rows.find((r) => r.id === sent));
	const orb = $derived(
		orbState({ status, rows, pending: posted?.state === 'queued', failed: sendFailed })
	);
	// The viewport starts at the bottom; its single list keeps chronological DOM order. Opening and streaming need no animated scroll.
	let port = $state<HTMLElement | null>(null);
	let pinned = $state(true);
	/** The page of messages before the loaded ones, prepended with the reader's place kept. */
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
						top = own.scrollTop;
					older = [...answer.success.rows, ...older];
					edge = { first: answer.success.first, more: answer.success.more };
					return { own, top };
				});
				if (shown === null) return;
				yield* Effect.tryPromise({
					try: () => tick(),
					catch: (cause) =>
						new AgentPanelFailed({ message: t('The transcript could not be rendered.'), cause })
				});
				yield* Effect.sync(() => {
					if (id === conversation && port === shown.own)
						shown.own.scrollTop = shown.top;
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
	function latest(): void {
		pinned = true;
		port?.scrollTo({ top: 0, behavior: 'instant' });
	}
	/** A stored file's link (a made file's card, a workspace screenshot). */
	const fileHref = (id: string) => bolt.file_url({ id });
	// Preview and Session are independent panels, opened by their own header controls.
	let previewing = $state(false),
		seenPreview = $state<string | null>(null);
	const recordedPreview = $derived(previewsOf(rows).at(-1) ?? null);
	const hasTestStep = $derived(
		rows.some(
			(row) =>
				row.tool?.name === 'workspace_test' ||
				(row.tool?.name === 'workspace_diagnose' && row.tool.args?.includes('"preview"') !== true)
		)
	);
	let previewStudio = $state<StudioView | null>(null);
	const shownPreview = $derived(
		recordedPreview === null
			? null
			: previewStudio === null
				? recordedPreview
				: currentPreview(recordedPreview, previewStudio)
	);
	const showingPreview = $derived(previewing && (shownPreview !== null || hasTestStep) && !thread);
	// The host is usually a 40rem sheet; keep the transcript intact beneath its session view.
	const railOverlay = $derived(panelRemWidth < 64);
	const previewOverlay = $derived(panelRemWidth < 88);
	watch(
		() => (showingPreview ? (recordedPreview?.key ?? 'tests') : undefined),
		(key) => {
			previewStudio = null;
			if (key === undefined) return;
			dispatch(
				api.studio().pipe(
					Effect.tap((state) =>
						Effect.sync(() => {
							if ((recordedPreview?.key ?? 'tests') === key && showingPreview)
								previewStudio = state;
						})
					),
					// Hosts without Studio keep the recorded preview.
					Effect.catch(() => Effect.void),
					Effect.asVoid
				)
			);
		}
	);
	const previewEvents = attachEffect(() =>
		typeof EventSource === 'undefined'
			? Effect.void
			: studio_events().pipe(
					Stream.runForEach((frame) =>
						frame.kind === 'tests' || frame.kind === 'source' || frame.kind === 'change'
							? api.studio().pipe(
									Effect.tap((state) =>
										Effect.sync(() => {
											previewStudio = state;
										})
									),
									Effect.asVoid
								)
							: Effect.void
					),
					Effect.catch(() => Effect.void)
				)
	);
	watch(
		() => (showingPreview ? (shownPreview?.key ?? null) : null),
		(key) => {
			if (key !== null) seenPreview = key;
		}
	);
	function closePreview(): void {
		previewing = false;
		previewToggle?.focus({ preventScroll: true });
	}
	async function togglePreview(): Promise<void> {
		if (showingPreview) return closePreview();
		previewing = true;
		focus = null;
		rail = false;
		await tick();
		previewEl
			?.querySelector<HTMLButtonElement>('[data-preview-close]')
			?.focus({ preventScroll: true });
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
</script>

{#snippet selectorFooter()}
	<div
		class="flex min-w-0 items-center gap-2 border-t border-border px-2 py-1 text-tiny text-muted-foreground"
		data-agent-views
	>
		<span class="shrink-0 whitespace-nowrap pointer-coarse:hidden" title={t('Switch views')}
			>{shortcutLabel('→')}</span
		>
		<div
			class="flex min-w-0 max-w-[40%] items-center overflow-x-auto"
			role="group"
			aria-label={t('Conversation views')}
		>
			{#each tabs as view (view.name)}
				<button
					type="button"
					class="grid size-6 shrink-0 place-items-center rounded-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label={t('Switch to {view}').replace('{view}', view.title)}
					title={`${view.title} · ${view.count}`}
					aria-pressed={view.name === shownTab}
					onclick={() => (tab = view.name)}
				>
					<span
						class="rounded-full {view.name === shownTab
							? 'size-1.5 bg-muted-foreground'
							: 'size-1 bg-muted-foreground/40'}"
					></span>
				</button>
			{/each}
		</div>
		<div
			class="ml-auto flex min-w-0 max-w-[35%] items-center justify-end gap-1.5 whitespace-nowrap"
			aria-live="polite"
			data-agent-view
		>
			{#if shownTab !== 'web'}<span class="flex shrink-0 items-center" data-agent-tab-read-only
					><Icon name="lucide:lock" class="size-3" /><span class="sr-only">{t('Read only')}</span
					></span
				>{/if}
			<span class="truncate">{currentView.title}</span><span class="sr-only"
				>{currentView.count}</span
			>
		</div>
	</div>
{/snippet}
{#snippet selectorEmpty()}
	<div
		class="flex min-h-20 items-center justify-center gap-3 px-3 py-4 text-muted-foreground"
		role="status"
		data-agent-empty
	>
		<Icon name="lucide:message-square" class="size-5 shrink-0 opacity-60" />
		<div class="space-y-1">
			<p class="text-xs">
				{query.trim() ? t('No conversations found') : t('No conversations yet')}
			</p>
			<p class="text-tiny">
				{query.trim() ? t('Try another search.') : t('Start a conversation to see it here.')}
			</p>
		</div>
	</div>
{/snippet}
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
		<span class="shrink-0 text-sm font-semibold max-md:hidden">{t('Norbius')}</span>
		<Combobox
			variant="ghost"
			searchable
			class="min-w-0 flex-1"
			{options}
			value={conversation}
			{...current === undefined ? {} : { display: nameOf(current) }}
			placeholder={list.length === 0 ? t('No conversations yet') : t('New conversation')}
			aria-label={t('Conversations')}
			on_search={(q) => (query = q)}
			on_open_change={(open) => {
				if (open) tab = current === undefined ? 'web' : tabOf(current);
			}}
			footer={selectorFooter}
			empty={selectorEmpty}
			onkeydown={viewShortcut}
			on_change={(id) => (id === null ? fresh() : select(id))}
		/>
		{#if (shownPreview !== null || hasTestStep) && !thread}<Button
				bind:ref={previewToggle}
				size="icon"
				variant="ghost"
				class="relative shrink-0"
				aria-label={t(
					shownPreview === null
						? 'Tests'
						: shownPreview.key === seenPreview
							? 'Preview'
							: 'New preview'
				)}
				title={t(
					shownPreview === null
						? 'Tests'
						: shownPreview.key === seenPreview
							? 'Preview'
							: 'New preview'
				)}
				aria-pressed={showingPreview}
				onclick={togglePreview}
				data-open-preview
				><Icon
					name={shownPreview === null ? 'lucide:flask-conical' : 'lucide:eye'}
					class="size-4"
				/>{#if shownPreview !== null && shownPreview.key !== seenPreview}<span
						class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
						data-preview-unseen
					></span>{/if}</Button
			>{/if}
		<Button
			bind:ref={railToggle}
			size="icon"
			variant="ghost"
			class="shrink-0"
			aria-label={t('Session')}
			title={t('Session')}
			aria-pressed={rail}
			onclick={() => (rail ? closeRail() : openRail())}
			data-rail-toggle><Icon name="lucide:sliders-horizontal" class="size-4" /></Button
		>
		<Button
			size="icon"
			variant="ghost"
			class="shrink-0"
			aria-label={t('New conversation')}
			title={t('New conversation')}
			onclick={fresh}><Icon name="lucide:plus" class="size-4" /></Button
		>
	</Inline>
{/snippet}

{#snippet preview()}
	<aside
		bind:this={previewEl}
		transition:sessionMotion={{ x: 6, duration: 160 }}
		class="absolute inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col overflow-hidden border-l border-border bg-background @min-[88rem]:relative @min-[88rem]:w-[56rem] @min-[88rem]:shrink-0"
		aria-label={t('Preview')}
		data-agent-preview={shownPreview?.url ?? 'tests'}
		{@attach previewEvents}
	>
		<!-- the bundle is the frame's version: another bundle (or a rebuild) reloads it, the same one never does -->
		<PreviewFrame
			src={shownPreview?.url ?? null}
			tests={previewStudio?.tests}
			version={shownPreview?.key}
			title={t('Preview')}
			label={shownPreview?.about?.['message']}
			{t}
			on_close={closePreview}
		>
			{#snippet details()}
				{#if shownPreview?.about !== undefined}<p data-preview-caption>
						{captionOf(shownPreview.about, zone)}
					</p>{:else}<p>{shownPreview?.url ?? t('No preview yet.')}</p>{/if}
			{/snippet}
		</PreviewFrame>
	</aside>
{/snippet}

<!-- hook:agent-ui — the panel is one card surface edge to edge (the sheet's body padding given back); the transcript and the composer
	share one responsive conversation column -->
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
			inert={(rail && railOverlay) || (showingPreview && previewOverlay)}
			data-agent-chat
		>
			<div class="relative flex min-h-0 w-full flex-1 flex-col">
				<div class="flex h-full min-h-0 w-full flex-col">
					{#if current?.plan && current.plan.status !== 'draft'}<PlanCards plan={current.plan} place="current" {starting} {empty} running={status === 'running'} on_revise={() => (mode = 'plan')} on_execute={() => plan(true)} on_discard={() => status === 'running' ? (confirming = 'plan') : plan(false)} {t} />{/if}
					<Transcript {api} {t} {zone} {admin} {conversation} {rows} {status} {sent} {thread} {automation}
						goals={current?.goals} plan={current?.plan} {before} loading_older={loadingOlder} load_older={loadOlder}
						bind:port bind:pinned {latest} load_failed={transcript.error !== undefined} on_retry={() => fork(transcript.refetch())}
						decision_frame={$transcript === undefined ? undefined : `${$transcript.rows.length}:${$transcript.rows.at(-1)?.id}`}
						{dispatch} on_error={(problem) => (error = problem)} file_href={fileHref} model_label={modelLabel}
						on_revise={revise} {revision_pending} on_restart={restart_chat}
						restart={{ from: restart_from?.id ?? null, pending: restart_pending, error: restart_error }} />
				</div>
			</div>
			{#if thread || automation}
				<p
					class="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground"
					data-agent-read-only
				>
					{automation
						? t("Read-only — an automation run's transcript, recorded as it ran.")
						: t('Read-only — {envoy} answers this channel conversation.').replace(
								'{envoy}',
								current === undefined ? t('its envoy') : envoyName(current)
							)}
				</p>
			{:else}
				{#if drafting && current?.plan}<PlanCards plan={current.plan} place="draft" {starting} {empty} running={status === 'running'} on_revise={() => (mode = 'plan')} on_execute={() => plan(true)} on_discard={() => plan(false)} {t} />{/if}
				<Composer {t} {unconfigured} {status} {rows} {queued} bind:draft bind:mode bind:attached bind:stored_files bind:revising bind:picker
					{revision_pending} {drafting} {empty} {error} {models} chosen_model={chosenModel} on_pick_model={pickModel}
					{meter} {catalog} {read} {nav} {entries} file_href={fileHref}
					on_attach={attach} on_send={send} on_revise={revise} on_dequeue={dequeue} on_cancel_local={cancelLocal} on_move={moveTo}
					on_open_rail={openRail} on_stop={() => (confirming = 'stop')} on_resume={() => control(false)} />
			{/if}
		</div>
		<SessionRail {rail} bind:rail_el={railEl} bind:focus bind:navigating {conversation} {rows} {inputs} {outputs} {thread} {automation}
			attached_count={attached.length} {meter} model={chosenModel} model_label={chosenModel === null ? '' : modelLabel(chosenModel)} {connectors} {bolt} {api}
			control={childControl} {dispatch} on_close={closeRail} on_attach={() => picker?.click()} on_create_file={createFile}
			motion={sessionMotion} file_href={fileHref} {t} />
		{#if showingPreview}{@render preview()}{/if}
	</div>
</div>

<svelte:document onkeydown={railKeydown} />

<!-- Ask before stopping a response, and before deleting a plan while it runs -->
<Dialog.Root
	open={confirming !== null}
	on_open_change={(o) => {
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
	[data-agent-chat] {
		--agent-column-width: 68rem;
	}

</style>
