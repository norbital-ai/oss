<!--
	Workspace Studio (§5.10, §7) over the host's Studio port: a title, the Workbench / Changes / Live segmented tabs, and
	under each a navigator rail (a bottom sheet on a phone) beside the main pane. The viewer works on one change at a
	time: a named set of edits from live with its own preview on a copy-on-write fork of live's data. Workbench is the
	source tree, a toolbar (the change, how far behind live, status and actions) and the editor over the last build's
	diagnosis; it edits source as drafts and saves them over the head it read (the first save with no change open opens
	one). A save commits; Preview builds and serves the latest commit. Changes lists every change and reviews one: files before and
	after (L-BOLT-528), manifest and logs, with Merge — the only way to ship, run in the background: git's 3-way merge, a
	build of the merged tree with its checks, then the cutover, recorded as a Version. Live lists the Versions and rolls
	live back to one, source and data together (the confirm names what is lost when its schema differs); the state it
	leaves is kept as an undo Version, so a rollback is undone the same way. That is neither the operator's database
	restore nor a record's restore. Each build's stored log and diagnostics open from the rail. Under it are the runtime
	log (held by the host's log store) and Operations, the environments the host routes. Build log lines, a moved head, a
	changed change and phase frames (diagnose → copy → preview → merge, L-BOLT-530) arrive pushed. Each tab is a deep link
	(`/studio/<tab>`: `mrs` opens Changes, `runtime`, `operations` and `usage` open Live's views). Audit rules
	(`/studio/rules`) is the organization's rule set, saved over its revision, and an audit of the head under it. Studio
	is an administrator's (`admin`); the host refuses anyone else regardless.
-->
<script lang="ts">
	import { attach, fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Cause, Effect, Queue, Schema, Stream } from 'effect';
	import { watch } from 'runed';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		Button,
		confirmAction,
		Dialog,
		Icon,
		Input,
		Sheet,
		Spinner,
		Tabs,
		type ConfirmOptions,
		type WorkspaceOperation
	} from '@norbital-ai/ui';
	import { Inline, AppHeader, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { Snippet } from 'svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import AuditRules from './AuditRules.svelte';
	import LivePane from './LivePane.svelte';
	import ChangePane from './ChangePane.svelte';
	import SourceEditor from './SourceEditor.svelte';
	import SourceTree from './SourceTree.svelte';
	import WorkbenchToolbar from './WorkbenchToolbar.svelte';
	import { impactLines } from '../../protocol/migration-impact.ts';
	import PreviewFrame from '../preview/PreviewFrame.svelte';
	import studioBanner from '../assets/banners/studio.jpg';
	import {
		foldLog,
		foldPhase,
		PHASES,
		type PhaseState,
		reach,
		ageText,
		settleDrafts,
		sizeText,
		stepLabel,
		elapsedText,
		suggestMessage,
		type StudioApproval,
		type StudioFile,
		type StudioChangeSet,
		type StudioFrame,
		type StudioOp,
		type StudioPhase,
		type StudioView
	} from './model.ts';
	import type { StudioAudit, StudioAuditRules } from './audit.ts';
	import { based, SHELL, type StudioTab } from '../nav.ts';
	import type { ShellApi, ShellError } from '../api-types.ts';

	// ponytail: `admin` defaults to true until the shell passes `boot.admin`; the host refuses a non-administrator's admin ops either way
	let {
		api,
		t,
		tab = 'workbench',
		onTab,
		admin = true
	}: {
		api: ShellApi;
		t: (key: string) => string;
		tab?: StudioTab;
		onTab?: (tab: StudioTab) => void;
		admin?: boolean;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');

	let view = $state<StudioView | null>(null);
	const changeSets = $derived(view?.changeSets ?? []);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let file = $state('');
	let drafts = $state<{ [path: string]: string | null }>({});
	let showPreview = $state(false);
	// the URL's tab; a click shows it at once and asks the shell to move the URL (a back navigation moves it again)
	let active = $derived(tab);
	function go(next: StudioTab): void {
		active = next;
		onTab?.(next);
	}
	const root = $derived(
		active === 'changes' || active === 'mrs'
			? 'changes'
			: active === 'live' || active === 'runtime' || active === 'operations' || active === 'usage'
				? 'live'
				: active === 'rules'
					? 'rules'
					: 'workbench'
	);
	// Audit rules: read when the tab opens; a save answers the stored set, Try and Audit the head's findings
	const readRules = observeOnce(() => (root === 'rules' && admin ? api.studioAuditRules() : null));
	let savedRules = $state<StudioAuditRules | undefined>(undefined);
	let audited = $state<StudioAudit | undefined>(undefined);
	let auditError = $state<string | null>(null);
	let auditing = $state(false);
	const shownRules = $derived(savedRules ?? readRules.current ?? undefined);
	const auditCall = <A,>(call: Effect.Effect<A, ShellError>, done: (answer: A) => void) =>
		Effect.sync(() => {
			auditing = true;
			auditError = null;
		}).pipe(
			Effect.andThen(call),
			Effect.tap((answer) => Effect.sync(() => done(answer))),
			Effect.catch((cause) =>
				Effect.sync(() => {
					auditError = cause.message;
				})
			),
			Effect.ensuring(
				Effect.sync(() => {
					auditing = false;
				})
			)
		);
	let phases = $state<{ [p in StudioPhase]?: PhaseState }>({});
	// the furthest phase the current run reached (`reach`: never back), when it started, and whether it builds a preview
	let step = $state(-1);
	let since = $state(0);
	let building = $state(false);
	let diff = $state(false);
	let selected = $state<string | null>(null);
	let browsing = $state(false);

	const load = () =>
		api.studio().pipe(
			Effect.tap((next) =>
				Effect.sync(() => {
					view = { ...next };
				})
			),
			Effect.catch((cause) =>
				Effect.sync(() => {
					error = cause.message;
				})
			)
		);
	class StudioStreamFailed extends Schema.TaggedError<StudioStreamFailed>()('StudioStreamFailed', {
		message: Schema.String
	}) {}
	const FrameSchema = Schema.Union([
		Schema.Struct({
			kind: Schema.Literal('log'),
			line: Schema.Struct({
				at: Schema.String,
				level: Schema.Literals(['info', 'warn', 'error']),
				message: Schema.String
			})
		}),
		Schema.Struct({ kind: Schema.Literal('source'), commit: Schema.String }),
		Schema.Struct({ kind: Schema.Literal('change'), id: Schema.String }),
		Schema.Struct({
			kind: Schema.Literal('phase'),
			phase: Schema.Literals(PHASES),
			state: Schema.Literals(['running', 'done', 'failed'])
		})
	]);
	const events = Stream.callback<StudioFrame, StudioStreamFailed>((queue) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => new EventSource(based(`${SHELL}/studio/events`), { withCredentials: true }),
				catch: () => new StudioStreamFailed({ message: 'Studio events could not be opened.' })
			}),
			(source) => Effect.sync(() => source.close())
		).pipe(
			Effect.tap((source) =>
				Effect.sync(() => {
					source.onmessage = (event: MessageEvent<unknown>) => {
						const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(FrameSchema))(
							event.data
						);
						if (decoded._tag === 'Success') Queue.offerUnsafe(queue, decoded.success);
						else
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(new StudioStreamFailed({ message: 'Studio returned an invalid event.' }))
							);
					};
				})
			)
		)
	);
	const observe = attach(() =>
		load().pipe(
			Effect.andThen(
				typeof EventSource === 'undefined'
					? Effect.void
					: events.pipe(
							Stream.runForEach((frame) => {
								if (view === null) return Effect.void;
								if (
									((frame.kind === 'source' && frame.commit !== view.commit) ||
										frame.kind === 'change') &&
									!busy
								)
									return load();
								return Effect.sync(() => {
									if (frame.kind === 'log' && view !== null)
										view = { ...view, log: foldLog(view.log, frame.line) };
									else if (frame.kind === 'phase') {
										phases = { ...foldPhase(phases, frame.phase, frame.state) };
										step = reach(step, frame.phase);
									}
								});
							})
						)
			),
			Effect.catch((cause) =>
				Effect.sync(() => {
					error = cause.message;
				})
			)
		)
	);
	const run = Effect.fn('Studio.run')(
		function* (op: StudioOp) {
			busy = true;
			error = null;
			const r = yield* Effect.result(api.studioRun(op));
			if (r._tag === 'Failure') return ((error = r.failure.message), false);
			view = r.success;
			return true;
		},
		(effect) =>
			effect.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
	);
	const monitorRun = (operation: WorkspaceOperation) =>
		Effect.suspend(() => {
			const own = 'id' in operation && operation.id === view?.change;
			if (
				Object.keys(drafts).length > 0 &&
				((own &&
					(operation.op === 'preview' ||
						operation.op === 'change.merge' ||
						operation.op === 'change.close')) ||
					operation.op === 'change.open')
			)
				return Effect.fail(
					new Error(t('Save or discard your unsaved source changes before changing this workflow.'))
				);
			return run(operation);
		});
	/** The save dialog: asks what the change does, prefilled with a suggestion; `null` when cancelled. */
	// the field starts empty: the suggestion is its placeholder and what an empty answer saves
	let describing = $state<{
		text: string;
		suggestion: string;
		answer: (message: string | null) => void;
	} | null>(null);
	const describe = (suggestion: string) =>
		Effect.callback<string | null>((resume) => {
			describing = {
				text: '',
				suggestion,
				answer: (message) => {
					describing = null;
					resume(Effect.succeed(message));
				}
			};
			return Effect.sync(() => {
				describing = null;
			});
		});
	/** When to merge, asked in a dialog: a local date and time, an hour from now by default. */
	let scheduling = $state<{ when: string; answer: (at: string | null) => void } | null>(null);
	const localInput = (at: Date) =>
		new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	const askWhen = () =>
		Effect.callback<string | null>((resume) => {
			scheduling = {
				when: localInput(new Date(Date.now() + 3_600_000)),
				answer: (at) => {
					scheduling = null;
					resume(Effect.succeed(at));
				}
			};
			return Effect.sync(() => {
				scheduling = null;
			});
		});
	/** A merge at a later instant: saved and previewed as a merge is, then run at that time as the viewer. */
	const schedule = Effect.fn('Studio.schedule')(function* (c: StudioChangeSet) {
		if (locked || (c.id === view?.change && !(yield* save()))) return;
		const current = changeSets.find((x) => x.id === c.id) ?? c;
		if (current.preview === null || current.preview.url === null || current.preview.stale) {
			error = t('Preview the latest commit before promoting it.');
			return;
		}
		const when = yield* askWhen();
		if (when === null) return;
		const accept = current.preview.destructive ?? [];
		yield* run({
			op: 'change.merge',
			id: current.id,
			at: new Date(when).toISOString(),
			...(accept.length > 0 ? { accept } : {})
		});
	});
	const save = Effect.fn('Studio.save')(function* () {
		if (view === null || Object.keys(drafts).length === 0) return true;
		const saved = $state.snapshot(drafts),
			expected = view.commit;
		const message = yield* describe(suggestMessage(saved, view.files));
		if (message === null) return false;
		const ok = yield* run({ op: 'save', expected, files: saved, message });
		// an edit made while the save was in flight is newer than what was saved: it stays a draft
		if (ok) drafts = settleDrafts(drafts, saved);
		return ok;
	});
	/**
	 * A change to what live users get (a merge, a rollback): claimed at the click, so a double click asks once; it
	 * propagates only after an explicit approval that says what it changes; its progress stays on screen until dismissed.
	 * A merge runs in the background: `change` follows it through the change's own state; a rollback offers its `undo`.
	 */
	let cutover = $state<{
		outcome: 'asking' | 'running' | 'done' | 'failed';
		change?: string;
		undo?: string;
	} | null>(null);
	const merging = $derived(
		cutover?.change === undefined ? undefined : changeSets.find((c) => c.id === cutover?.change)
	);
	const outcome = $derived(
		cutover === null
			? null
			: merging === undefined || cutover.outcome !== 'running'
				? cutover.outcome
				: merging.state === 'merged'
					? 'done'
					: merging.merge?.state === 'failed'
						? 'failed'
						: 'running'
	);
	const locked = $derived(busy || outcome === 'asking' || outcome === 'running');
	const approved = Effect.fn('Studio.approved')(function* (
		ask: ConfirmOptions,
		work: Effect.Effect<boolean>,
		follow: { change?: string } = {}
	) {
		if (locked) return false;
		cutover = { outcome: 'asking' };
		if (!(yield* confirmAction(ask))) return ((cutover = null), false);
		cutover = { outcome: 'running', ...follow };
		phases = {};
		step = -1;
		since = Date.now();
		const ok = yield* work;
		// a merge that started keeps running in the background: its change says when it is done
		cutover =
			ok && follow.change !== undefined
				? { outcome: 'running', ...follow }
				: { outcome: ok ? 'done' : 'failed', ...follow };
		return ok;
	});
	const changedFiles = (n: number) => `${n} ${t(n === 1 ? 'changed file' : 'changed files')}`;
	/**
	 * Merges a change into live. The viewer's own unsaved drafts are saved (with their description) first; the
	 * destructive steps its current preview names are what the confirmation accepts.
	 */
	/** The person takes the preview: the tenant shell steers Norbius's conversation with the fact. */
	const takeControl = (id: string) =>
		run({ op: 'preview.release', id }).pipe(
			Effect.tap((ok) =>
				Effect.sync(() => {
					if (!ok) return;
					for (const frame of document.querySelectorAll('iframe'))
						frame.contentWindow?.postMessage(
							{ type: 'norbital:preview-release', id },
							location.origin
						);
				})
			)
		);
	const merge = Effect.fn('Studio.merge')(function* (c: StudioChangeSet) {
		if (locked || (c.id === view?.change && !(yield* save()))) return;
		const current = changeSets.find((x) => x.id === c.id) ?? c;
		// the preview of the latest commit is what a merge promotes: the service refuses one without it
		if (
			current.preview === null ||
			current.preview.url === null ||
			current.preview.stale ||
			current.preview.shelved === true
		) {
			error = t('Preview the latest commit before promoting it.');
			return;
		}
		const accept = current.preview.destructive ?? [];
		yield* approved(
			{
				title: `${t('Merge')} !${current.id} ${t('into live?')}`,
				body: `${current.title}${current.id === view?.change ? ` · ${changedFiles(view.changes.length)}` : ''}. ${
					accept.length > 0
						? `${t('This applies destructive schema steps:')} ${accept.join(', ')}. `
						: ''
				}${
					current.preview.impact === undefined
						? ''
						: `${impactLines(current.preview.impact, t).join('. ')}. `
				}${t('It merges with live, builds and checks the result, then everyone using the workspace gets it.')}`,
				confirmLabel: t('Merge'),
				cancelLabel: t('Cancel'),
				destructive: accept.length > 0
			},
			run(
				accept.length > 0
					? { op: 'change.merge', id: current.id, accept }
					: { op: 'change.merge', id: current.id }
			),
			{ change: current.id }
		);
	});
	/** A rollback: the Version's source and data come back together; a schema change loses later data. */
	const rollback = Effect.fn('Studio.rollback')(function* (commit: string) {
		const target = releases.find((r) => r.commit === commit);
		// a Version without a restorable checkpoint is never offered: the host would refuse it
		if (target === undefined || target.checkpoint === null) return;
		const lost = target.discards;
		const when = new Date(target.checkpoint ?? target.at).toLocaleString();
		const ok = yield* approved(
			{
				title: t(target.undo ? 'Undo the rollback?' : 'Roll back live to this version?'),
				body: `${when} — ${target.message || commit.slice(0, 8)}. ${
					lost === undefined
						? t('Its source comes back and live keeps all its data.')
						: `${t('Its schema differs from live’s, so the data written after')} ${new Date(lost).toLocaleString()} ${t('will be lost.')}`
				} ${t('Live as it is now is kept, so this can be undone. Everyone stays signed in.')}`,
				confirmLabel: t(target.undo ? 'Undo' : 'Roll back'),
				cancelLabel: t('Cancel'),
				destructive: lost !== undefined
			},
			run({
				op: 'rollback',
				commit,
				...(lost === undefined ? {} : { discardDataSince: lost })
			})
		);
		// the newest undo Version is the state this rollback left
		const undo = view?.releases.find((r) => r.undo);
		if (ok && undo !== undefined && !target.undo) cutover = { outcome: 'done', undo: undo.commit };
	});
	/** What Norbius asked to change on live, held for the viewer: approved here, it runs as them; rejected, it is dropped. */
	const asked = (held: StudioApproval) =>
		held.op.op === 'change.merge'
			? `${t('Merge')} !${held.op.id}`
			: held.op.op === 'rollback'
				? `${t('Roll back live to')} ${short(held.op.commit)}`
				: held.op.op;
	/** A held merge's measured impact on its preview, in plain words. */
	const heldImpact = (held: StudioApproval) => {
		const op = held.op;
		const impact =
			op.op === 'change.merge'
				? changeSets.find((c) => c.id === op.id)?.preview?.impact
				: undefined;
		return impact === undefined ? '' : `${impactLines(impact, t).join('. ')}. `;
	};
	const decide = (held: StudioApproval, kind: 'approved' | 'rejected') =>
		kind === 'rejected'
			? run({ op: 'approval.decide', id: held.id, kind })
			: approved(
					{
						title: `${asked(held)}?`,
						body: `${
							(held.destructive?.length ?? 0) > 0
								? `${t('This applies destructive schema steps:')} ${held.destructive?.join(', ')}. `
								: ''
						}${heldImpact(held)}${t('Everyone using the workspace gets this version once it is switched over.')}`,
						confirmLabel: t('Approve'),
						cancelLabel: t('Cancel'),
						destructive: (held.destructive?.length ?? 0) > 0
					},
					run({ op: 'approval.decide', id: held.id, kind }),
					held.op.op === 'change.merge' ? { change: held.op.id } : {}
				);
	// a running step's elapsed time, ticking while a change or a preview build runs
	let now = $state(Date.now());
	watch(
		() => building || outcome === 'running',
		(running) => {
			if (!running) return;
			now = Date.now();
			const timer = setInterval(() => (now = Date.now()), 1_000);
			return () => clearInterval(timer);
		}
	);
	const elapsed = $derived(elapsedText(now - since));
	const running = $derived(`${t(stepLabel(step))} · ${elapsed}`);
	const progress = $derived(
		outcome === null || outcome === 'asking'
			? null
			: outcome === 'done'
				? t('Done — live runs the new version.')
				: outcome === 'failed'
					? `${t('Failed')}: ${merging?.merge?.error ?? error ?? t('the change was not applied')}`
					: merging !== undefined && step < 0
						? `${t('Merging…')} · ${elapsed}`
						: running
	);
	// the header carries the run's state: a live indicator while it runs, then a terminal note that clears itself
	let bannerHidden = $state(false);
	$effect(() => {
		const shown = progress;
		if (shown === null) {
			bannerHidden = true;
			return;
		}
		bannerHidden = false;
		if (outcome === 'running' || outcome === 'asking') return;
		const timer = setTimeout(() => (bannerHidden = true), 8_000);
		return () => clearTimeout(timer);
	});
	const banner = $derived(bannerHidden ? null : progress);
	/** A preview build: its progress (the furthest step and the time it took so far) shows in the preview pane. */
	const buildPreview = () =>
		Effect.suspend(() => {
			// the preview builds the latest commit: unsaved drafts are not in it, so they are saved first or not previewed
			if (Object.keys(drafts).length > 0) {
				error = t('Save your changes before previewing: the preview builds the latest commit.');
				return Effect.void;
			}
			step = -1;
			since = Date.now();
			building = true;
			return run({ op: 'preview' });
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					building = false;
				})
			)
		);
	/** A diagnosis checks what is on screen: unsaved drafts are saved (with their description) first. */
	const diagnose = Effect.fn('Studio.diagnose')(function* () {
		if (yield* save()) yield* buildPreview();
	});
	function edit(value: string): void {
		if (value === text) delete drafts[file];
		else drafts[file] = value;
	}
	/** A new change: unsaved drafts go to the change they were made on, or, with none open, into the new one. */
	const newChange = Effect.fn('Studio.newChange')(function* () {
		const title = prompt(t('What is this change for?'))?.trim();
		if (!title) return;
		if (view?.change !== undefined && !(yield* save())) return;
		if (!(yield* run({ op: 'change.open', title }))) return;
		yield* save();
		selected = view?.change ?? null;
	});
	/** Work on another change: unsaved drafts of the current one are discarded only when the viewer says so. */
	const workOn = Effect.fn('Studio.workOn')(function* (id: string) {
		if (
			Object.keys(drafts).length > 0 &&
			!(yield* confirmAction({
				title: t('Discard unsaved drafts and switch?'),
				confirmLabel: t('Discard and switch'),
				cancelLabel: t('Cancel'),
				destructive: true
			}))
		)
			return false;
		drafts = {};
		const ok = yield* run({ op: 'change.open', id });
		if (ok) go('workbench');
		return ok;
	});
	function installPackage(): void {
		const answer = prompt(t('Package name and exact version (name@1.2.3)'))?.trim();
		if (!answer) return;
		const at = answer.lastIndexOf('@');
		if (at <= 0) {
			error = t('Name an exact version: package@1.2.3');
			return;
		}
		fork(
			run({
				op: 'package.install',
				name: answer.slice(0, at),
				version: answer.slice(at + 1)
			})
		);
	}
	function create(): void {
		const path = prompt(t('New file path'))?.trim();
		if (!path) return;
		// an existing path opens; a deleted one is restored; a new one starts empty
		if (drafts[path] === null) delete drafts[path];
		else if (drafts[path] === undefined && !(view !== null && path in view.files))
			drafts[path] = '';
		file = path;
	}
	function openFile(path: string): void {
		file = path;
		showPreview = false;
		browsing = false;
		go('workbench');
	}
	function togglePreview(): void {
		showPreview = !showPreview;
		// the preview may already exist from live's build: opening it builds the change's head when that moved on
		if (showPreview && (view?.preview === null || view?.previewOf?.stale === true))
			fork(buildPreview());
	}
	const files = $derived(
		view === null ? [] : [...new Set([...Object.keys(view.files), ...Object.keys(drafts)])].sort()
	);
	// the open file's text is read from the host when it opens (a state carries only the tree); what was read is kept for
	// the head it was read at, and a moved head (a save, a switch, someone else's save) reads again
	const head = $derived(view?.commit ?? '');
	const stored = $derived(view !== null && file in view.files);
	const read = { at: '', files: new Map<string, StudioFile | null>() };
	const opened = observeOnce(() => {
		if (!stored) return null;
		const commit = head,
			path = file;
		if (read.at !== commit) {
			read.files.clear();
			read.at = commit;
		}
		const hit = read.files.get(path);
		return hit !== undefined
			? Effect.succeed(hit)
			: api.studioFile(commit, path).pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							if (read.at === commit) read.files.set(path, answer);
						})
					)
				);
	});
	const text = $derived(
		opened.current !== undefined && opened.current !== null && 'text' in opened.current
			? opened.current.text
			: undefined
	);
	// a file shown only in part, or not at all, is read-only: a save never writes back what was not shown
	const note = $derived.by(() => {
		if (!stored || typeof drafts[file] === 'string') return undefined;
		const answer = opened.current;
		if (opened.error !== undefined) return opened.error.message;
		if (answer === undefined) return t('Loading…');
		if (answer === null) return t('This file is not in this version.');
		if ('binary' in answer) return `${t('Not a text file')} · ${sizeText(answer.bytes)}`;
		return answer.truncated === undefined
			? undefined
			: `${t('Shown up to')} ${sizeText(answer.truncated.limit)} ${t('of')} ${sizeText(answer.truncated.bytes)} · ${t('read-only here')}`;
	});
	const source = $derived(drafts[file] ?? text ?? '');
	const mine = $derived(changeSets.find((c) => c.id === view?.change));
	const current = $derived(changeSets.find((c) => c.id === (selected ?? view?.change)) ?? null);
	const releases = $derived(view?.releases ?? []);
	const draftCount = $derived(Object.keys(drafts).length);
	const short = (commit: string) => commit.slice(0, 8);
	const STATE = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const;
	const ROW =
		'w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/70 aria-[current=true]:bg-primary/5';
</script>

<span hidden {@attach observe}></span>

<!-- the navigator rail beside the pane (a bottom sheet on a phone) and the pane -->
{#snippet frame(navigator: Snippet, main: Snippet, top?: Snippet)}
	<Stack gap="none" fill class="min-h-0 {INSET_X_CLASS}">
		{@render top?.()}
		<Inline align="stretch" gap="none" grow class="min-h-0 min-w-0">
			<aside
				class="hidden w-72 shrink-0 border-r border-border/60 bg-card md:block"
				aria-label={t('Workspace navigator')}
			>
				<Stack gap="none" fill class="min-h-0">{@render navigator()}</Stack>
			</aside>
			<div class="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
				{@render main()}
			</div>
		</Inline>
	</Stack>
{/snippet}

{#snippet railHeading(icon: string, label: string)}
	<Inline gap="xs" shrink={false} class="border-b border-border/60 px-3 py-1.5">
		<Icon name={icon} class="size-3.5 text-muted-foreground" /><span
			class="text-overline text-foreground">{label}</span
		>
	</Inline>
{/snippet}

{#snippet sourceNav()}
	{#if view !== null}
		<SourceTree {files} base={view.files} {drafts} selected={file} onselect={openFile} {t} />
	{/if}
{/snippet}

{#snippet changesNav()}
	{@render railHeading('lucide:git-pull-request', t('Changes'))}
	<Scroll name={t('Changes')} layout="stack" gap="xs" grow class="min-h-0 p-2">
		<Button
			size="sm"
			variant="ghost"
			class="justify-start px-2 text-micro"
			disabled={locked}
			onclick={() => fork(newChange())}
			><Icon name="lucide:git-branch-plus" class="size-3.5" />{t('New change')}</Button
		>
		{#each [...changeSets].reverse() as c (c.id)}
			<button
				type="button"
				class={ROW}
				data-state={c.state}
				aria-current={c.id === current?.id}
				onclick={() => {
					selected = c.id;
					browsing = false;
				}}
			>
				<span class="block truncate text-xs font-medium text-foreground">!{c.id} {c.title}</span>
				<span class="block truncate text-micro text-muted-foreground"
					>{c.openedBy}{#if c.id === view?.change}
						· {t('yours')}{/if}</span
				>
				<span class="mt-1 block truncate text-micro text-muted-foreground"
					>{t(STATE[c.state])}{#if c.merge?.state === 'running'}
						· {t('merging')}{:else if c.merge?.state === 'failed'}
						· {t('merge failed')}{/if}{#if c.behind > 0}
						· {c.behind} {t('behind live')}{/if} · {ageText(c.updatedAt, Date.now())}</span
				>
			</button>
		{:else}
			<p class="px-2 py-2 text-micro text-muted-foreground">{t('No changes yet.')}</p>
		{/each}
	</Scroll>
{/snippet}

{#snippet toolbar()}
	{#if view !== null}
		<WorkbenchToolbar
			{view}
			{admin}
			busy={locked}
			drafts={draftCount}
			{phases}
			{error}
			previewing={showPreview}
			{t}
			onnew={create}
			onsave={() => fork(save())}
			onpreview={togglePreview}
			onopen={() => fork(newChange())}
			onmerge={() => {
				if (mine !== undefined) fork(merge(mine));
			}}
			onschedule={() => {
				if (mine !== undefined) fork(schedule(mine));
			}}
			onunschedule={() => {
				if (mine !== undefined) fork(run({ op: 'change.unschedule', id: mine.id }));
			}}
			oninstall={installPackage}
			onreview={() => {
				selected = view?.change ?? null;
				go('changes');
			}}
		/>
		{#if (view.conflicts?.length ?? 0) > 0}
			<Inline
				gap="xs"
				shrink={false}
				role="alert"
				class="border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive"
			>
				<Icon name="lucide:triangle-alert" class="size-3 shrink-0" /><span class="truncate text-xs"
					>{t('Resolve the conflict markers in')} {view.conflicts?.join(', ')}</span
				>
			</Inline>
		{/if}
	{/if}
{/snippet}

{#snippet workbenchMain()}
	{#if view !== null}
		{#if showPreview}
			{@const p = view.previewOf}
			<Stack gap="none" fill class="min-h-0">
				{#if view.preview === null || p?.stale === true}
					{@const waiting = building}
					{@const failed =
						!waiting &&
						view?.builds?.some(
							(build) => build.commit === view?.commit && build.status === 'failed'
						)}
					<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
						<Icon
							name={waiting
								? 'lucide:loader-2'
								: failed
									? 'lucide:triangle-alert'
									: 'lucide:scan-eye'}
							class="size-8 opacity-30 {waiting ? 'animate-spin' : ''}"
						/>
						<p class="text-xs" role={waiting ? 'status' : failed ? 'alert' : undefined}>
							{waiting
								? running
								: failed
									? t('Preview build failed. Try again.')
									: p?.stale
										? t('Preview is out of date.')
										: t('No preview yet.')}
						</p>
						{#if !waiting && view.change !== undefined}
							<Button size="sm" disabled={locked} onclick={() => fork(buildPreview())}
								>{t('Preview')}</Button
							>
						{/if}
					</Stack>
				{:else}
					<div class="relative flex min-h-0 flex-1 flex-col">
						<PreviewFrame
							src={view.preview}
							version={p?.artifact}
							title={t('Workbench preview')}
							label={mine === undefined ? t('Live') : `!${mine.id} ${mine.title}`}
							status={building ? running : undefined}
							{t}
						>
							{#snippet details()}
								{#if p !== undefined}
									<div class="space-y-2 text-xs leading-relaxed">
										<p class="font-medium text-foreground">{t('Preview of this change')}</p>
										<p>
											{t('It runs on its own copy of live data and closes after two idle hours.')}
										</p>
									</div>
								{/if}
							{/snippet}
							{#snippet menu(close: () => void)}
								<Button
									size="sm"
									variant="ghost"
									class="justify-start"
									disabled={locked}
									onclick={() => (close(), fork(buildPreview()))}
								>
									<Icon name="lucide:refresh-cw" class="size-3.5" />{t('Rebuild preview')}
								</Button>
							{/snippet}
						</PreviewFrame>
						{#if view.previewControl?.holder === 'norbius'}
							<div
								class="bg-background/70 absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]"
							>
								<div
									class="border-border bg-card flex max-w-sm flex-col items-center gap-2 rounded-lg border p-4 text-center shadow-lg"
								>
									<Icon name="lucide:bot" class="size-5" />
									<p class="text-sm font-medium">{t('Norbius is using this preview')}</p>
									<p class="text-muted-foreground text-xs">
										{t('Take control to use it yourself; Norbius is told you did.')}
									</p>
									<Button
										size="sm"
										onclick={() => (mine !== undefined ? fork(takeControl(mine.id)) : undefined)}
										>{t('Take control')}</Button
									>
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</Stack>
		{:else}
			<Stack gap="none" fill class="min-h-0">
				<div class="min-h-0 flex-1">
					<SourceEditor
						path={file}
						value={source ?? ''}
						baseline={view.changes.find((c) => c.path === file)?.baseline}
						{diff}
						deleted={drafts[file] === null}
						{note}
						fileCount={files.length}
						against={t('against Live')}
						onChange={edit}
						onDiff={() => (diff = !diff)}
						onDelete={() => (drafts[file] = null)}
						{t}
					/>
				</div>
				<DiagnosisPane
					diagnostics={view.diagnostics}
					stale={draftCount > 0}
					busy={locked}
					progress={building ? running : undefined}
					onopen={openFile}
					onrerun={() => fork(diagnose())}
					{t}
				/>
			</Stack>
		{/if}
	{/if}
{/snippet}

{#snippet changesMain()}
	{#if view !== null}
		{#key current?.id ?? ''}
			<ChangePane
				{view}
				change={current}
				{admin}
				busy={locked}
				onopen={(p) => {
					openFile(p);
					diff = true;
				}}
				onnew={() => fork(newChange())}
				onmerge={(c) => fork(merge(c))}
				run={(op) => (op.op === 'change.open' && 'id' in op ? workOn(op.id) : run(op))}
				{t}
			/>
		{/key}
	{/if}
{/snippet}

{#snippet liveMain()}
	{#if view !== null}
		<LivePane
			{api}
			{view}
			{admin}
			busy={locked}
			sub={active === 'usage' ? 'usage' : active === 'runtime' ? 'runtime' : 'operations'}
			onsub={go}
			onoperate={monitorRun}
			{t}
		/>
	{/if}
{/snippet}

{#snippet loadingPane()}
	<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
		{#if error === null}<Icon name="lucide:loader-2" class="size-6 animate-spin opacity-40" />
			<p class="text-xs">{t('Loading…')}</p>
		{:else}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	</Stack>
{/snippet}
{#snippet workbenchTab()}{#if view === null}{@render loadingPane()}{:else}{@render frame(
			sourceNav,
			workbenchMain,
			toolbar
		)}{/if}{/snippet}
{#snippet changesTab()}{#if view === null}{@render loadingPane()}{:else}{@render frame(
			changesNav,
			changesMain
		)}{/if}{/snippet}
{#snippet liveTab()}{#if view === null}{@render loadingPane()}{:else}{@render liveMain()}{/if}{/snippet}
{#snippet rulesTab()}
	{#if view === null}{@render loadingPane()}{:else}<AuditRules
			rules={shownRules}
			audit={audited}
			busy={auditing}
			error={auditError ?? readRules.error?.message ?? null}
			onsave={(revision, ruleSet) =>
				fork(auditCall(api.studioAuditSave(revision, ruleSet), (saved) => (savedRules = saved)))}
			ontry={(ruleSet) => fork(auditCall(api.studioAudit(ruleSet), (found) => (audited = found)))}
			onaudit={() => fork(auditCall(api.studioAudit(), (found) => (audited = found)))}
			onopen={(path) => {
				go('workbench');
				openFile(path);
			}}
			{t}
		/>{/if}
{/snippet}

{#snippet browse()}
	{#if root !== 'live'}
		<Button
			variant="ghost"
			size="sm"
			class="shrink-0 md:hidden"
			aria-label={t('Open the navigator')}
			onclick={() => (browsing = true)}
		>
			<Icon name="lucide:panel-bottom" class="size-4" />{t('Browse')}
		</Button>
	{/if}
{/snippet}

<Stack gap="none" grow class="min-h-0 bg-background">
	<AppHeader
		src={studioBanner}
		icon="lucide:code-xml"
		title={t('Workspace Studio')}
		description={t(
			'Edit in a change, preview the exact result on a copy of live’s data, then merge.'
		)}
		compact={narrow.current}
	/>
	{#if banner !== null}
		<Inline
			role="status"
			gap="sm"
			class="mx-4 mt-3 min-w-0 max-w-full shrink-0 rounded-md px-3 py-2 text-xs sm:mx-6 sm:max-w-[32rem] {outcome ===
			'failed'
				? 'bg-destructive/10 text-destructive'
				: outcome === 'done'
					? 'bg-success/10 text-foreground'
					: 'bg-info/10 text-foreground'}"
		>
			{#if outcome === 'running' || outcome === 'asking'}<Spinner class="size-3.5 shrink-0" />
			{:else}<Icon
					name={outcome === 'failed' ? 'lucide:circle-alert' : 'lucide:circle-check'}
					class="size-3.5 shrink-0"
				/>{/if}
			<span class="min-w-0 truncate" title={banner}>{banner}</span>
			{#if outcome !== 'running' && outcome !== 'asking'}
				<Inline gap="xs" class="shrink-0">
					{#if outcome === 'done' && cutover?.undo !== undefined}
						{@const undo = cutover.undo}
						<Button
							size="sm"
							variant="outline"
							onclick={() => {
								cutover = null;
								fork(rollback(undo));
							}}><Icon name="lucide:undo-2" class="size-3.5" />{t('Undo')}</Button
						>
					{/if}
					<Button size="sm" variant="ghost" onclick={() => (cutover = null)}>{t('Dismiss')}</Button>
				</Inline>
			{/if}
		</Inline>
	{/if}
	{#if view !== null}
		{#if error !== null && root !== 'workbench' && outcome !== 'failed'}
			<p
				role="alert"
				class="mx-4 mt-3 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6"
			>
				{error}
			</p>
		{/if}
		{#each view.approvals ?? [] as held (held.id)}
			<Inline
				role="group"
				aria-label={t('Norbius asks')}
				gap="sm"
				justify="between"
				class="mx-4 mt-3 shrink-0 rounded-md border border-border bg-card px-3 py-2 text-xs sm:mx-6"
				data-approval={held.id}
			>
				<span class="min-w-0">
					<span class="font-medium text-foreground">{t('Norbius asks')}: {asked(held)}</span>
					<span class="text-muted-foreground"
						>· <time datetime={held.at}>{new Date(held.at).toLocaleString()}</time
						>{#if (held.destructive?.length ?? 0) > 0}
							· {t('destructive')}: {held.destructive?.join(', ')}{/if}</span
					>
				</span>
				<Inline gap="xs" class="shrink-0">
					<Button size="sm" disabled={locked} onclick={() => fork(decide(held, 'approved'))}
						>{t('Approve')}</Button
					>
					<Button
						size="sm"
						variant="outline"
						disabled={locked}
						onclick={() => fork(decide(held, 'rejected'))}>{t('Reject')}</Button
					>
				</Inline>
			</Inline>
		{/each}
	{/if}
	<Tabs
		value={root}
		onValueChange={(v) => go(v === 'changes' || v === 'live' || v === 'rules' ? v : 'workbench')}
		trailing={browse}
		class="mt-4 min-h-0 flex-1 gap-3 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6"
		tabs={[
			{ name: 'workbench', title: t('Workbench'), body: workbenchTab, keepAlive: true as const },
			{ name: 'changes', title: t('Changes'), body: changesTab },
			{ name: 'live', title: t('Live'), body: liveTab },
			...(admin ? [{ name: 'rules', title: t('Audit rules'), body: rulesTab }] : [])
		]}
	/>
</Stack>

{#if view !== null}
	<Sheet bind:open={browsing} title={t('Workspace navigator')}>
		<Stack gap="none" fill class="min-h-0">
			{#if root === 'workbench'}{@render sourceNav()}{:else if root === 'changes'}{@render changesNav()}{/if}
		</Stack>
	</Sheet>
{/if}

<Dialog.Root
	open={scheduling !== null}
	onOpenChange={(open) => {
		if (!open) scheduling?.answer(null);
	}}
>
	<Dialog.Content class="max-w-md">
		{#if scheduling !== null}
			{@const asking = scheduling}
			<Dialog.Header>
				<Dialog.Title>{t('Schedule the merge')}</Dialog.Title>
				<Dialog.Description
					>{t(
						'It merges at that time. The workspace is down only while it switches over: open pages show that it is updating, then reload.'
					)}</Dialog.Description
				>
			</Dialog.Header>
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					asking.answer(asking.when === '' ? null : asking.when);
				}}
			>
				<div class="flex flex-col gap-1.5">
					<label for="studio-merge-at" class="text-label">{t('Merge at')}</label>
					<Input id="studio-merge-at" type="datetime-local" bind:value={asking.when} />
				</div>
				<Dialog.Footer>
					<Button type="button" variant="ghost" onclick={() => asking.answer(null)}
						>{t('Cancel')}</Button
					>
					<Button type="submit">{t('Schedule')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={describing !== null}
	onOpenChange={(open) => {
		if (!open) describing?.answer(null);
	}}
>
	<Dialog.Content class="max-w-md">
		{#if describing !== null}
			{@const asking = describing}
			<Dialog.Header>
				<Dialog.Title>{t('Save your changes')}</Dialog.Title>
				<Dialog.Description
					>{t(
						'Describe the edit in a few words. The change and its merge show it.'
					)}</Dialog.Description
				>
			</Dialog.Header>
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					asking.answer(asking.text.trim() || asking.suggestion);
				}}
			>
				<div class="flex flex-col gap-1.5">
					<label for="studio-save-message" class="text-label"
						>{t('What does this change do?')}</label
					>
					<Input
						id="studio-save-message"
						maxlength={200}
						placeholder={asking.suggestion}
						bind:value={asking.text}
					/>
				</div>
				<Dialog.Footer>
					<Button type="button" variant="ghost" onclick={() => asking.answer(null)}
						>{t('Cancel')}</Button
					>
					<Button type="submit">{t('Save')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
