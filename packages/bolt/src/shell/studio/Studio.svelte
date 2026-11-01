<!--
	Workspace Studio (§5.10, §7) over the host's Studio port: a title, one toolbar (the change and its actions), and
	under it a navigator rail (a bottom sheet on a phone) beside the main pane. The rail's two icon tabs switch between
	the source tree and the change list; the pane follows — the editor and diagnosis, or the selected change's files,
	preview, manifest and logs. The change's behind/status badges sit in the app header. The viewer works on one change at
	a time: a named set of edits from live with its own preview on a copy-on-write fork of live's data. Source is the
	tree and the editor over the last build's diagnosis; it edits source as drafts and saves them over the head it read
	(the first save with no change open opens one). A save commits. Changes lists every change and reviews one: its
	files before and after (L-BOLT-528), its preview with its tests (built from a commit, never a draft), its manifest
	and logs — and the change's own actions: Preview builds and serves the change's latest commit, Merge is the only way
	to ship, run in the background: git's 3-way merge, a build of the merged tree with its checks, then the cutover,
	recorded as a Version. Versions is the build and release timeline and rolls live back to one, source and data
	together (the confirm names what is lost when its schema differs); the state it leaves is kept as an undo Version, so
	a rollback is undone the same way. That is neither the operator's database restore nor a record's restore. What
	happens across the workspace (resource use, runtime logs, the audit trail, runs) is the command center's. Build log
	lines, a moved head, a changed change and phase frames (diagnose → copy → preview → merge, L-BOLT-530) arrive pushed.
	Each mode is a deep link (`/studio/<mode>`; `/studio` is source). Studio is a Studio host's only (Colony); an
	administrator's (`admin`), and the host refuses anyone else regardless.
-->
<script lang="ts">
	import { attach, fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Effect, Stream } from 'effect';
	import { studioEvents } from './events.ts';
	import { watch } from 'runed';
	import { MediaQuery } from 'svelte/reactivity';
	import { Button, confirmAction, Dialog, Icon, Input, Sheet, Spinner } from '@norbital-ai/ui';
	import { Inline, AppHeader, INSET_X_CLASS, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { tick, type Snippet } from 'svelte';
	import DiagnosisPane from './DiagnosisPane.svelte';
	import ChangePane from './ChangePane.svelte';
	import SourceEditor from './SourceEditor.svelte';
	import SourceTree from './SourceTree.svelte';
	import StudioStatus from './StudioStatus.svelte';
	import WorkbenchToolbar from './WorkbenchToolbar.svelte';
	import { impactLines } from '../../protocol/migration-impact.ts';
	import studioBanner from '../assets/banners/studio.jpg';
	import {
		foldLog,
		foldPhase,
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
		type StudioOp,
		type StudioPhase,
		type StudioView
	} from './model.ts';
	import type { StudioTab } from '../nav.ts';
	import type { ShellApi } from '../api-types.ts';

	// ponytail: `admin` defaults to true until the shell passes `boot.admin`; the host refuses a non-administrator's admin ops either way
	let {
		api,
		t,
		tab = 'workbench',
		onTab,
		admin = true,
		eventsUrl,
		initialFile = null,
		onFile
	}: {
		api: ShellApi;
		t: (key: string) => string;
		tab?: StudioTab;
		onTab?: (tab: StudioTab) => void;
		admin?: boolean;
		/** A host can mount the same Studio outside a tenant engine, including its authenticated event stream. */
		eventsUrl?: string;
		initialFile?: string | null;
		onFile?: (path: string) => void;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');

	let view = $state<StudioView | null>(null);
	const changeSets = $derived(view?.changeSets ?? []);
	/** The builds made while a change was open, newest first: its commits in the Changes tree. */
	const commitsOf = (c: StudioChangeSet) =>
		(view?.builds ?? [])
			.filter((build) => build.at >= c.createdAt && build.at <= c.updatedAt)
			.toSorted((a, b) => b.at.localeCompare(a.at));
	let error = $state<string | null>(null);
	let busy = $state(false);
	let file = $state('');
	let drafts = $state<{ [path: string]: string | null }>({});
	// the URL's tab; a click shows it at once and asks the shell to move the URL (a back navigation moves it again)
	let active = $derived(tab);
	function go(next: StudioTab): void {
		active = next;
		onTab?.(next);
		if (narrow.current) browsing = false;
	}
	const root = $derived(active === 'changes' || active === 'versions' ? active : 'workbench');
	let phases = $state<{ [p in StudioPhase]?: PhaseState }>({});
	// the furthest phase the current run reached (`reach`: never back), when it started, and whether it builds a preview
	let step = $state(-1);
	let since = $state(0);
	let building = $state(false);
	let diff = $state(false);
	let selected = $state<string | null>(null);
	let browsing = $state(false);
	let sourceCollapsed = $state(false);
	let sourceQuery = $state('');
	let openedInitialFile: string | null = null;
	watch(
		() => [initialFile, view?.files] as const,
		([path, files]) => {
			if (path === null) {
				openedInitialFile = null;
				return;
			}
			if (files === undefined || path === openedInitialFile) return;
			openedInitialFile = path;
			if (Object.hasOwn(files, path)) openFile(path);
			else sourceQuery = path.slice(0, path.lastIndexOf('/'));
		}
	);
	let sourceFolds = $state<{ [dir: string]: boolean }>({});
	let sourceToggle = $state<HTMLButtonElement | null>(null);
	const id = $props.id();
	const sourceId = `${id}-source`;
	const sourceSheetId = `${id}-source-sheet`;
	const sourceOpen = $derived(narrow.current ? browsing : !sourceCollapsed);
	async function toggleSource(): Promise<void> {
		if (!narrow.current) {
			sourceCollapsed = !sourceCollapsed;
			return;
		}
		if (browsing) {
			browsing = false;
			sourceToggle?.focus();
			return;
		}
		browsing = true;
		await tick();
		document.getElementById(sourceSheetId)?.querySelector<HTMLInputElement>('input')?.focus();
	}
	watch(
		() => narrow.current,
		(isNarrow) => {
			if (!isNarrow) {
				if (document.getElementById(sourceSheetId)?.contains(document.activeElement))
					sourceToggle?.focus();
				browsing = false;
			}
		}
	);
	function sourceKeydown(event: KeyboardEvent): void {
		if (
			event.key !== 'Escape' ||
			event.defaultPrevented ||
			narrow.current ||
			root !== 'workbench' ||
			sourceCollapsed ||
			!(event.target instanceof Node) ||
			!document.getElementById(sourceId)?.contains(event.target)
		)
			return;
		event.preventDefault();
		sourceCollapsed = true;
		sourceToggle?.focus();
	}

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
	const observe = attach(() =>
		load().pipe(
			Effect.andThen(
				typeof EventSource === 'undefined'
					? Effect.void
					: studioEvents(eventsUrl).pipe(
							Stream.runForEach((frame) => {
								if (view === null) return Effect.void;
								if (frame.kind === 'tests') return load();
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
	/**
	 * A merge's confirmation and when, asked in one dialog: now, or at a local date and time. The answer is `null` when
	 * dismissed; `at` is `null` for now.
	 */
	type MergePlan = { at: string | null };
	let planning = $state<{
		id: string;
		body: string;
		when: string;
		mode: 'now' | 'later';
		answer: (plan: MergePlan | null) => void;
	} | null>(null);
	const localInput = (at: Date) =>
		new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	const askMerge = (id: string, body: string) =>
		Effect.callback<MergePlan | null>((resume) => {
			planning = {
				id,
				body,
				when: localInput(new Date(Date.now() + 3_600_000)),
				mode: 'now',
				answer: (plan) => {
					planning = null;
					resume(Effect.succeed(plan));
				}
			};
			return Effect.sync(() => {
				planning = null;
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
		ask: Effect.Effect<boolean>,
		work: Effect.Effect<boolean>,
		follow: { change?: string } = {}
	) {
		if (locked) return false;
		cutover = { outcome: 'asking' };
		if (!(yield* ask)) return ((cutover = null), false);
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
	/**
	 * Merges a change into live. The viewer's own unsaved drafts are saved (with their description) first; the dialog
	 * confirms and chooses now or a later instant; the destructive steps its current preview names are what it accepts.
	 */
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
		const body = `${current.title}${current.id === view?.change ? ` · ${changedFiles(view.changes.length)}` : ''}. ${
			accept.length > 0
				? `${t('This applies destructive schema steps:')} ${accept.join(', ')}. `
				: ''
		}${
			current.preview.impact === undefined
				? ''
				: `${impactLines(current.preview.impact, t).join('. ')}. `
		}${t('It merges with live, builds and checks the result, then everyone using the workspace gets it.')}`;
		let at: string | null = null;
		yield* approved(
			askMerge(current.id, body).pipe(
				Effect.map((plan) => {
					if (plan === null) return false;
					at = plan.at;
					return true;
				})
			),
			Effect.suspend(() =>
				run(
					at === null
						? {
								op: 'change.merge',
								id: current.id,
								...(accept.length > 0 ? { accept } : {})
							}
						: { op: 'change.merge', id: current.id, at, ...(accept.length > 0 ? { accept } : {}) }
				)
			),
			{ change: current.id }
		);
	});
	/** Close a change: its preview and its copy of the data go; its edits stay in history. */
	const close = Effect.fn('Studio.close')(function* (c: StudioChangeSet) {
		if (locked) return;
		const ok = yield* confirmAction({
			title: t('Close this change?'),
			body: t('Its edits stay in history; its preview and its copy of the data are deleted.'),
			confirmLabel: t('Close change'),
			cancelLabel: t('Cancel'),
			destructive: true
		});
		if (ok) yield* run({ op: 'change.close', id: c.id });
	});
	/** A rollback: the Version's source and data come back together; a schema change loses later data. */
	const rollback = Effect.fn('Studio.rollback')(function* (commit: string) {
		const target = releases.find((r) => r.commit === commit);
		// a Version without a restorable checkpoint is never offered: the host would refuse it
		if (target === undefined || target.checkpoint === null) return;
		const lost = target.discards;
		const when = new Date(target.checkpoint ?? target.at).toLocaleString();
		const ok = yield* approved(
			confirmAction({
				title: t(target.undo ? 'Undo the rollback?' : 'Roll back live to this version?'),
				body: `${when} — ${target.message || commit.slice(0, 8)}. ${
					lost === undefined
						? t('Its source comes back and live keeps all its data.')
						: `${t('Its schema differs from live’s, so the data written after')} ${new Date(lost).toLocaleString()} ${t('will be lost.')}`
				} ${t('Live as it is now is kept, so this can be undone. Everyone stays signed in.')}`,
				confirmLabel: t(target.undo ? 'Undo' : 'Roll back'),
				cancelLabel: t('Cancel'),
				destructive: lost !== undefined
			}),
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
			? `${t('Merge')} ${t('Change')} ${held.op.id}`
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
					confirmAction({
						title: `${asked(held)}?`,
						body: `${
							(held.destructive?.length ?? 0) > 0
								? `${t('This applies destructive schema steps:')} ${held.destructive?.join(', ')}. `
								: ''
						}${heldImpact(held)}${t('Everyone using the workspace gets this version once it is switched over.')}`,
						confirmLabel: t('Approve'),
						cancelLabel: t('Cancel'),
						destructive: (held.destructive?.length ?? 0) > 0
					}),
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
	/** A preview build of the change's latest commit (never a draft), served as the change's preview. */
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
	/** The new-change dialog: asks what the change is for; `null` when cancelled. */
	let naming = $state<{ title: string; answer: (title: string | null) => void } | null>(null);
	const askTitle = () =>
		Effect.callback<string | null>((resume) => {
			naming = {
				title: '',
				answer: (title) => {
					naming = null;
					resume(Effect.succeed(title));
				}
			};
			return Effect.sync(() => {
				naming = null;
			});
		});
	/** A new change: unsaved drafts go to the change they were made on, or, with none open, into the new one. */
	const newChange = Effect.fn('Studio.newChange')(function* () {
		const title = (yield* askTitle())?.trim();
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
	function create(dir = ''): void {
		const prefix = dir === '' ? '' : `${dir}/`;
		const path = prompt(t('New file path'), prefix)?.trim();
		if (!path) return;
		// an existing path opens; a deleted one is restored; a new one starts empty
		if (drafts[path] === null) delete drafts[path];
		else if (drafts[path] === undefined && !(view !== null && path in view.files))
			drafts[path] = '';
		file = path;
	}
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
	function openFile(path: string): void {
		file = path;
		const changed = view?.changes.find((change) => change.path === path);
		diff = changed !== undefined && changed.baseline !== undefined;
		if (browsing && narrow.current) sourceToggle?.focus();
		browsing = false;
		if (onFile !== undefined && path !== initialFile) onFile(path);
		else if (active !== 'workbench') go('workbench');
	}
	/** Generated, installed and VCS files are not authoring source. */
	const isSource = (path: string) =>
		path !== '.norbital' &&
		!path.startsWith('.norbital/') &&
		path !== 'node_modules' &&
		!path.startsWith('node_modules/') &&
		path !== '.git' &&
		!path.startsWith('.git/');
	const files = $derived(
		view === null
			? []
			: [
					...new Set([
						...Object.keys(view.files),
						...Object.keys(drafts),
						...view.changes
							.filter((change) => change.change === 'deleted')
							.map((change) => change.path)
					])
				]
					.filter(isSource)
					.sort()
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
	const deleted = $derived(
		drafts[file] === null ||
			(view?.changes.some((change) => change.path === file && change.change === 'deleted') ?? false)
	);
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
<svelte:document onkeydown={sourceKeydown} />

<!-- the navigator rail beside the pane (a bottom sheet on a phone) and the pane -->
{#snippet frame(navigator: Snippet, main: Snippet, top: Snippet)}
	<Stack gap="none" size="fill" class="pb-4 sm:pb-6 {INSET_X_CLASS}">
		<div
			class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60"
		>
			{@render top()}
			<Inline align="stretch" gap="none" size="fill" class="min-w-0">
				<aside
					id={sourceId}
					class="hidden shrink-0 overflow-hidden bg-card transition-[width] duration-200 ease-linear md:block"
					style:width={sourceCollapsed ? '0rem' : '18rem'}
					inert={sourceCollapsed}
					aria-hidden={sourceCollapsed ? true : undefined}
					aria-label={t('Workspace navigator')}
				>
					<Stack gap="none" size="fill" class="w-72 border-r border-border/60"
						>{@render navigator()}</Stack
					>
				</aside>
				<div class="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
					{@render main()}
				</div>
			</Inline>
		</div>
	</Stack>
{/snippet}

{#snippet railHeader()}
	<Inline gap="xs" class="border-b border-border/60 px-2 py-1 text-muted-foreground">
		<Inline gap="none" role="group" aria-label={t('Workspace navigator')} class="shrink-0">
			<Button
				variant={root === 'workbench' ? 'secondary' : 'ghost'}
				size="icon"
				class="shrink-0"
				aria-label={t('Source')}
				title={t('Source')}
				aria-pressed={root === 'workbench'}
				onclick={() => go('workbench')}
			>
				<Icon name="lucide:file-code-2" class="size-4" />
			</Button>
			<Button
				variant={root === 'changes' ? 'secondary' : 'ghost'}
				size="icon"
				class="shrink-0"
				aria-label={t('Changes')}
				title={t('Changes')}
				aria-pressed={root === 'changes'}
				onclick={() => go('changes')}
			>
				<Icon name="lucide:git-branch" class="size-4" />
			</Button>
		</Inline>
		{#if root === 'workbench'}
			{#if files.length > 0}<span
					class="shrink-0 rounded-full bg-muted px-1.5 py-px text-tiny font-semibold tabular-nums"
					>{files.length}</span
				>{/if}
			<label class="relative ml-auto min-w-0 flex-1">
				<Icon
					name="lucide:search"
					class="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 opacity-70"
				/>
				<input
					type="search"
					bind:value={sourceQuery}
					aria-label={t('Filter source files')}
					placeholder={t('Filter')}
					class="block h-8 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pr-2 pl-6 text-xs text-foreground placeholder:text-muted-foreground"
				/>
			</label>
			<Button
				variant="ghost"
				size="icon"
				class="shrink-0"
				aria-label={t('New file')}
				title={t('New file')}
				disabled={locked}
				onclick={() => create('')}
			>
				<Icon name="lucide:file-plus" class="size-4" />
			</Button>
		{:else}
			<span class="ml-auto shrink-0 px-1.5 text-tiny font-semibold tabular-nums"
				>{changeSets.length}</span
			>
			{#if mine !== undefined}
				<Button
					variant="ghost"
					size="icon"
					class="shrink-0"
					aria-label={t('New change')}
					title={t('New change')}
					disabled={locked}
					onclick={() => fork(newChange())}
				>
					<Icon name="lucide:git-branch-plus" class="size-4" />
				</Button>
			{/if}
		{/if}
	</Inline>
{/snippet}

{#snippet sourceNav()}
	{#if view !== null}
		<Stack gap="none" size="fill">
			<SourceTree
				{files}
				base={view.files}
				changes={view.changes}
				{drafts}
				selected={file}
				bind:query={sourceQuery}
				bind:folds={sourceFolds}
				onselect={openFile}
				oncreate={create}
				{t}
			/>
			<div class="border-t border-border/60 bg-card/40 p-3 min-h-16">
				<Inline gap="xs" class="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
					<Icon name="lucide:package" class="size-3.5 shrink-0 text-muted-foreground" />
					<Stack gap="none" size="fill" class="min-w-0">
						<span class="text-overline text-foreground">{t('Dependencies')}</span>
						<span class="truncate text-tiny text-muted-foreground">
							{view.files['package.json'] === undefined
								? t('No package.json')
								: `package.json · ${sizeText(view.files['package.json'].bytes)}`}
						</span>
					</Stack>
					<Button
						variant="ghost"
						size="icon"
						class="shrink-0"
						aria-label={t('Install package')}
						title={t('Install package')}
						disabled={locked}
						onclick={installPackage}
					>
						<Icon name="lucide:package-plus" class="size-4" />
					</Button>
				</Inline>
			</div>
		</Stack>
	{/if}
{/snippet}

{#snippet changesNav()}
	<Scroll name={t('Changes')} layout="stack" gap="xs" size="fill" class="p-2">
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
				<span class="block truncate text-xs font-medium text-foreground"
					>{t('Change')} {c.id} · {c.title}</span
				>
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
			{#if commitsOf(c).length > 0}
				<ul class="mb-2 ml-4 border-l border-border/70 pl-2" data-change-commits={c.id}>
					{#each commitsOf(c) as build (build.commit)}
						<li class="flex min-w-0 items-center gap-1.5 py-0.5 text-micro text-muted-foreground">
							<span
								class="size-1.5 shrink-0 rounded-full {build.status === 'failed'
									? 'bg-destructive'
									: 'bg-muted-foreground/50'}"
							></span>
							<code class="shrink-0" title={build.commit}>{build.commit.slice(0, 7)}</code>
							<span class="min-w-0 flex-1 truncate" title={build.message}>{build.message}</span>
							<span class="shrink-0 {build.status === 'failed' ? 'text-destructive' : ''}"
								>{t(build.status === 'failed' ? 'Failed' : 'Built')}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="px-2 py-2 text-micro text-muted-foreground">{t('No changes yet.')}</p>
		{/each}
	</Scroll>
{/snippet}

{#snippet navigatorButton()}
	<Button
		bind:ref={sourceToggle}
		variant="ghost"
		size="icon"
		class="shrink-0"
		aria-label={t(sourceOpen ? 'Hide navigator' : 'Show navigator')}
		title={t(sourceOpen ? 'Hide navigator' : 'Show navigator')}
		aria-expanded={sourceOpen}
		aria-controls={narrow.current ? (browsing ? sourceSheetId : undefined) : sourceId}
		onclick={toggleSource}
	>
		<Icon name="lucide:panel-left" class="size-4" />
	</Button>
{/snippet}

{#snippet toolbar()}
	{#if view !== null}
		<WorkbenchToolbar
			{view}
			navigator={navigatorButton}
			{admin}
			busy={locked}
			drafts={draftCount}
			{t}
			onsave={() => fork(save())}
			onopen={() => fork(newChange())}
			onmerge={() => {
				if (mine !== undefined) fork(merge(mine));
			}}
			onclose={() => {
				if (mine !== undefined) fork(close(mine));
			}}
			onunschedule={() => {
				if (mine !== undefined) fork(run({ op: 'change.unschedule', id: mine.id }));
			}}
			onreview={() => {
				selected = view?.change ?? null;
				go('changes');
			}}
		/>
	{/if}
{/snippet}

{#snippet workbenchMain()}
	{#if view !== null}
		<Stack gap="none" size="fill">
			<div class="min-h-0 flex-1">
				<SourceEditor
					path={file}
					value={source ?? ''}
					baseline={view.changes.find((c) => c.path === file)?.baseline}
					{diff}
					deleted
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
{/snippet}

{#snippet changesMain()}
	{#if view !== null}
		{#key current?.id ?? ''}
			<ChangePane
				{view}
				change={current}
				busy={locked}
				onopen={(p) => {
					openFile(p);
					diff = true;
				}}
				onpreview={() => fork(buildPreview())}
				onrelease={() => {
					if (mine !== undefined) fork(takeControl(mine.id));
				}}
				progress={building ? running : undefined}
				run={(op) => (op.op === 'change.open' && 'id' in op ? workOn(op.id) : run(op))}
				{t}
			/>
		{/key}
	{/if}
{/snippet}

{#snippet loadingPane()}
	<Stack gap="sm" align="center" justify="center" size="fill" class="text-muted-foreground">
		{#if error === null}<Icon name="lucide:loader-2" class="size-6 animate-spin opacity-40" />
			<p class="text-xs">{t('Loading…')}</p>
		{:else}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	</Stack>
{/snippet}
{#snippet frameTop()}
	{@render toolbar()}
	{#if root === 'workbench' && view !== null && (view.conflicts?.length ?? 0) > 0}
		<Inline
			gap="xs"
			role="alert"
			class="border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive"
		>
			<Icon name="lucide:triangle-alert" class="size-3 shrink-0" /><span class="truncate text-xs"
				>{t('Resolve the conflict markers in')} {view.conflicts?.join(', ')}</span
			>
		</Inline>
	{/if}
{/snippet}
{#snippet rail()}
	{@render railHeader()}
	{#if root === 'changes'}{@render changesNav()}{:else}{@render sourceNav()}{/if}
{/snippet}
{#snippet activeMain()}
	{#if root === 'changes'}{@render changesMain()}{:else}{@render workbenchMain()}{/if}
{/snippet}

{#snippet headerActions()}
	{#if error !== null && outcome !== 'failed'}
		<Inline
			role="alert"
			gap="xs"
			class="min-w-0 max-w-[26rem] rounded-md border border-destructive/40 bg-background/90 px-2.5 py-1 text-xs text-destructive shadow-xs"
		>
			<Icon name="lucide:circle-alert" class="size-3.5 shrink-0" />
			<span class="min-w-0 truncate" title={error}>{error}</span>
		</Inline>
	{/if}
	{#if view !== null}<StudioStatus {view} busy={locked} {phases} {t} />{/if}
	{#if banner !== null}
		<Inline
			role="status"
			gap="sm"
			class="min-w-0 max-w-[32rem] rounded-md border border-border/60 bg-background/90 px-2.5 py-1 text-xs shadow-xs {outcome ===
			'failed'
				? 'text-destructive'
				: 'text-foreground'}"
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
							variant="outline"
							onclick={() => {
								cutover = null;
								fork(rollback(undo));
							}}><Icon name="lucide:undo-2" class="size-3.5" />{t('Undo')}</Button
						>
					{/if}
					<Button variant="ghost" onclick={() => (cutover = null)}>{t('Dismiss')}</Button>
				</Inline>
			{/if}
		</Inline>
	{/if}
{/snippet}

<Stack gap="none" size="fill" class="bg-background">
	<AppHeader
		src={studioBanner}
		icon="lucide:code-xml"
		title={t('Workspace Studio')}
		description={t(
			'Edit in a change, preview the exact result on a copy of live’s data, then merge.'
		)}
		compact={narrow.current}
		actions={headerActions}
		class="md:h-24"
	/>
	{#if view !== null}
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
					<Button disabled={locked} onclick={() => fork(decide(held, 'approved'))}
						>{t('Approve')}</Button
					>
					<Button variant="outline" disabled={locked} onclick={() => fork(decide(held, 'rejected'))}
						>{t('Reject')}</Button
					>
				</Inline>
			</Inline>
		{/each}
	{/if}
	<div class="mt-3 flex min-h-0 flex-1 flex-col">
		{#if view === null}{@render loadingPane()}{:else}{@render frame(
				rail,
				activeMain,
				frameTop
			)}{/if}
	</div>
</Stack>

{#if view !== null}
	<Sheet
		bind:open={browsing}
		title={t('Workspace navigator')}
		onOpenChange={(open) => {
			if (!open) sourceToggle?.focus();
		}}
	>
		<Stack gap="none" size="fill" id={sourceSheetId} data-studio-source-sheet>
			{@render rail()}
		</Stack>
	</Sheet>
{/if}

<Dialog.Root
	open={planning !== null}
	onOpenChange={(open) => {
		if (!open) planning?.answer(null);
	}}
>
	<Dialog.Content class="max-w-md">
		{#if planning !== null}
			{@const asking = planning}
			<Dialog.Header>
				<Dialog.Title>{t('Merge')} {t('Change')} {asking.id} {t('into live?')}</Dialog.Title>
				<Dialog.Description>{asking.body}</Dialog.Description>
			</Dialog.Header>
			<form
				class="flex flex-col gap-3 pb-6 md:pb-0"
				onsubmit={(event) => {
					event.preventDefault();
					asking.answer({ at: asking.mode === 'later' ? asking.when : null });
				}}
			>
				<fieldset class="grid gap-2">
					<legend class="text-label">{t('When')}</legend>
					<label class="flex items-center gap-2">
						<input type="radio" class="accent-primary" bind:group={asking.mode} value="now" />
						{t('Now')}
					</label>
					<label class="flex items-center gap-2">
						<input type="radio" class="accent-primary" bind:group={asking.mode} value="later" />
						{t('At a time')}
					</label>
				</fieldset>
				{#if asking.mode === 'later'}
					<div class="flex flex-col gap-1.5">
						<label for="studio-merge-at" class="text-label">{t('Merge at')}</label>
						<Input id="studio-merge-at" type="datetime-local" required bind:value={asking.when} />
					</div>
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="ghost" onclick={() => asking.answer(null)}
						>{t('Cancel')}</Button
					>
					<Button type="submit" disabled={asking.mode === 'later' && asking.when === ''}
						>{asking.mode === 'later' ? t('Schedule merge') : t('Merge now')}</Button
					>
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
				class="flex flex-col gap-3 pb-6 md:pb-0"
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

<Dialog.Root
	open={naming !== null}
	onOpenChange={(open) => {
		if (!open) naming?.answer(null);
	}}
>
	<Dialog.Content class="max-w-md">
		{#if naming !== null}
			{@const asking = naming}
			<Dialog.Header>
				<Dialog.Title>{t('New change')}</Dialog.Title>
				<Dialog.Description
					>{t(
						'A change is a named set of edits from live, with its own preview on a copy of live’s data.'
					)}</Dialog.Description
				>
			</Dialog.Header>
			<form
				class="flex flex-col gap-3 pb-6 md:pb-0"
				onsubmit={(event) => {
					event.preventDefault();
					asking.answer(asking.title.trim() || null);
				}}
			>
				<div class="flex flex-col gap-1.5">
					<label for="studio-change-title" class="text-label">{t('What is this change for?')}</label
					>
					<Input id="studio-change-title" maxlength={200} required bind:value={asking.title} />
				</div>
				<Dialog.Footer>
					<Button type="button" variant="ghost" onclick={() => asking.answer(null)}
						>{t('Cancel')}</Button
					>
					<Button type="submit" disabled={asking.title.trim() === ''}>{t('Create')}</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
