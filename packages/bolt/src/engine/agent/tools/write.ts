import { Effect, Option, PubSub, Result, Schema } from 'effect';
import type { Json } from '../../../decl/values.ts';
import { BoltError } from '../../../protocol/errors.ts';
import { exposed } from '../../access/authority.ts';
import { decode_acts } from '../../callables/parse.ts';
import type { Authority } from '../../contracts.ts';
import { inviteMany } from '../../identity/members.ts';
import { layers } from '../../manifest.ts';
import { lower_read } from '../../query/engine.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, run_view, runPending } from '../../runs/rows.ts';
import { bounded } from '../context.ts';
import { isList, isObj } from '../draft.ts';
import type { AgentEngine as Engine } from '../index.ts';
import { outputLayers, readOutputs, receipt, requestId } from './helpers.ts';
import type { Jobs } from './jobs.ts';
import { readAs, StoredReadBack } from './read.ts';
import {
	AUTOMATION,
	CLOSED,
	Decide,
	InviteInput,
	RunInput,
	WHOLE_ROWS,
	WriteInput,
	type ToolContext
} from './types.ts';

const runEnd = (e: Engine, a: Authority, run: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const ends = e.runEnds;
			if (ends === undefined)
				return yield* BoltError.make('unavailable', 'facility', 'this host does not follow runs');
			const subscription = yield* PubSub.subscribe(ends);
			for (;;) {
				const row = yield* e.db.one(RunViewRow, {
					text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run WHERE id = $1`,
					params: [run]
				});
				if (Option.isNone(row))
					return yield* BoltError.make('invalid_input', 'admission', `run ${run} is gone`);
				const state = row.value.state;
				if (state === 'succeeded' || state === 'skipped') {
					const view = run_view(a, row.value);
					return {
						status: state,
						...(view?.result === undefined ? {} : { result: view.result })
					};
				}
				if (!runPending(state))
					return yield* Effect.fail(
						BoltError.make(
							'guest_error',
							'guest',
							state === 'stopped'
								? 'the run was stopped'
								: (row.value.error?.message ?? `the run ${state}`)
						)
					);
				while (!(yield* PubSub.take(subscription)).includes(run));
			}
		})
	);

/**
 * A run the agent started is always a job (like an ingest): `run` and `sync` answer at once with `{ job, run }`, and the run's end
 * (succeeded, failed, stopped, or the start held for approval) steers the next step once, or wakes the conversation.
 */
export const runJob = Effect.fn('AgentTool.runJob')(function* (
	jobs: Jobs,
	e: Engine,
	a: Authority,
	callable: string,
	answer: Json
) {
	if (!isObj(answer) || typeof answer['run'] !== 'string') return answer;
	const run = answer['run'],
		outcome = answer['outcome'],
		kind = isObj(outcome) ? outcome['kind'] : undefined;
	if (kind !== undefined && kind !== 'committed' && kind !== 'pending_approval') return answer;
	const name = callable.startsWith(`${AUTOMATION}.`)
		? callable.slice(AUTOMATION.length + 1)
		: callable;
	const sync_at = name.indexOf('.sync.');
	const label =
		sync_at < 0
			? `automation ${name}`
			: `sync ${name.slice(0, sync_at)}.${name.slice(sync_at + 6)}`;
	const held =
		kind === 'pending_approval' && isObj(outcome)
			? String(outcome['request_id'] ?? '')
			: undefined;
	const job = yield* jobs.add(
		label,
		held === undefined
			? runEnd(e, a, run)
			: Effect.succeed<Json>({ status: 'held', request: held }),
		{
			detach: true,
			alias: run,
			...(jobs.has(run) ? {} : { id: run }),
			done: (id, result) => {
				const r = isObj(result) ? result : {};
				const said =
					r['status'] === 'held'
						? `held for approval (request ${String(r['request'])})`
						: `${String(r['status'] ?? 'succeeded')}${r['result'] === undefined ? '' : `: ${JSON.stringify(bounded(r['result'] ?? null).value).slice(0, 600)}`}`;
				return `[job ${id} done] ${label} run ${run} → ${said}`;
			}
		}
	);
	return {
		job,
		...answer,
		note: 'Its end arrives by itself, or wakes this conversation.'
	};
});

const ConnectionRow = Schema.Struct({
	id: Schema.String,
	integration: Schema.String,
	owner: Schema.NullOr(Schema.String),
	active: Schema.Boolean,
	state: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String)
});

export const connectionRow = (e: Pick<Engine, 'db'>, id: string) =>
	Effect.map(
		e.db.rows(ConnectionRow, {
			text: `SELECT id, integration, owner, active, status->>'state' AS state, status->>'error' AS error FROM sys_integration WHERE id = $1`,
			params: [id]
		}),
		([row]) => row
	);

export const connectionOf = (row: typeof ConnectionRow.Type) => ({
	instance: row.id,
	integration: row.integration,
	owner: row.owner ?? 'workspace',
	state: !row.active
		? 'paused'
		: row.state === 'error'
			? 'failed'
			: row.state === 'reconnecting'
				? 'connected'
				: (row.state ?? 'unpaired'),
	...(row.active && row.state === 'error' && row.error !== null ? { error: row.error } : {})
});

/** A held `connect` call's connection (`{ instance }`), as it stands now. */
export const connectionFact = Effect.fnUntraced(function* (e: Pick<Engine, 'db'>, input: Json) {
	const id = isObj(input) && typeof input['instance'] === 'string' ? input['instance'] : '';
	const row = yield* connectionRow(e, id);
	return row === undefined ? { error: `No connection '${id}'.` } : connectionOf(row);
});

const PERFORMED = ['act', 'run', 'decide', 'invite'] as const;

export const performed = (name: string): name is (typeof PERFORMED)[number] =>
	PERFORMED.some((operation) => operation === name);

/** Native operations use the same execution path before and after a confirmation card. */
export const perform = Effect.fn('AgentTool.perform')(function* (
	x: Pick<ToolContext, 'engine' | 'authority' | 'bindings' | 'turn' | 'receipts'> & {
		readonly conv: { readonly id: string };
		/** The in-app agent's conversation: a start it makes for its member records it on the run's trigger. */
		readonly agent?: { readonly conversation: string };
	},
	operation: (typeof PERFORMED)[number],
	payload: Json,
	callId: string
) {
	const decode = <A>(schema: Schema.Decoder<A>) =>
		Schema.decodeUnknownEffect(
			schema,
			CLOSED
		)(payload).pipe(
			Effect.mapError((error) => BoltError.make('invalid_input', 'decode', error.message))
		);
	if (operation === 'invite') {
		if (
			x.engine.identity === undefined ||
			!x.authority.admin ||
			x.authority.actor.kind !== 'member' ||
			x.authority.actor.external
		)
			return { error: 'Only an active workspace administrator may invite members.' };
		const decoded = yield* decode(InviteInput);
		const result = yield* inviteMany(
			x.engine.identity,
			x.engine.manifest,
			x.authority,
			decoded.members
		);
		const records = result.ids.map((id) => ({ model: 'sys_invitation', id }));
		x.receipts.push({ outcome: 'committed', callable: 'sys_invitation.create', records });
		return { kind: 'committed', records, output: result };
	}
	if (operation === 'decide') {
		const d = yield* decode(Decide);
		return yield* x.engine.approvals.decide({
			...d,
			authority: x.authority,
			now: x.bindings.now
		});
	}
	if (operation === 'run') {
		const input = yield* decode(RunInput);
		const automation = input.automation,
			callable = `${AUTOMATION}.${automation}`,
			args = input.input ?? {},
			agent = x.agent === undefined ? {} : { agent: x.agent };
		if (x.engine.manifest.automations[automation]?.agent === 'never')
			return { error: `You may not run '${callable}'.` };
		if (x.engine.manifest.automations[automation]?.mode === 'call')
			return yield* x.engine.automations.call({
				automation,
				input: args,
				authority: x.authority,
				bindings: x.bindings,
				...agent
			});
		const run = requestId(x, callId, input.key);
		const outcome = yield* x.engine.calls.start({
			automation,
			runs: [{ id: run, input: args }],
			authority: x.authority,
			bindings: x.bindings,
			...agent
		});
		receipt(x.receipts, callable, outcome);
		return { run, outcome };
	}
	const write = yield* decode(WriteInput);
	if (write.acts === undefined || Object.keys(write.acts).length === 0)
		return { error: 'An act needs a non-empty map of generated writes.' };
	const common = {
		authority: x.authority,
		bindings: x.bindings,
		invocationId: `${x.turn}:${callId}`,
		key: requestId(x, callId, write.key),
		issuedAt: x.bindings.now
	};
	const decoded = yield* decode_acts(x.engine.manifest, write.acts);
	const r = yield* x.engine.calls.acts({
		...common,
		name: 'act',
		from: 'Client',
		acts: decoded.acts,
		outputs: decoded.outputs
	});
	receipt(
		x.receipts,
		decoded.outputs.length === 1 ? (decoded.outputs[0] ?? 'act') : 'act',
		r.outcome
	);
	if (r.outcome.kind !== 'committed') return r.outcome;
	const reads = Object.entries(
		Object.groupBy(
			r.outcome.records.filter((c) => c.model in x.engine.manifest.exposures),
			(c) => c.model
		)
	);
	const supplied = new Map<string, Json[]>();
	for (const { model, verb, input } of decoded.acts) {
		const rows = verb === 'import' && isObj(input) ? input['rows'] : input;
		if (verb !== 'delete' && isList(rows))
			supplied.set(model, [...(supplied.get(model) ?? []), ...rows]);
	}
	const written = (rows: readonly Json[]) => {
		const own = new Set<string>(),
			lists = new Map<string, Set<string>>();
		for (const row of rows) {
			const fields = isObj(row) ? (isObj(row['set']) ? row['set'] : row) : {};
			for (const [key, value] of Object.entries(fields)) {
				if (isList(value) && value.every(isObj)) {
					const cols = lists.get(key) ?? new Set<string>();
					for (const v of value) if (isObj(v)) for (const k of Object.keys(v)) cols.add(k);
					lists.set(key, cols);
				} else if (key !== 'target') own.add(key);
			}
		}
		return { own: [...own], lists, count: rows.length };
	};
	const wroteByModel = new Map([...supplied].map(([model, rows]) => [model, written(rows)]));
	const references = (model: string) =>
		Object.entries(x.engine.manifest.relationships)
			.filter(([key]) => key.startsWith(`${model}.`))
			.map(([key, relation]) => ({ field: key.slice(model.length + 1), to: relation.to }));
	const layersOf = (root: string, output: string) =>
		Object.keys(outputLayers(x.engine.manifest, root, output)).filter(
			(path) =>
				path.startsWith(`${root}.`) &&
				!path.slice(root.length + 1).includes('.') &&
				wroteByModel.get(root)?.lists.has(path.slice(root.length + 1)) === true
		);
	const readBack =
		reads.length === 0
			? Result.succeed<typeof StoredReadBack.Type>({})
			: yield* lower_read(x.engine.manifest, 'query', [
					Object.fromEntries(
						reads.map(([c, rows]) => {
							const wrote = wroteByModel.get(c) ?? written([]);
							const output = readOutputs(x.engine.manifest, x.authority, c)[0] ?? 'default';
							return [
								c,
								{
									where: { id: { in: (rows ?? []).slice(0, 20).map((row) => row.id) } },
									...(output === 'default' ? {} : { output }),
									...(wrote.own.length > 0 && wrote.count > WHOLE_ROWS
										? {
												fields: [
													...new Set([...wrote.own, ...references(c).map((ref) => ref.field)])
												].filter((f) => exposed(x.engine.manifest, c, c, c, output).includes(f))
											}
										: {}),
									...Object.fromEntries(
										layersOf(c, output).map((path) => [
											path.slice(c.length + 1),
											{
												fields: [
													...new Set([
														...(wrote.lists.get(path.slice(c.length + 1)) ?? []),
														...references(layers(x.engine.manifest)[c]?.[path] ?? c).map(
															(ref) => ref.field
														)
													])
												].filter((f) =>
													exposed(
														x.engine.manifest,
														c,
														path,
														layers(x.engine.manifest)[c]?.[path] ?? c,
														output
													).includes(f)
												)
											}
										])
									)
								}
							];
						})
					)
				]).pipe(
					Effect.mapError((cause) =>
						BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
					),
					Effect.flatMap(readAs(x)),
					Effect.flatMap(Schema.decodeUnknownEffect(StoredReadBack)),
					Effect.tapCause(Effect.logWarning),
					Effect.result
				);
	const stored: typeof StoredReadBack.Type = Result.isSuccess(readBack) ? readBack.success : {};
	const writtenById = new Map(r.outcome.records.map((row) => [`${row.model}:${row.id}`, row]));
	const fieldMap = new Map<string, Json>();
	for (const [path, layer] of Object.entries(stored)) {
		const root = path.split('.')[0] ?? path;
		const model = layers(x.engine.manifest)[root]?.[path] ?? root;
		for (const row of layer.rows)
			for (const reference of references(model)) {
				const value = row[reference.field];
				if (typeof value !== 'string') continue;
				const target = writtenById.get(`${reference.to}:${value}`);
				const field = `${model}.${reference.field}`;
				fieldMap.set(`${row.id}:${field}`, {
					model,
					row: row.id,
					field,
					targetModel: reference.to,
					value,
					decision: target === undefined ? 'LINK' : target.revision === 1 ? 'CREATE' : 'UPDATE'
				});
			}
	}
	const ids = r.outcome.records.map((c) => c.id);
	const queued =
		ids.length === 0
			? Result.succeed([])
			: yield* x.engine.db
					.rows(Schema.Struct({ id: Schema.String, automation: Schema.String }), {
						text: `SELECT id, automation FROM sys_run
		WHERE state IN ('queued', 'running') AND cause = 'effect'
		AND input -> 'ids' ?| ARRAY(SELECT jsonb_array_elements_text($1::jsonb))`,
						params: [JSON.stringify(ids)]
					})
					.pipe(Effect.tapCause(Effect.logWarning), Effect.result);
	const runs = Result.isFailure(queued)
		? []
		: queued.success.map(({ id, automation }) => ({ run: id, automation }));
	return {
		...r.outcome,
		...(fieldMap.size === 0 ? {} : { fieldMap: [...fieldMap.values()] }),
		...(Result.isFailure(readBack)
			? {
					read_back_error: `The write committed. Stored rows could not be read: ${readBack.failure.message}`
				}
			: { stored }),
		...(Result.isFailure(queued)
			? {
					runs_lookup_error: `The write committed. Queued runs could not be read: ${queued.failure.message}`
				}
			: {}),
		...(runs.length === 0 ? {} : { runs }),
		...(r.outcome.unchanged === undefined
			? {}
			: {
					note: r.outcome.unchanged
						.map(
							({ model, id }) =>
								`no change: ${model} ${id} already holds these values (a write callback may derive them)`
						)
						.join('; ')
				})
	};
});
