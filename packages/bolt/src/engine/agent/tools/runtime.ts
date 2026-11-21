import { Effect, Option, Predicate, PubSub } from 'effect';
import type { WorkspacePort } from '@norbital-ai/host-api';
import { RUN_VIEW_COLUMNS, RunViewRow, run_view, runPending } from '../../runs/rows.ts';
import type { ToolAnswer } from '../ai.ts';
import { isObj } from '../draft.ts';
import { RUN_JS, runFile, runJs } from '../run-js.ts';
import {
	askTool,
	readSource,
	runJsTool,
	taskReadTool,
	taskStopTool,
	taskTool,
	waitTool
} from './definitions.ts';
import { conversationFiles, referenceTree, storeFile } from './files.ts';
import { err, ok, readsOnly, scriptRead, textAnswer } from './helpers.ts';
import { JOBS } from './jobs.ts';
import type {
	AddTool,
	BoundTool,
	Catalogue,
	HoldTool,
	Skill,
	ToolContext
} from './types.ts';

export function bindRuntimeTools(
	x: ToolContext,
	add: AddTool,
	hold: HoldTool,
	options: {
		readonly agent: boolean;
		readonly staff: boolean;
		readonly source: WorkspacePort | undefined;
		readonly skills: readonly (readonly [string, Skill])[];
		readonly entries: ReadonlyMap<string, BoundTool>;
		readonly mcpEntries: ReadonlyMap<string, BoundTool>;
		readonly getSelf: () => Catalogue['run'] | undefined;
	}
): void {
	const { agent, staff, source, skills, entries, mcpEntries, getSelf } = options;
	const e = x.engine,
		a = x.authority;

	if (agent) {
		add(taskTool, function* (i) {
			if (!x.agents.includes(i.subagent_type))
				return err(
					`Unknown agent type: ${i.subagent_type} is not a valid agent type. Agent types: ${x.agents.join(', ')}`
				);
			const started = yield* x.subagent.task({
				description: i.description,
				prompt: i.prompt,
				agent: i.subagent_type,
				task: i.task_id
			});
			if ('error' in started) return err(started.error);
			return textAnswer(
				[
					`<task id="${started.id}" state="running">`,
					`<summary>${started.running ? 'Background task already running' : 'Background task started'}</summary>`,
					'<task_result>',
					...(started.running
						? [
								'The task is already working in the background.',
								'The task is still working in the background. You will be notified automatically when it finishes.'
							]
						: [
								'The task is working in the background. You will be notified automatically when it finishes.'
							]),
					"DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
					`Work on non-overlapping tasks, or briefly tell the user ${started.running ? 'it is still running' : 'what you launched'} and end your response.`,
					'</task_result>',
					'</task>'
				].join('\n')
			);
		});
		add(taskReadTool, function* (i) {
			return ok(yield* x.subagent.read(i.task_id));
		});
		add(taskStopTool, function* (i) {
			return ok(yield* x.subagent.stop(i.task_id));
		});
	}

	const store = e.files,
		guest = e.guest,
		bundler = e.bundler,
		http =
			x.inApp && staff && (a.admin || a.capabilities.tools.includes('http')) ? e.http : undefined;

	const inner = (call: string) => {
		let used = 0;
		return (name: string, input: unknown): Effect.Effect<ToolAnswer> => {
			const self = getSelf();
			if (self === undefined || (entries.get(name) ?? mcpEntries.get(name))?.scripts !== true)
				return Effect.succeed(
					err(`A script cannot call '${name}': it calls your other tools by name.`)
				);
			if (++used > RUN_JS.toolCalls)
				return Effect.succeed(err(`A run makes at most ${RUN_JS.toolCalls} tool calls.`));
			const invoke = self(name, input, `${call}:${used}`);
			return name === readSource.name && source !== undefined
				? scriptRead(source, input, invoke)
				: invoke;
		};
	};

	if (agent && guest !== undefined) {
		add(runJsTool, function* (i, callId) {
			if (i.http !== undefined && i.http !== false && http === undefined)
				return err('Your policies do not grant scripts HTTP: run it without http.');
			if (i.http === 'send') {
				if (x.child)
					return err(
						'Subagents cannot run approval-gated HTTP sends; return what you found to the main agent.'
					);
				const held = hold(runJsTool.name, i, 'run a script that sends HTTP');
				if (held !== undefined) return held;
			}
			const keep =
				store === undefined
					? undefined
					: (file: { name: string; mime: string; bytes: Uint8Array }) =>
							storeFile(x, store, file);
			const granted =
				http === undefined
					? undefined
					: i.http === 'send'
						? http
						: i.http === true
							? readsOnly(http)
							: undefined;
			if (i.file === undefined) {
				if (i.code === undefined) return err('Give code, or a file to run.');
				const named = yield* conversationFiles(x, i.files ?? []);
				if (typeof named === 'string') return err(named);
				const given = i.input ?? null;
				if (named.length > 0 && given !== null && !Predicate.isObject(given))
					return err('With files, input is an object: the files join it as input.files.');
				return ok(
					yield* runJs({
						code: i.code,
						input: named.length === 0 ? given : Predicate.isObject(given) ? given : {},
						guest,
						http: granted,
						tool: inner(callId),
						files: named,
						invocation: callId,
						keep
					})
				);
			}
			if (i.code !== undefined) return err('Give code or file, not both.');
			if (bundler === undefined) return err('This workspace runs no files: give code.');
			const slash = i.file.indexOf('/'),
				name = i.file.slice(0, Math.max(slash, 0)),
				entry = i.file.slice(slash + 1);
			const reference = name.includes('@');
			if (reference && granted !== undefined)
				return err("A repository reference's file runs without fetch: run it without http.");
			const skill = reference ? undefined : skills.find(([n]) => n === name)?.[1];
			if (!reference && skill === undefined)
				return err(`No skill '${name}' is available: file is '<skill>/<path>'.`);
			if (skill !== undefined && !skill.files.includes(entry))
				return err(`The skill ${name} has no file '${entry}'.`);
			const inputs = yield* conversationFiles(x, i.files ?? []);
			if (typeof inputs === 'string') return err(inputs);
			const fileSource =
				skill === undefined
					? yield* referenceTree(x, name, entry)
					: {
							digest: skill.digest,
							tree: yield* Effect.forEach(
								skill.files,
								(path) =>
									Effect.map(skill.read(path), (bytes): readonly [string, Uint8Array] => [
										path,
										bytes
									]),
								{ concurrency: 8 }
							)
						};
			if (typeof fileSource === 'string') return err(fileSource);
			return ok(
				yield* runFile({
					entry,
					digest: fileSource.digest,
					tree: fileSource.tree,
					args: i.args ?? [],
					inputs: inputs.map((file) => [file.name, file.bytes] as const),
					guest,
					bundler,
					http: granted,
					invocation: callId,
					keep
				})
			);
		});
	}

	add(askTool, function* (i) {
		const question = i.question.trim();
		if (question === '') return err('Ask a question.');
		const optionsList = (i.options ?? [])
			.map((option) => option.trim())
			.filter((option) => option !== '');
		if (!x.ask({ question, options: [...new Set(optionsList)] }))
			return err('One question is already waiting in this step.');
		return ok({ asked: true, to: x.child ? 'the delegating agent' : 'the person' });
	});

	add(waitTool, function* (i) {
		const heard = x.heard.pipe(
			Effect.map(() =>
				ok({
					settled: null,
					pending: x.jobs.pending(),
					note: 'New input arrived: it is your next message. What you waited for keeps running.'
				})
			)
		);
		return yield* Effect.raceFirst(
			heard,
			Effect.gen(function* () {
				const ids = i.jobs ?? [];
				const ms = Math.min(Math.max(1000, (i.seconds ?? Infinity) * 1000), JOBS.waitMs);
				if (ids.length > 0 && ids.every((id) => !x.jobs.has(id))) {
					const readRuns = x.engine.db
						.rows(RunViewRow, {
							text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))`,
							params: [JSON.stringify(ids)]
						})
						.pipe(
							Effect.map((rows) =>
								rows.flatMap((row) => {
									const view = run_view(a, row);
									return view === null ? [] : [view];
								})
							)
						);
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const { runEnds } = x.engine;
							const subscription =
								runEnds === undefined ? null : yield* PubSub.subscribe(runEnds);
							const views = yield* readRuns;
							if (views.length === 0) return err(`No job or automation run ${ids.join(', ')}.`);
							const isSettled = (view: (typeof views)[number]) => !runPending(view.status);
							const settled = views.find(isSettled);
							if (settled !== undefined) return ok({ settled });
							const visible = new Set(views.map((view) => view.id));
							const waited =
								subscription === null
									? Effect.never
									: PubSub.take(subscription).pipe(
											Effect.repeat({
												until: (ended) => ended.some((id) => visible.has(id))
											})
										);
							const ended = yield* waited.pipe(Effect.timeoutOption(ms));
							if (Option.isNone(ended)) return ok({ settled: null, running: views });
							const current = yield* readRuns;
							const answer = current.find(isSettled);
							return answer === undefined
								? ok({ settled: null, running: current })
								: ok({ settled: answer });
						})
					);
				}
				if (
					ids.length === 0 &&
					x.jobs.pending().length === 0 &&
					(yield* x.subagent.running()) > 0
				)
					return ok(
						(yield* x.subagent.report(ms))
							? {
									report: 'arrived',
									note: 'A sub-agent report arrived: it is your next message.'
								}
							: { report: null, running: yield* x.subagent.running() }
					);
				if (ids.length === 0 && x.jobs.pending().length === 0)
					return ok({
						settled: null,
						pending: [],
						waited: 0,
						note: 'Nothing of this turn is running. To wait for an automation, pass its run id (a write answers the runs it started).'
					});
				const got = yield* x.jobs.wait(ids, ms);
				return ok({
					settled: got,
					pending: x.jobs.pending(),
					...(got && isObj(got.result) && typeof got.result['error'] === 'string'
						? { error: got.result['error'] }
						: {})
				});
			})
		);
	});
}
