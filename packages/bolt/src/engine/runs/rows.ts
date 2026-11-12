import { actor_ref } from '../access/actor.ts';
// Native run rows share one stored projection, caller visibility and captured image shape.
import { Effect, Schema } from 'effect';
import { canonical } from '@norbital-ai/store';
import { EngineActorSchema, RunTriggerSchema } from '../../protocol/schema.ts';
import type { Json } from '../../decl/values.ts';
import type { Authority, RunTriggerView } from '../contracts.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { capturePiece } from '../db/captured.ts';
import { storedInstant } from '../db/wire.ts';

import type { Chain } from '../write/sql.ts';
import { RunAttempt, RunError } from './attempt.ts';

/** Native run captures include the same timestamp and trigger-name projection as an authorized read. */
export const runPiece = (c: Chain, name: string, statement: string, options: { readonly returning?: string } = {}): string =>
	capturePiece(c, name, 'sys_run', statement, { ...options, image: (alias) =>
		`to_jsonb(${alias}) || jsonb_build_object('due_at', ${alias}.due_at::text, 'started', ${alias}.started_at::text,
		'trigger_name', (SELECT coalesce(u.name, u.email) FROM sys_user u
		WHERE u.id::text = coalesce(${alias}.trigger->'actor'->>'id', ${alias}.trigger->'actor'->>'member')))` });

const HolderSchema = Schema.Struct({
	actor: EngineActorSchema,
	policies: Schema.Array(Schema.String),
	admin: Schema.Boolean,
	platform: Schema.optionalKey(Schema.Boolean),
	teamTree: Schema.optionalKey(Schema.Array(Schema.String)),
	scopes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String)))
});
export const RowSchema = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	input: Schema.Json,
	due_at: Schema.String,
	run_key: Schema.NullOr(Schema.String),
	cause: Schema.String,
	depth: Schema.Number,
	attempts: Schema.Number,
	leases: Schema.Number,
	actor: Schema.NullOr(Schema.String),
	starter: Schema.NullOr(HolderSchema),
	trigger: Schema.NullOr(RunTriggerSchema)
});
export type Row = typeof RowSchema.Type;
export const RunViewRow = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	cause: Schema.String,
	state: Schema.String,
	due_at: Schema.String,
	started: Schema.NullOr(Schema.String),
	progress: Schema.Json,
	output: Schema.Json,
	error: Schema.NullOr(RunError),
	attempts: Schema.Number,
	results: Schema.Array(RunAttempt),
	input: Schema.Json,
	actor: Schema.NullOr(Schema.String),
	starter: Schema.NullOr(HolderSchema),
	trigger: Schema.NullOr(RunTriggerSchema),
	trigger_name: Schema.NullOr(Schema.String)
});
export type RunViewRow = typeof RunViewRow.Type;
/** Actual output and authorization columns for a stored automation-file candidate. */
export const RunOutputRow = Schema.Struct({
	id: Schema.String,
	automation: Schema.String,
	output: Schema.Json,
	starter: Schema.NullOr(HolderSchema)
});
/** Run visibility follows held automations and native remote refresh capabilities; neither grants a new start path. */
export const visible_run_names = (authority: Authority): readonly string[] => [
	...authority.automations,
	...authority.capabilities.syncs.flatMap((key) => {
		const dot = key.lastIndexOf('.');
		return dot > 0 && dot < key.length - 1 ? [`${key.slice(0, dot)}.sync.${key.slice(dot + 1)}`] : [];
	})
];
export function readsRunResult(
	authority: Authority,
	row: Pick<typeof RunOutputRow.Type, 'automation' | 'starter'>
): boolean {
	const starter = row.starter?.actor;
	return (
		authority.admin ||
		visible_run_names(authority).includes(row.automation) ||
		(starter !== undefined && canonical(starter) === canonical(authority.actor))
	);
}
export type RunView = {
	id: string;
	automation: string;
	cause: string;
	trigger: RunTriggerView | null;
	status: string;
	due_at: string;
	started: string | null;
	progress: Json;
	error: RunViewRow['error'];
	attempt_count: number;
	result?: Json;
	input?: Json;
	attempts?: readonly RunAttempt[];
};
export const RUN_VIEW_COLUMNS = `id, automation, cause, state, due_at::text AS due_at, started_at::text AS started, progress, output, error, attempts, results, input, actor, starter, trigger,
	(SELECT coalesce(u.name, u.email) FROM sys_user u WHERE u.id::text = coalesce(trigger->'actor'->>'id', trigger->'actor'->>'member')) AS trigger_name`;
const triggerView = (row: RunViewRow): RunTriggerView | null =>
	row.trigger?.kind === 'person'
		? {
				kind: 'person',
				ref: actor_ref(row.trigger.actor),
				name: row.trigger_name,
				...(row.trigger.agent === undefined ? {} : { agent: true as const })
			}
		: row.trigger;
export function run_view(authority: Authority, row: RunViewRow, brief = false): RunView | null {
	const show = (view: RunView): RunView => {
		if (!brief) return view;
		const { input: _input, result: _result, attempts: _attempts, ...shown } = view;
		return shown;
	};
	const base = {
		id: row.id,
		automation: row.automation,
		cause: row.cause,
		trigger: triggerView(row),
		status: row.state,
		due_at: storedInstant(row.due_at),
		started: row.started === null ? null : storedInstant(row.started),
		progress: row.progress,
		attempt_count: row.attempts
	};
	// a run the person started by hand answers them with its declared result, whatever policies it ran under; an
	// effect's input holds the write's whole images, so its writer sees what any causing actor does
	if (
		(readsRunResult(authority, row) && (row.cause !== 'effect' || authority.admin)) ||
		(row.cause === 'start' && row.actor === actor_ref(authority.actor))
	)
		return show({
			...base,
			error: row.error,
			...(row.output === null ? {} : { result: row.output }),
			input: row.input,
			attempts: row.results
		});
	return row.actor === actor_ref(authority.actor)
		? show({ ...base, error: row.error === null ? null : { code: row.error.code } })
		: null;
}
/** The list's admission matches its SQL head before applying per-row result visibility. */
export function listedRun(authority: Authority, row: RunViewRow, brief = false): RunView | null {
	if (authority.actor.kind !== 'member' || (!authority.admin && row.actor !== actor_ref(authority.actor) && !visible_run_names(authority).includes(row.automation)))
		return null;
	return run_view(authority, row, brief);
}
/**
 * The runs list (the `runs` read: the command center's Automations, `bolt.runs`): an administrator sees every run; a
 * member (staff or external) the runs of automations they hold and the runs they caused, each as rule 56 lets them read
 * it (status, progress and the error code only for a run they merely caused). `automation` narrows the list to one
 * automation; `id` to one run.
 */
export const runList = Effect.fn('Runs.list')(function* (
	db: TenantDbShape,
	auth: Authority,
	limit: number = 100,
	automation?: string,
	id?: string,
	brief: boolean = false
) {
	const a = auth.actor;
	if (a.kind !== 'member') return [];
	const rows = yield* db.rows(RunViewRow, {
		text: `SELECT ${RUN_VIEW_COLUMNS} FROM sys_run
		WHERE ($1 OR actor = $2 OR automation IN (SELECT jsonb_array_elements_text($3::jsonb))) AND ($4::text IS NULL OR automation = $4) AND ($5::text IS NULL OR id = $5)
		ORDER BY due_at DESC, id COLLATE "C" DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`,
		params: [
			auth.admin,
			actor_ref(a),
			JSON.stringify(visible_run_names(auth)),
			automation ?? null,
			id ?? null
		]
	});
	return rows.flatMap((row) => listedRun(auth, row, brief) ?? []);
});
