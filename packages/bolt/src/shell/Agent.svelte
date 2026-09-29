<!--
	The in-app agent panel (§5.9, rules 58, 59): one conversation per tab, the transcript with each reply's receipts,
	a confirmation card for a held call, and the running turn's text as it streams. Posting answers at once; the turn
	runs after it, and everything it writes (the reply growing flush by flush, each tool call running then finished) is
	rows of the conversation's live transcript, patched in over the page's one live stream; the conversation list, each
	one's status, plan and goals are a live read too. Nothing polls and there is no second stream. Enter sends, Shift+Enter is a
	new line, Cmd/Ctrl+Enter sends now. With triage (rule 60a, P41) each triaged row carries its state: "waiting for
	more…" while pending (with respond-now), "responding" once admitted and its turn runs, and, in a shared conversation
	only, "not for Norbius" for an ambient row. Files are attached with the paperclip, by paste
	or by drop (at most 8 files, 20 MiB); each uploads to `/__bolt/files/sys_message.files` when the message is sent.
	The selector switches between the member's own conversations (newest first); a delegated sub-agent's steps and answer
	open in place; messages sent while a turn runs wait in the queue (edit, move up, remove); the context meter reads the
	last reply's usage; the transcript follows its tail unless the reader scrolled up ("Latest" returns); a running turn
	stops (asked first) and a stopped one resumes; a draft plan is a collapsed card above the prompt (execute, delete), an
	executed plan and the goals a strip above the transcript, and an executed plan or a checkpoint heads the transcript as
	staging's context segment (Summary, and the Transcript before it). The composer has no box: one top border.
	While a turn runs the accretion disc is the orb and an empty reply counts its seconds; plain Tab toggles plan mode;
	what the model no longer reads (summarized into the latest checkpoint, or before an executed plan) is dimmed behind the
	segment's Transcript tab; the orb names the conversation's state; reasoning streams above the reply and stays on it, folded; a
	cut reply that no turn continues is marked interrupted; a divider names the model where it changed. Consecutive
	tool calls and reasoning fold into one "Worked for Ns" group whose rows (verb, target, duration) open to their input
	and result, one tab each; a failed row's icon is the alert, so the call that failed reads at a glance. Code blocks copy. The open conversation is the shell's `?agent=` (`onConversation` reports a switch). An
	envoy's channel conversation is read-only here (rule 61): its transcript, and no composer or controls at all.
-->
<script lang="ts">
	import { getContext, onDestroy, tick, type Snippet } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { watch } from 'runed';
	import { Inline } from '@norbital-ai/ui/layout';
	import { AccretionDisc, NorbiusStrip } from '@norbital-ai/ui/brand';
	import { Button, Combobox, Dialog, Icon, MarkdownEditor, Popover, Progress, ReadonlyMarkdown, Spinner, Tabs, Tooltip, pickerRead, useKinds, virtualList, type CommandItem } from '@norbital-ai/ui';
	import type { FileRef, Json } from '../decl/values.ts';
	import type { Usage } from '../engine/agent/schema.ts';
	import type { AiModel } from '../engine/contracts.ts';
	import type { AgentConversation, AgentRow } from '../protocol/wire.ts';
	import type { AgentRequest, ShellApi, ShellBolt } from './runtime.ts';
	import AgentChild from './AgentChild.svelte';
	import { checkpointSections, contextView, modelDividers, ORB, orbState, revisable } from './agent-view.ts';

	let { api, bolt, t, request, unconfigured = false, onConversation }: { api: ShellApi; bolt: Pick<ShellBolt, 'live' | 'fileUrl'>; t: (key: string) => string; request: AgentRequest; onClose: () => void;
		/** The host binds no AI provider: say so plainly (a send still fails with the fixed reply and an `agent.failed` event). */ unconfigured?: boolean;
		/** The open conversation changed (`null`: a new one), for the shell's `?agent=`. */ onConversation?: (id: string | null) => void } = $props();

	const KEY = 'bolt.agent.conversation';
	const remembered = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();
	// svelte-ignore state_referenced_locally
	let conversation = $state<string | null>(request.conversation === undefined ? remembered : request.conversation);
	// the transcript loads lazily: a live window of the latest messages (`from` its first seq; null: the whole conversation),
	// and older pages read once as the reader scrolls up (`edge`: the first seq read and whether more lie before it)
	const WINDOW = 60, OLDER = 50;
	let live = $state<AgentRow[]>([]), older = $state<AgentRow[]>([]);
	/** The open conversation is an envoy's channel thread: read-only (rule 61). */
	let thread = $state(false);
	let from = $state<number | null>(null), edge = $state<{ first: number; more: boolean } | null>(null), loadingOlder = $state(false);
	/**
	 * Messages this panel sent that the live transcript does not carry yet: shown at once (a bubble, or in the queue while a
	 * turn runs), each until the stored row it became arrives. A failed send leaves the outbox and returns to the composer.
	 */
	let outbox = $state<(AgentRow & { stored?: string })[]>([]);
	const rows = $derived([...older, ...live, ...outbox]);
	const before = $derived(from === null ? null : edge === null ? from : edge.more ? edge.first : null);
	/** The tool steps the reader opened: only those render their input and result. */
	const opened = new SvelteSet<string>();
	/** Which of a step's two panes is up: its input, or the result that carries the failure. */
	const pane = new SvelteMap<string, 'input' | 'output'>();
	/** L-BOLT-436: the message this panel just posted (working while it waits in the queue), and a send this panel saw fail. */
	let sent = $state<string | null>(null), sendFailed = $state(false);
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
	const BY_EXTENSION: { readonly [ext: string]: string } = { heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		...Object.fromEntries(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'yaml', 'yml'].map((e) => [e, 'text/plain'])) };
	function attach(files: readonly File[]): void {
		const typed = files.map((f) => f.type !== '' ? f : new File([f], f.name, { type: BY_EXTENSION[f.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? '' }));
		const all = [...attached, ...typed];
		if (typed.some((f) => f.type === '' || f.size === 0)) return void (error = t('Attach a nonempty image, PDF, DOCX, XLSX or text document.'));
		if (all.length > 8 || all.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024) return void (error = t('Attach at most 8 files totaling 20 MiB.'));
		error = null;
		attached = all;
	}
	function paste(event: ClipboardEvent): void {
		const files = [...event.clipboardData?.files ?? []];
		if (files.length === 0) return;
		event.preventDefault();
		attach(files);
	}
	function drop(event: DragEvent): void {
		event.preventDefault();
		attach([...event.dataTransfer?.files ?? []]);
	}

	/** The member's own conversations (the selector, and the open one's status, plan, goals and model): a live read. */
	let list = $state<AgentConversation[]>([]);
	let models = $state<AiModel[]>([]);
	/** The model a new conversation runs when none is picked (the host's default). */
	let modelDefault = $state<string | null>(null);
	/** The model a new conversation starts on; an open one's is its own. */
	let picked = $state<string | null>(null);
	const current = $derived(list.find((c) => c.id === conversation));
	const status = $derived(current?.status ?? 'idle');
	// svelte-ignore state_referenced_locally
	const conversations = bolt.live<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] },
		then: (ok, bad) => Promise.reject<{ rows: AgentConversation[] }>(new Error('the conversations are read live')).then(ok, bad) });
	onDestroy(conversations.subscribe((value) => { if (value !== undefined) list = value.rows; }));
	// svelte-ignore state_referenced_locally
	void api.agent.models().then((r) => {
		if (!r.ok) return void (error = r.error.message);
		models = r.value.models;
		modelDefault = r.value.default;
	});
	const refused = (r: Awaited<ReturnType<ShellApi['agent']['stop']>>) => !r.ok ? r.error.message : r.value.kind === 'refused' ? r.value.message : null;

	// the transcript is a live read of the conversation's messages: each written or rewritten row (a streaming reply's
	// every flush included) arrives as a patch on the page's one live stream
	watch(() => conversation, (id) => {
		onConversation?.(id);
		thread = false;
		if (id === null) return;
		const transcript = bolt.live<{ rows: AgentRow[]; from?: number; thread?: true }>({ read: { m: 'transcript', a: [id, { tail: WINDOW }] },
			then: (ok, bad) => Promise.reject<{ rows: AgentRow[] }>(new Error('the transcript is read live')).then(ok, bad) });
		return transcript.subscribe((value) => {
			if (transcript.error?.code === 'notFound') return fresh();
			if (value !== undefined) {
				live = value.rows; from = value.from ?? null; thread = value.thread === true;
				// a sent message leaves the outbox once its stored row has arrived (and stays gone if that row is later cancelled)
				if (outbox.some((o) => o.stored !== undefined && value.rows.some((r) => r.id === o.stored)))
					outbox = outbox.filter((o) => o.stored === undefined || !value.rows.some((r) => r.id === o.stored));
			}
		});
	});
	// the shell's `?agent=` moved (back, forward, a link) while the panel is open
	watch(() => request.conversation, (id) => { if (id !== undefined && id !== conversation) { if (id === null) fresh(); else select(id); } }, { lazy: true });

	async function send(event: SubmitEvent | KeyboardEvent, now = false): Promise<void> {
		event.preventDefault();
		const text = draft.trim() || (mode === 'compact' ? '/compact' : '');
		if (text === '' && attached.length === 0) return;
		error = null;
		pinned = true;
		if (revising !== null) { // a queued message is edited in place; a delivered one is superseded by the revision (sys_message.revise)
			error = refused(await api.agent.revise(revising.id, text));
			if (error === null) { draft = ''; revising = null; }
			return;
		}
		const about = request.about === undefined ? '' : `(${t('About')} ${request.about.collection}/${request.about.id}) `;
		const files = attached, sentMode = mode === 'compact' ? 'compact' : planning ? 'plan' : undefined;
		// on screen before any round trip: the conversation's creation and the post follow behind it
		const local = `local:${crypto.randomUUID()}`;
		outbox.push({ id: local, seq: Number.MAX_SAFE_INTEGER, role: 'user', text: about + text, state: status === 'running' ? 'queued' : null, tag: null,
			files: files.map((f) => ({ name: f.name, mime: f.type })) });
		draft = '';
		attached = [];
		if (mode === 'compact') mode = null;
		const failed = (message: string) => {
			outbox = outbox.filter((o) => o.id !== local);
			draft = text;
			attached = files;
			error = message;
		};
		let id = conversation;
		if (id === null) {
			const s = await api.agent.start(text.split('\n')[0]!.slice(0, 80) || undefined, picked ?? undefined);
			if (!s.ok || s.value.kind !== 'committed') return failed(s.ok ? (s.value.kind === 'refused' ? s.value.message : t('The request failed.')) : s.error.message);
			id = String((s.value.output as { id: string }).id);
			try { sessionStorage.setItem(KEY, id); } catch { /* private window */ }
			conversation = id;
			picked = null;
		}
		const refs: Json[] = [];
		for (const file of files) {
			const u = await api.agent.upload(file);
			if (!u.ok) return failed(`${file.name}: ${u.error.message}`);
			refs.push(u.value);
		}
		const r = await api.agent.post(id, about + text, now, refs, sentMode);
		sendFailed = !r.ok || r.value.kind === 'refused';
		if (!r.ok) return failed(r.error.message);
		if (r.value.kind === 'refused') return failed(r.value.message);
		sent = r.value.kind === 'committed' ? String((r.value.output as { id?: unknown } | null)?.id ?? '') : null;
		// the stored row may already be here (the live patch can beat the post's answer)
		outbox = sent === null || sent === '' || live.some((r) => r.id === sent) ? outbox.filter((o) => o.id !== local)
			: outbox.map((o) => o.id === local ? { ...o, stored: sent! } : o);
	}
	async function confirm(row: AgentRow, approve: boolean): Promise<void> {
		const r = await api.agent.confirm(row.id, approve);
		error = !r.ok ? r.error.message : r.value.kind === 'refused' ? r.value.message : null;
	}
	const empty = $derived(draft.trim() === '' && attached.length === 0);
	const lastPending = $derived(rows.findLast((r) => r.state === 'pending')?.id);
	const lastReply = $derived(rows.findLastIndex((r) => r.role === 'assistant'));
	/** P41: a shared conversation (more than one member posted) is a group view; only there is an ambient row labelled. */
	const shared = $derived(new Set(rows.filter((r) => r.role === 'user').map((r) => r.author ?? '')).size > 1);
	/** A triaged row's state (rule 60a), derived from the engine's markers and the turn's status; no label once it settles. */
	function triageLabel(row: AgentRow, i: number): string | null {
		if (row.state === 'pending') return t('waiting for more…');
		if (row.tag === 'ambient') return shared ? t('not for Norbius') : null;
		return status === 'running' && row.state === 'consumed' && i > lastReply ? t('responding') : null;
	}
	async function respondNow(): Promise<void> {
		if (conversation === null) return;
		const r = await api.agent.respondNow(conversation);
		error = !r.ok ? r.error.message : r.value.kind === 'refused' ? r.value.message : null;
	}
	function keydown(event: KeyboardEvent): void {
		// plain Tab toggles plan mode (L-BOLT-541); an open `/` or `@` menu takes Tab first, a modified Tab moves focus
		if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
			event.preventDefault();
			if (!planLocked) mode = mode === 'plan' ? null : 'plan';
			return;
		}
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		void send(event, event.metaKey || event.ctrlKey);
	}
	function fresh(): void {
		conversation = null;
		live = [];
		older = [];
		from = null;
		edge = null;
		opened.clear();
		outbox = [];
		sent = null;
		sendFailed = false;
		revising = null;
		mode = null;
		pinned = true;
		try { sessionStorage.removeItem(KEY); } catch { /* private window */ }
	}
	function select(id: string): void {
		if (id === conversation) return;
		fresh();
		conversation = id;
		try { sessionStorage.setItem(KEY, id); } catch { /* private window */ }
	}
	const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const options = $derived(list.map((c) => ({ value: c.id, label: c.title ?? t('Conversation'), description: when(c.at) })));
	// the host's models by human label, grouped by provider; a conversation on a class (`default`) shows the host's default
	const modelOptions = $derived([...models].sort((a, b) => (a.provider ?? '').localeCompare(b.provider ?? '') || a.label.localeCompare(b.label))
		.map((m) => ({ value: m.id, label: m.label, keywords: m.id, ...(m.provider === undefined ? {} : { group: m.provider }) })));
	const chosenModel = $derived.by(() => {
		const id = current?.model ?? picked ?? modelDefault;
		return models.some((m) => m.id === id) ? id : models.some((m) => m.id === modelDefault) ? modelDefault : null;
	});
	const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id;
	async function pickModel(model: string | null): Promise<void> {
		if (model === null) return;
		if (conversation === null) return void (picked = model);
		error = refused(await api.agent.setModel(conversation, model));
	}

	// stop and resume (a stop cancels what was queued; resume recalls the stopped work)
	async function control(stop: boolean): Promise<void> {
		if (conversation === null) return;
		error = refused(await (stop ? api.agent.stop(conversation) : api.agent.resume(conversation)));
	}
	/** Execute starts the draft (plan mode ends with it); delete drops the plan. */
	async function plan(execute: boolean): Promise<void> {
		if (conversation === null) return;
		starting = execute;
		error = refused(await (execute ? api.agent.executePlan(conversation) : api.agent.discardPlan(conversation)));
		starting = false;
		if (error === null) mode = null;
	}
	let starting = $state(false), draftOpen = $state(false);
	/** Staging asks before a stop, and before deleting a plan that is running. */
	let confirming = $state<'stop' | 'plan' | null>(null);
	const drafting = $derived(current?.plan?.status === 'draft');
	const planLocked = $derived(drafting);
	const planning = $derived(mode === 'plan' || drafting);
	const planState = (p: NonNullable<AgentConversation['plan']>) => p.status === 'draft' ? t('Planning') : p.status === 'active' ? t('Executing') : t('Verified');
	const planTitle = (body: string) => (body.split('\n').find((l) => /^#{1,3}\s+\S/.test(l.trim())) ?? body.split('\n').find((l) => l.trim() !== '') ?? '').replace(/^#+\s*/, '').trim();

	// the queue: messages posted while a turn runs wait here until its next step takes them
	const queued = $derived(rows.filter((r) => r.role === 'user' && r.state === 'queued'));
	let revising = $state<AgentRow | null>(null);
	function revise(row: AgentRow): void {
		revising = row;
		draft = row.text ?? '';
		mode = null;
	}
	async function dequeue(row: AgentRow): Promise<void> {
		error = refused(await api.agent.dequeue(row.id));
		if (revising?.id === row.id) { revising = null; draft = ''; }
	}
	async function moveUp(i: number): Promise<void> {
		if (conversation === null) return;
		const ids = queued.map((r) => r.id);
		[ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
		error = refused(await api.agent.reorder(conversation, ids));
	}

	// the context meter: the last reply's context against its model's window, and what the conversation's turns cost
	const usages = $derived(rows.flatMap((r) => r.usage === undefined ? [] : [r.usage as unknown as Usage]));
	const meter = $derived.by(() => {
		const last = usages.findLast((u) => u.context !== undefined && u.window !== undefined);
		const costs = usages.filter((u) => typeof u.cost === 'number');
		return { percent: last === undefined ? null : Math.min(100, (last.context! / last.window!) * 100), context: last?.context, window: last?.window,
			tokens: usages.reduce((n, u) => n + u.input + u.output, 0), input: usages.reduce((n, u) => n + u.input, 0), output: usages.reduce((n, u) => n + u.output, 0),
			cost: costs.length === 0 ? null : costs.reduce((n, u) => n + u.cost!, 0) };
	});
	const k = (n: number | undefined) => n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	const usd = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);

	// the context view (L-BOLT-546): what the model no longer reads stays in the transcript, folded and dimmed
	const view = $derived(contextView(rows, current?.plan));
	const outside = (r: AgentRow) => view.outside.has(r.id);
	/** Staging's context segment: an executed plan or a checkpoint, with what came before it behind its Transcript tab. */
	const settled = $derived(current?.plan != null && current.plan.status !== 'draft' ? current.plan : null);
	const segment = $derived(settled !== null || view.checkpoint !== null);
	const segmentTitle = $derived(view.checkpoint === null ? t('Plan') : t('Compaction'));
	const ORIGIN = { manual: 'you asked for it', requested: 'the assistant asked for it', automatic: 'the context was full' } as const;
	const dividers = $derived(modelDividers(rows));
	// a posted message is working while it waits in the queue for a turn (then the status says so); a triaged one awaiting
	// its decision is waiting, and a cancelled one (a stop) is gone
	const posted = $derived(sent === null ? undefined : rows.find((r) => r.id === sent));
	const orb = $derived(orbState({ status, rows, pending: posted?.state === 'queued', failed: sendFailed }));
	/** A cut reply the turn did not continue (stopped, or its process died) is interrupted (L-BOLT-548). */
	const interrupted = (r: AgentRow) => r.tag === 'cut' && status !== 'running';
	// a running turn with no text yet counts its seconds (L-BOLT-548)
	let since = $state<number | null>(null), now = $state(Date.now());
	watch(() => status, (s) => {
		if (s !== 'running') return void (since = null);
		since = now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});
	const thinking = $derived(since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000)));

	// the transcript follows its tail while the reader is there; a scroll up (only the reader scrolls up) pauses it and
	// "Jump to latest" returns; reaching the tail again resumes it
	let port = $state<HTMLOListElement | null>(null);
	let pinned = $state(true);
	let lastTop = 0;
	const atTail = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop <= 32;
	/** The page of messages before the loaded ones, prepended with the reader's place kept. */
	async function loadOlder(): Promise<void> {
		const id = conversation, at = before;
		if (loadingOlder || id === null || at === null) return;
		loadingOlder = true;
		const r = await api.agent.older(id, at, OLDER);
		loadingOlder = false;
		if (!r.ok || id !== conversation || port === null) return;
		const fromBottom = port.scrollHeight - port.scrollTop;
		older = [...r.value.rows, ...older];
		edge = { first: r.value.first, more: r.value.more };
		await tick();
		port.scrollTop = port.scrollHeight - fromBottom;
	}
	function scrolled(): void {
		if (port === null) return;
		if (port.scrollTop < 240) void loadOlder();
		if (port.scrollTop < lastTop - 2) pinned = false;
		else if (atTail(port)) pinned = true;
		lastTop = port.scrollTop;
	}
	function latest(smooth = true): void {
		pinned = true;
		port?.scrollTo({ top: port.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
	}
	watch(() => [rows, status], () => { void tick().then(() => { if (pinned) latest(); }); });
	/** A row shown on its own: a person's message, a confirmation card, a reply's text, a checkpoint or a verdict. */
	const shown = (r: AgentRow) => (r.role === 'user' && r.state !== 'queued') || (r.state === 'confirm' && r.call !== undefined) || (r.role === 'assistant' && !!r.text)
		|| (r.role === 'system' && (r.tag === 'compact' || r.tag === 'verdict') && !!r.text);
	// the work between two messages folds into one group, Codex-style: each tool call and each piece of reasoning (a
	// reply's own reasoning included, ahead of its text) is a step; a message, a reply's text or a card ends the group.
	// A sub-agent's spawn is never folded: its row is the conversation it started. Rows behind the context boundary live
	// in the context segment (L-BOLT-546).
	type Item = { row: AgentRow; index: number } | { steps: AgentRow[] };
	const items = $derived(rows.reduce<Item[]>((out, row, index) => {
		const last = out.at(-1);
		if (view.history.has(row.id)) return out;
		if (row.tool?.child !== undefined) { out.push({ row, index }); return out; }
		if (row.tool !== undefined || (row.role === 'assistant' && !!row.reasoning)) { if (last !== undefined && 'steps' in last) last.steps.push(row); else out.push({ steps: [row] }); }
		if (row.tool === undefined && shown(row)) out.push({ row, index });
		return out;
	}, []));
	// a long conversation windows its items (measured, keyed by their first row) inside the transcript's scroll port
	const itemKey = (i: number) => { const it = items[i]!; return 'row' in it ? it.row.id : `steps:${it.steps[0]!.id}`; };
	const turns = virtualList({ count: () => items.length, key: itemKey, estimate: 56 });
	/** A step still being written: a running call, or reasoning whose reply is still streaming. */
	const active = (s: AgentRow) => s.tool?.running === true || s.state === 'streaming';
	/** The group's wall time: its first step's start to its last step's end (a call's `ms`), whole seconds. */
	function worked(steps: readonly AgentRow[]): number | null {
		const first = steps[0]?.at, last = steps.at(-1)!;
		if (first === undefined || last.at === undefined) return null;
		return Math.max(1, Math.round((Date.parse(last.at) + (last.tool?.ms ?? 0) - Date.parse(first)) / 1000));
	}
	/** A step's verb, target and icon: the tool's name in words and the first plain value of its input. */
	function stepOf(s: AgentRow): { verb: string; target: string; icon: string } {
		if (s.tool === undefined) return { verb: t('Thought'), target: '', icon: 'lucide:brain' };
		const name = s.tool.name, verb = name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
		let target = '';
		try {
			const input = JSON.parse(s.tool.args ?? 'null') as unknown;
			const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as { readonly [k: string]: unknown } : {};
			const pick = ['path', 'file', 'query', 'collection', 'callable', 'url', 'name', 'q', 'text', 'id'].map((k) => o[k]).find((v) => typeof v === 'string')
				?? Object.values(o).find((v) => typeof v === 'string') ?? (typeof input === 'string' ? input : '');
			target = String(pick).split('\n')[0]!.slice(0, 80);
		} catch { target = ''; }
		const icon = s.tool.running ? 'lucide:loader' : s.tool.failed ? 'lucide:circle-alert'
			: /search|find|query|read|list|get|context/.test(name) ? 'lucide:search' : /write|edit|create|update|delete|upsert|perform|act/.test(name) ? 'lucide:pencil'
			: /web|fetch|url|browse/.test(name) ? 'lucide:globe' : /plan|goal|todo/.test(name) ? 'lucide:list-checks' : 'lucide:wrench';
		return { verb, target, icon };
	}
	const seconds = (ms: number) => ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
	// a turn under way that has written nothing yet: "Thinking…" with its seconds
	const quiet = $derived(status === 'running' && !rows.some((r) => r.state === 'streaming' || r.state === 'running'));
	/** Each code block of a reply gets a copy button (the Markdown renders plain `pre`; this re-adds it after each render). */
	function copyable(el: HTMLElement): () => void {
		const add = () => {
			for (const pre of el.querySelectorAll('pre')) {
				if (pre.querySelector('[data-copy]') !== null) continue;
				pre.classList.add('relative', 'group/code');
				const b = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Copy') });
				b.dataset['copy'] = '';
				b.className = 'absolute top-1.5 right-1.5 rounded-md bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-foreground';
				b.onclick = () => {
					void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? '').then(() => { b.textContent = t('Copied'); setTimeout(() => (b.textContent = t('Copy')), 1500); });
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
		{ id: 'plan', label: '/plan', description: t('Plan first; you approve before it acts'), icon: 'lucide:list-checks', run: () => (mode = 'plan') },
		{ id: 'compact', label: '/compact', description: t('Summarize the conversation into a checkpoint'), icon: 'lucide:shrink', run: () => (mode = 'compact') },
		{ id: 'export', label: '/export', description: t('Download this conversation as Markdown'), icon: 'lucide:download', run: exportTranscript }
	]);
	function exportTranscript(): void {
		const text = rows.filter((r) => r.text).map((r) => `**${r.role}**: ${r.text}`).join('\n\n');
		const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: 'conversation.md' });
		a.click();
		URL.revokeObjectURL(a.href);
	}
	const kinds = useKinds();
	async function mentions(q: string): Promise<CommandItem[]> {
		const slash = q.indexOf('/');
		if (slash === -1) return Object.keys(kinds.catalog ?? {}).filter((c) => !c.startsWith('sys_') && c.toLowerCase().includes(q.toLowerCase())).slice(0, 20)
			.map((c) => ({ id: c, label: c.replace(/_/g, ' '), icon: 'lucide:database', group: t('Collections'), insert: `@${c}/`, keep: true }));
		const c = q.slice(0, slash), target = kinds.catalog?.[c];
		if (target === undefined || kinds.read === undefined) return [];
		const page = await kinds.read(c, pickerRead(target, target.label, { limit: 8 }, q.slice(slash + 1)));
		return page.rows.map((r) => {
			const label = target.label.map((f) => r[f]).filter((x) => x !== null && x !== undefined && x !== '').join(' · ') || String(r['id']);
			return { id: String(r['id']), label, group: c.replace(/_/g, ' '), insert: `[@${label}](${c}/${String(r['id'])}) ` };
		});
	}
	// hook:view-ui — inside the shell's sheet the panel's header is the sheet's (one header: mark, title, conversations); the
	// sheet adds full screen and close, and its left edge resizes it
	const toSheet = getContext<((s: Snippet | null) => void) | undefined>(Symbol.for('ui.sheet.header'));
	$effect(() => {
		if (toSheet === undefined) return;
		toSheet(head);
		return () => toSheet(null);
	});
	type Receipt = { outcome: string; callable: string };
	const receiptsOf = (r: AgentRow) => (Array.isArray(r.receipts) ? r.receipts : []) as unknown as Receipt[];
</script>


{#snippet summaryTab()}
	<div class="h-full overflow-auto px-3 pb-3">
		<div class="grid gap-4 rounded-md bg-muted/30 p-3 text-sm">
			{#if view.checkpoint !== null}
				<!-- the model's own text: Markdown, never HTML -->
				<ReadonlyMarkdown value={checkpointSections(view.checkpoint.text ?? '')} />
				{#if view.origin !== null}<p class="text-xs text-muted-foreground">{t(ORIGIN[view.origin])}</p>{/if}
			{/if}
			{#if settled !== null}
				<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span>{t('Plan')} {settled.revision}</span><span class="flex-1">{planState(settled)}</span>
					{#if settled.status === 'active'}<Button size="sm" variant="ghost" disabled={!empty} onclick={() => (mode = 'plan')}>{t('Revise plan')}</Button>{/if}
					<Button size="sm" variant="ghost" onclick={() => (status === 'running' ? (confirming = 'plan') : plan(false))}>{t('Delete plan')}</Button>
				</div>
				<ReadonlyMarkdown value={settled.body} />
			{/if}
		</div>
	</div>
{/snippet}

{#snippet historyTab()}
	<ol class="h-full space-y-3 overflow-auto px-3 pb-3 text-sm" aria-label={t('Prior transcript')}>
		{#each rows.filter((r) => view.history.has(r.id) && r.id !== view.checkpoint?.id && (shown(r) || r.tool !== undefined)) as r (r.id)}
			<li class:opacity-50={outside(r)} data-outside-context={outside(r) || undefined} data-history-row>
				{#if r.tool !== undefined}{@const step = stepOf(r)}
					<span class="flex items-center gap-2 text-xs text-muted-foreground"><Icon name={step.icon} class="size-3.5 shrink-0" /><span class="font-medium">{step.verb}</span><span class="min-w-0 truncate font-mono text-[0.7rem]">{step.target}</span></span>
				{:else if r.role === 'user'}
					<p class="ml-auto w-fit max-w-[85%] rounded-[1.25rem] bg-muted px-4 py-2.5 break-words whitespace-pre-wrap">{r.text}</p>
				{:else}
					<ReadonlyMarkdown value={r.text ?? ''} />
				{/if}
			</li>
		{/each}
	</ol>
{/snippet}

{#snippet head()}
	<!-- staging's header: the mark, the name, the conversation picker as plain text, then new (the sheet adds full screen and close) -->
	<Inline gap="sm" class="w-full min-w-0" data-agent-head>
		<!-- the mark says the conversation's state; while a turn runs it is the accretion disc -->
		{#if orb === 'working'}<AccretionDisc size={20} label={t(ORB.working.label)} class="text-muted-foreground" />
		{:else}<span class="shrink-0" title={t(ORB[orb].label)} data-orb={orb}><NorbiusStrip state={orb === 'failed' ? 'error' : orb} size={18} label={t(ORB[orb].label)} /></span>{/if}
		<span class="shrink-0 text-sm font-semibold">{t('Norbius')}</span>
		<Combobox variant="ghost" searchable class="min-w-0 flex-1" {options} value={conversation} {...conversation === null ? {} : { display: t('Conversation') }}
			placeholder={list.length === 0 ? t('No conversations yet') : t('New conversation')} aria-label={t('Conversations')} onChange={(id) => (id === null ? fresh() : select(id))} />
		<Button size="icon" variant="ghost" class="size-8 shrink-0" aria-label={t('New conversation')} title={t('New conversation')} onclick={fresh}><Icon name="lucide:plus" class="size-4" /></Button>
	</Inline>
{/snippet}

<!-- hook:agent-ui — the panel is one card surface edge to edge (the sheet's body padding given back); the transcript and the composer
	keep staging's centred 48rem column -->
<div class="-m-4 flex h-[calc(100%+2rem)] min-h-0 flex-col bg-card" data-agent-panel>
	{#if toSheet === undefined}<div class="shrink-0 border-b px-4 py-2">{@render head()}</div>{/if}
	<div class="relative flex min-h-0 w-full flex-1 flex-col">
	{#if settled !== null || current?.goals?.length}
		<!-- staging's now strip: what the agent works from, kept in view while the transcript scrolls: the executed plan and
			its checklist, one line each; each opens over the transcript, not into it -->
		<div class="relative z-20 mx-auto w-full max-w-3xl shrink-0 px-4 pt-3" data-now-strip>
			<div class="grid gap-1 rounded-xl border border-border/70 bg-background/95 px-3 py-2 shadow-sm backdrop-blur">
				{#if settled !== null}
					<details class="group/plan" data-plan={settled.status}>
						<summary class="flex cursor-pointer list-none items-center gap-2 rounded text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
							<Icon name={settled.status === 'verified' ? 'lucide:circle-check' : 'lucide:notebook-pen'} class="size-3.5 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1 truncate font-medium">{planTitle(settled.body) || t('Plan')}</span>
							<span class="shrink-0 text-muted-foreground">{t('Plan')} {settled.revision} · {planState(settled)}</span>
						</summary>
						<div class="absolute inset-x-4 top-full mt-1 max-h-[50dvh] overflow-auto rounded-xl border border-border/70 bg-background px-3 py-2 text-xs shadow-lg">
							<ReadonlyMarkdown value={settled.body} />
						</div>
					</details>
				{/if}
				{#if current?.goals?.length}
					{@const goals = current.goals}
					{@const done = goals.filter((g) => g.status === 'done').length}
					<details class="group/todo" data-goals>
						<summary class="grid cursor-pointer list-none gap-1 rounded text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
							<span class="flex items-center gap-2">
								{#if done === goals.length}<Icon name="lucide:circle-check" class="size-3.5 shrink-0 text-muted-foreground" />
								{:else}<Spinner class="size-3.5 shrink-0" label={t('In progress')} />{/if}
								<span class="min-w-0 flex-1 truncate">{(goals.find((g) => g.status === 'doing') ?? goals.find((g) => g.status === 'pending'))?.text ?? t('All steps completed')}</span>
								<span class="shrink-0 text-muted-foreground tabular-nums">{done} / {goals.length}</span>
							</span>
							<Progress value={done} max={goals.length} class="h-1" aria-label={t('Goal progress')} />
						</summary>
						<ol class="absolute inset-x-4 top-full mt-1 grid max-h-[50dvh] gap-1 overflow-auto rounded-xl border border-border/70 bg-background px-3 py-2 text-xs shadow-lg" aria-label={t('Goal steps')}>
							{#each goals as g (g.id)}
								<li class="flex min-w-0 items-start gap-2" data-goal={g.status}>
									{#if g.status === 'done'}<Icon name="lucide:circle-check" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
									{:else if g.status === 'doing'}<Spinner class="mt-0.5 size-3.5 shrink-0" label={t('In progress')} />
									{:else}<Icon name="lucide:circle" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{/if}
									<span class="min-w-0 {g.status === 'done' ? 'text-muted-foreground line-through' : ''}">{g.text}</span>
								</li>
							{/each}
						</ol>
					</details>
				{/if}
			</div>
		</div>
	{/if}
	<!-- the scroll port spans the panel; its padding centres a readable column (Codex's) -->
	<ol bind:this={port} onscroll={scrolled} class="min-h-0 w-full flex-1 space-y-5 overflow-auto px-[max(1rem,calc((100%-46rem)/2),env(safe-area-inset-left))] py-4 text-sm leading-6" aria-live="polite" aria-label={t('Conversation transcript')}>
		{#if conversation === null && rows.length === 0 && status !== 'running' && sent === null}
			<li class="flex min-h-56 items-center justify-center text-center text-muted-foreground" data-agent-empty>
				<p class="max-w-sm">{t('Start a conversation. Ask for help or switch to Plan to work through an approach.')}</p>
			</li>
		{/if}
		{#if segment}
			<!-- staging's context segment: the executed plan or the latest checkpoint the agent continues from, and behind its
				Transcript tab everything before that boundary (what the model no longer reads is dimmed) -->
			<li class="min-w-0 border-b border-border pb-3" data-context-boundary={view.checkpoint === null ? 'plan' : 'compaction'}>
				<p class="flex items-center gap-2 py-2 text-xs font-medium text-muted-foreground">
					<span class="h-px flex-1 bg-border"></span><span>{segmentTitle}</span>
					<Tooltip text={view.checkpoint === null ? t('The agent continues from this plan and the messages below. Earlier messages are saved in Transcript.')
						: t('The agent continues from this summary and the messages below. Earlier messages are saved in Transcript.')} contentClass="max-w-72 text-xs">
						{#snippet trigger({ props })}<button {...props} type="button" aria-label={t('About this context')} class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><Icon name="lucide:info" class="size-3.5" /></button>{/snippet}
					</Tooltip>
					<span class="h-px flex-1 bg-border"></span>
				</p>
				<Tabs level={2} orientation="horizontal" class="h-80 max-h-[50dvh]" tabs={[
					{ name: 'summary', title: t('Summary'), icon: view.checkpoint === null ? 'lucide:notebook-pen' : 'lucide:scan-text', body: summaryTab, keepAlive: true },
					{ name: 'transcript', title: t('Transcript'), icon: 'lucide:messages-square', body: historyTab, keepAlive: true }]} />
			</li>
		{/if}
		{#if before !== null}
			<li class="flex justify-center" data-older>
				<button type="button" class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60" disabled={loadingOlder}
					onclick={() => void loadOlder()}>{loadingOlder ? t('Loading…') : t('Earlier messages')}</button>
			</li>
		{/if}
		{#if turns.on}<li aria-hidden="true" style="height:{turns.before}px" {@attach turns.anchor}></li>{/if}
		{#each turns.slice(items) as item, j (itemKey(turns.start + j))}
			{@const at = turns.start + j}
			{#if 'steps' in item}
				<!-- the work between two messages: one quiet line, open while it runs, each step opening to its input and result -->
				{@const working = status === 'running' && (at === items.length - 1 || item.steps.some(active))}
				{@const secs = worked(item.steps)}
				<li {@attach turns.measure(itemKey(at))} data-role="steps" data-failed={item.steps.some((s) => s.tool?.failed) || undefined}>
					<details class="group/work" open={working}>
						<summary class="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden" data-working={working || undefined}>
							{#if working}<span class="agent-shimmer">{t('Working…')}</span>{:else}<span>{t('Worked for')} {secs === null ? '' : `${secs}s`}</span>{/if}
							<span>· {item.steps.length} {t(item.steps.length === 1 ? 'step' : 'steps')}</span>
							{#if item.steps.some((s) => s.tool?.failed)}<Icon name="lucide:circle-alert" class="size-3 text-destructive" />{/if}
							<Icon name="lucide:chevron-right" class="size-3 transition-transform group-open/work:rotate-90" />
						</summary>
						<ol class="mt-1 space-y-0.5 border-l border-border/70 pl-3">
							{#each item.steps as s (s.id)}
								{@const step = stepOf(s)}
								{@const tool = s.tool}
								{@const shown = pane.get(s.id) ?? 'input'}
								<li data-step data-step-state={active(s) ? 'running' : s.tool?.failed ? 'failed' : 'done'}>
									<details class="group/step" ontoggle={(e) => e.currentTarget.open ? opened.add(s.id) : opened.delete(s.id)}>
										<summary class="flex cursor-pointer list-none items-center gap-2 rounded py-0.5 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden" class:text-destructive={s.tool?.failed}>
											<Icon name={s.tool?.failed === true ? 'lucide:circle-alert' : step.icon} class="size-3.5 shrink-0 {active(s) ? 'animate-spin' : ''}" />
											<span class="shrink-0 font-medium {active(s) ? 'agent-shimmer' : ''}">{step.verb}</span>
											{#if step.target !== ''}<span class="min-w-0 truncate font-mono text-[0.7rem] opacity-80">{step.target}</span>{/if}
											{#if s.tool?.ms !== undefined}<span class="ml-auto shrink-0 tabular-nums opacity-70">{seconds(s.tool.ms)}</span>{/if}
										</summary>
										<!-- a step's input and result render only once it is opened, one tab each -->
										{#if opened.has(s.id)}
										<div class="mt-1 mb-2 grid gap-1.5 text-xs">
											{#if tool === undefined}<p class="whitespace-pre-wrap text-muted-foreground italic" data-reasoning>{s.reasoning}</p>
											{:else if tool.args !== undefined || tool.result !== undefined}
												<div role="tablist" class="flex gap-1">
													{#each ([['input', 'Input'], ['output', 'Output']] as const).filter(([k]) => k === 'input' ? tool.args !== undefined : tool.result !== undefined) as [k, label] (k)}
														<button type="button" role="tab" data-pane={k} aria-selected={shown === k} onclick={() => pane.set(s.id, k)}
															class="rounded px-1.5 py-0.5 text-[0.7rem] {shown === k ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}">{t(label)}</button>
													{/each}
												</div>
												<div role="tabpanel" class="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[0.7rem] whitespace-pre-wrap">{shown === 'input' ? tool.args : tool.result}</div>
											{/if}
										</div>
										{/if}
									</details>
								</li>
							{/each}
						</ol>
					</details>
				</li>
			{:else}
			{@const { row, index } = item}
			{#if row.tool?.child !== undefined}
				<li {@attach turns.measure(itemKey(at))} data-role="subagent"><AgentChild {api} {bolt} {t} id={row.tool.child} /></li>
			{:else if row.role === 'user'}
				{@const label = triageLabel(row, index)}
				<li {@attach turns.measure(itemKey(at))} class="ml-auto w-fit max-w-[85%] rounded-[1.25rem] bg-muted px-4 py-2.5 break-words whitespace-pre-wrap" class:opacity-60={row.state === 'pending' || row.tag === 'ambient'} data-role="user" data-pending={row.state === 'pending' || undefined}><span data-text>{row.text}</span>{#each row.files ?? [] as f, i (i)}{@const href = f.id === undefined ? null : bolt.fileUrl({ id: f.id } as FileRef)}<span class="mt-1 block text-xs text-muted-foreground" data-attachment>
						{#if href !== null && f.mime.startsWith('image/')}<img src={/^image\/hei[cf]$/.test(f.mime) ? `${href}?preview=jpeg` : href} alt={f.name} class="mb-1 max-h-32 rounded" />{/if}{t('Attached')}: {#if href !== null}<a {href} target="_blank" rel="noreferrer" class="underline">{f.name}</a>{:else}{f.name}{/if}</span>{/each}
					{#if !thread && row.state === 'consumed' && revisable(row)}<Button size="sm" variant="ghost" class="mt-1 h-6 px-1 text-xs" onclick={() => revise(row)}>{t('Revise')}</Button>{/if}
					{#if label !== null}
						<span class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground" data-triage={row.state === 'pending' ? 'waiting' : row.tag === 'ambient' ? 'ambient' : 'responding'}
							data-role={row.id === lastPending ? 'waiting' : undefined}>
							<span>{label}</span>
							{#if !thread && row.id === lastPending}<Button size="sm" variant="ghost" onclick={respondNow}>{t('Respond now')}</Button>{/if}
						</span>
					{/if}
				</li>
			{:else if !thread && row.state === 'confirm' && row.call}
				<li {@attach turns.measure(itemKey(at))} class="rounded-xl border border-border/70 bg-background p-3 shadow-sm" data-role="confirm">
					<p class="font-medium">{t('Confirm this action?')}</p>
					<pre class="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 p-2 text-xs">{JSON.stringify(row.call.input, null, 2)}</pre>
					<Inline gap="xs" class="mt-2">
						<Button size="sm" onclick={() => confirm(row, true)}>{t('Confirm')}</Button>
						<Button size="sm" variant="outline" onclick={() => confirm(row, false)}>{t('Decline')}</Button>
					</Inline>
				</li>
			{:else if row.role === 'assistant' && row.text}
				{@const model = dividers.get(row.id)}
				<!-- a reply is plain flowing Markdown, no bubble; while it is written its text grows patch by patch behind a caret -->
				<li {@attach turns.measure(itemKey(at))} data-role="assistant" data-streaming={row.state === 'streaming' || undefined}>
					{#if model !== undefined}<p class="mb-2 flex items-center gap-2 text-xs text-muted-foreground" data-model-divider={model}><span class="h-px flex-1 bg-border"></span>{t('Model')}: {modelLabel(model)}<span class="h-px flex-1 bg-border"></span></p>{/if}
					<div {@attach copyable} class="agent-reply"><ReadonlyMarkdown value={row.text} class="prose-pre:bg-muted prose-pre:text-foreground" /></div>
					{#if interrupted(row)}<p class="text-xs text-muted-foreground" data-interrupted>{t('Interrupted')}</p>{/if}
					{#if row.detail}<p class="text-xs text-muted-foreground" data-detail>{row.detail}</p>{/if}
					{#each receiptsOf(row) as r, i (i)}
						<p class="text-xs text-muted-foreground" data-receipt>{r.outcome === 'pendingApproval' ? t('Awaiting approval') : t('Done')}: {r.callable}</p>
					{/each}
				</li>
			{:else if row.role === 'system'}
				<li {@attach turns.measure(itemKey(at))} data-role="note" data-tag={row.tag}>
					<details class="rounded-md border px-3 py-2 text-xs text-muted-foreground">
						<summary class="cursor-pointer">{row.tag === 'compact' ? `${t('Context checkpoint')} · ${t('earlier messages are summarized here')}${row.compact === undefined ? '' : ` · ${t(ORIGIN[row.compact.origin])}`}` : row.text?.split('\n')[0]}</summary>
						<div class="mt-2"><ReadonlyMarkdown value={row.text ?? ''} /></div>
					</details>
				</li>
			{/if}
			{/if}
		{/each}
		{#if turns.after > 0}<li aria-hidden="true" style="height:{turns.after}px"></li>{/if}
		{#if quiet}
			<li class="text-xs text-muted-foreground" data-role="thinking" data-thinking><span class="agent-shimmer">{t('Thinking…')}</span> <span class="tabular-nums">{thinking}s</span></li>
		{/if}
	</ol>
	{#if !pinned}
		<Button size="sm" variant="secondary" class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-md" aria-label={t('Jump to latest')} onclick={() => latest()} data-latest>
			<Icon name="lucide:arrow-down" class="size-4" />{t('Latest')}</Button>
	{/if}
	</div>
	{#if thread}
		<p class="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground" data-agent-read-only>{t('A channel conversation, answered by its envoy. Read-only here.')}</p>
	{:else}
	{#if drafting && current?.plan}
		{@const p = current.plan}
		<!-- staging's draft plan: a collapsed card above the prompt, reviewed by expanding it, executed or deleted from its header -->
		<div class="mx-auto w-full max-w-3xl shrink-0 px-4 pb-3" data-draft-plan>
			<section class="rounded-lg border border-border bg-muted/20" aria-label={t('Draft plan')} aria-busy={starting}>
				<div class="flex items-center gap-1 px-2 py-1.5">
					<Button variant="ghost" size="sm" class="min-w-0 px-1" aria-expanded={draftOpen} onclick={() => (draftOpen = !draftOpen)}>
						<Icon name="lucide:chevron-down" class="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none {draftOpen ? 'rotate-180' : ''}" />
						<span class="truncate">{t('Draft plan')}</span>
					</Button>
					<span class="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" title={`${t('Revision')} ${p.revision}`}>r{p.revision}</span>
					<Button size="icon" variant="ghost" class="size-7 shrink-0" aria-label={t('Delete plan')} title={t('Delete plan and return to Agent mode')} disabled={starting} onclick={() => plan(false)}>
						<Icon name="lucide:trash-2" class="size-3.5" />
					</Button>
					<Button size="sm" class="shrink-0 px-2" aria-label={starting ? t('Starting…') : t('Execute plan')} disabled={starting || status === 'running' || !empty} onclick={() => plan(true)} data-execute-plan>
						<Icon name={starting ? 'lucide:loader-circle' : 'lucide:play'} class="size-3.5 {starting ? 'animate-spin motion-reduce:animate-none' : ''}" />
						<span aria-live="polite">{starting ? t('Starting…') : t('Execute')}</span>
					</Button>
				</div>
				{#if draftOpen}
					<div class="overflow-auto border-t border-border/60 px-3 py-2 text-sm leading-relaxed" style="height: 28dvh"><ReadonlyMarkdown value={p.body} /></div>
				{/if}
			</section>
		</div>
	{/if}
	{#if planning || mode === 'compact'}
		<!-- staging's mode line: between the transcript and the composer's top border -->
		<p class="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2 text-tiny text-muted-foreground" data-mode-banner>{mode === 'compact'
			? t('Summarize this conversation and keep its transcript available.') : t('Discuss the approach here. Expand the draft Plan above the prompt to review it.')}</p>
	{/if}
	<!-- staging's composer: no box — one top border across the panel separates it from the transcript; below it notices and
		the queue, a borderless text area and its icon row (attach, context meter, model, a round send) -->
	<div class="shrink-0 border-t border-border bg-card pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-agent-composer>
	<div class="mx-auto flex w-full max-w-3xl flex-col gap-2 pt-2 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
	{#if unconfigured}
		<p role="alert" class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-ai-unconfigured>
			{t('AI provider not configured. An administrator must set one up (BOLT_AI_SYS_1_* and BOLT_AI_SYS_2_*) before the assistant can answer.')}</p>
	{/if}
	{#if queued.length > 0}
		<!-- the queue: a thin rail behind the composer -->
		<div class="grid w-full gap-1 text-xs" data-agent-queue>
			<span class="text-muted-foreground">{t('Queued')} · {queued.length}</span>
			<ol class="max-h-32 divide-y overflow-auto rounded-lg border border-border/70">
				{#each queued as q, i (q.id)}
					<li class="flex items-center gap-1 px-2 py-0.5" data-queued={q.id}>
						<span class="min-w-0 flex-1 truncate" title={q.text ?? ''}>{q.text || t('Attached message')}</span>
						{#if i > 0}<Button size="sm" variant="ghost" class="h-6 px-1" aria-label={t('Move up')} onclick={() => moveUp(i)}><Icon name="lucide:arrow-up" class="size-3.5" /></Button>{/if}
						{#if !q.id.startsWith('local:')}<!-- still posting: nothing to edit or remove yet -->
							<Button size="sm" variant="ghost" class="h-6 px-1" onclick={() => revise(q)}>{t('Edit')}</Button>
							<Button size="sm" variant="ghost" class="h-6 px-1" aria-label={t('Remove')} onclick={() => dequeue(q)}><Icon name="lucide:x" class="size-3.5" /></Button>
						{/if}
					</li>
				{/each}
			</ol>
		</div>
	{/if}
	{#if revising !== null}
		<Inline gap="sm" class="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2" data-revising>
			<Icon name="lucide:message-square-pen" class="size-3.5 shrink-0 text-primary" />
			<span class="min-w-0 flex-1 text-tiny text-muted-foreground">{revising.state === 'queued' ? t('Editing a queued message.') : t('Revising a message: sending supersedes it.')}</span>
			<button type="button" class="rounded px-1.5 py-1 text-tiny font-medium hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onclick={() => { revising = null; draft = ''; }}>{t('Cancel')}</button>
		</Inline>
	{/if}
	{#if status === 'stopped'}<p class="text-xs text-muted-foreground" data-stopped>{t('Stopped. Resume the stopped work, or send a follow-up.')}</p>{/if}
	{#if error !== null}<p role="alert" class="text-xs text-destructive">{error}</p>{/if}
	<form onsubmit={send} class="relative flex w-full flex-col" ondragover={(e) => e.preventDefault()} ondrop={drop}>
		{#if mode === 'compact' || planning}
			{@const chip = mode === 'compact' ? 'compact' : 'plan'}
			<Inline gap="xs" class="pt-1" data-mode={chip}>
				<span class="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 font-mono text-xs" title={chip === 'plan' ? t('Switch between Agent and Plan (Tab)') : undefined}>
					<Icon name={chip === 'plan' ? 'lucide:list-todo' : 'lucide:scan-text'} class="size-3 shrink-0" />/{chip}
					{#if chip === 'compact' || !planLocked}<button type="button" class="grid size-4 place-items-center rounded-full opacity-70 hover:opacity-100" aria-label={t('Remove')} onclick={() => (mode = null)}><Icon name="lucide:x" class="size-3" /></button>{/if}
				</span>
			</Inline>
		{/if}
		<MarkdownEditor value={draft} onChange={(v) => (draft = v)} rows={2} {commands} commandStart="text" {mentions} aria-label={t('Message')}
			class="[&_textarea]:max-h-40 [&_textarea]:min-h-14 [&_textarea]:resize-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0 [&_textarea]:py-3 [&_textarea]:text-sm [&_textarea]:leading-relaxed [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0 dark:[&_textarea]:bg-transparent"
			placeholder={t('Ask anything, or type /plan, /compact or /export')} onkeydown={keydown} onpaste={paste} />
		{#if attached.length > 0}
			<Inline gap="xs" class="flex-wrap pb-1" data-attached>
				{#each attached as f, i (i)}
					<button type="button" class="inline-flex h-10 max-w-48 items-center gap-2 overflow-hidden rounded-md border border-border/70 px-2 text-xs" aria-label={`${t('Remove')} ${f.name}`}
						onclick={() => { attached = attached.filter((_, j) => j !== i); }}>
						<Icon name={f.type.startsWith('image/') ? 'lucide:image' : 'lucide:file-text'} class="size-4 shrink-0" /><span class="truncate">{f.name}</span><Icon name="lucide:x" class="size-3 shrink-0" />
					</button>
				{/each}
			</Inline>
		{/if}
		<input bind:this={picker} type="file" multiple class="sr-only" aria-hidden="true" tabindex="-1"
			accept="image/*,text/*,application/pdf,application/json,application/xml,.docx,.xlsx,.md,.csv,.tsv,.log,.yaml,.yml"
			onchange={(e) => { attach([...e.currentTarget.files ?? []]); e.currentTarget.value = ''; }} />
		<Inline gap="xs" class="pb-2">
			<button type="button" class="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={t('Attach media or files')} title={t('Attach media or files')} onclick={() => picker?.click()}><Icon name="lucide:plus" class="size-5" /></button>
			<Popover.Root>
				<Popover.Trigger data-context-meter class="flex h-7 cursor-pointer items-center gap-1 rounded px-1 text-xs text-muted-foreground tabular-nums hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label={`${t('Context window used')}: ${k(meter.context)} / ${k(meter.window)}`}>
					<Icon name="lucide:chart-pie" class="size-3.5" /><span>{meter.percent === null ? '—' : `${Math.round(meter.percent)}%`}</span><span>· {meter.cost === null ? '—' : usd(meter.cost)}</span>
				</Popover.Trigger>
				<Popover.Content side="top" align="start" class="grid w-72 max-w-[calc(100vw-3rem)] gap-2 p-3 text-xs tabular-nums">
					<span class="flex justify-between gap-2"><span>{t('Context window used')}</span><span>{k(meter.context)} / {k(meter.window)}</span></span>
					<Progress value={meter.percent ?? 0} class="h-1" aria-label={t('Context window used')} />
					<span class="flex justify-between gap-2"><span>{t('Tokens')}</span><span>{meter.input.toLocaleString()} {t('in')} · {meter.output.toLocaleString()} {t('out')}</span></span>
					<span class="flex justify-between gap-2"><span>{t('Cost')}</span><span>{meter.cost === null ? '—' : usd(meter.cost)}</span></span>
				</Popover.Content>
			</Popover.Root>
			<span class="flex-1"></span>
			{#if models.length > 1}
				<Combobox variant="ghost" searchable class="w-auto max-w-[45%] text-muted-foreground" options={modelOptions} value={chosenModel} placeholder={t('Model')} aria-label={t('Model')} onChange={pickModel} />
			{/if}
			{#if status === 'running' && empty}<Button type="button" size="icon" class="size-8 shrink-0 rounded-full" aria-label={t('Stop')} title={t('Stop')} onclick={() => (confirming = 'stop')} data-agent-stop><Icon name="lucide:square" class="size-3.5 fill-current" /></Button>
			{:else if status === 'stopped' && empty}<Button type="button" size="icon" class="size-8 shrink-0 rounded-full" aria-label={t('Resume')} title={t('Resume')} onclick={() => control(false)} data-agent-resume><Icon name="lucide:play" class="size-4" /></Button>
			{:else}<Button type="submit" size="icon" class="size-8 shrink-0 rounded-full" aria-label={status === 'running' ? t('Queue message') : t('Send')} title={status === 'running' ? t('Queue message') : t('Send')} disabled={empty && mode !== 'compact'}>
				<Icon name={status === 'running' ? 'lucide:list-plus' : 'lucide:arrow-up'} class="size-4" />
			</Button>{/if}
		</Inline>
	</form>
	</div>
	</div>
	{/if}
</div>

<!-- staging asks before stopping a response, and before deleting a plan while it runs -->
<Dialog.Root open={confirming !== null} onOpenChange={(o) => { if (!o) confirming = null; }}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{confirming === 'plan' ? t('Delete this plan?') : t('Stop this response?')}</Dialog.Title>
			<Dialog.Description>{confirming === 'plan' ? t('The agent stops working from it. Conversation history stays available.')
				: t('The current response will stop. Completed work is kept; queued messages are cancelled.')}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirming = null)}>{confirming === 'plan' ? t('Keep plan') : t('Keep working')}</Button>
			<Button variant="destructive" onclick={() => { const c = confirming; confirming = null; void (c === 'plan' ? plan(false) : control(true)); }} data-confirm>{confirming === 'plan' ? t('Delete plan') : t('Stop response')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	/* the active step's words: a light band sweeping across muted text (still under reduced motion) */
	.agent-shimmer {
		background: linear-gradient(90deg, var(--color-muted-foreground) 35%, var(--color-foreground) 50%, var(--color-muted-foreground) 65%) 0 0 / 250% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: agent-shimmer 1.8s linear infinite;
	}
	@keyframes agent-shimmer { from { background-position: 100% 0; } to { background-position: -150% 0; } }
	/* a reply being written ends in a blinking caret */
	[data-streaming] .agent-reply :global([data-markdown] > :last-child::after) {
		content: '▍';
		margin-left: 0.1em;
		animation: agent-caret 1s steps(2) infinite;
	}
	@keyframes agent-caret { to { opacity: 0; } }
	@media (prefers-reduced-motion: reduce) {
		.agent-shimmer { animation: none; color: var(--color-muted-foreground); }
		[data-streaming] .agent-reply :global([data-markdown] > :last-child::after) { animation: none; }
	}
</style>
