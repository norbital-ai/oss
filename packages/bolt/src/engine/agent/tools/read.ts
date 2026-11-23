import { Effect, Option, Predicate, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import { AuditQuery, type PortFailure } from '@norbital-ai/host-api';
import { describe_kind, kind_label, kind_signature } from '@norbital-ai/store/kind';
import { EFFECT_VERBS } from '../../../decl/model.ts';
import { driver_of } from '../../../decl/runtime/integration.ts';
import type { Json } from '../../../decl/values.ts';
import { BoltError } from '../../../protocol/errors.ts';
import type { ReadRequestJson } from '../../../protocol/read-request.ts';
import type { ReadIR } from '../../../protocol/reads.ts';
import { can_open } from '../../../shell/nav.ts';
import { actor_ref } from '../../access/actor.ts';
import { actorVarsOf, exposed, writable_columns } from '../../access/authority.ts';
import type { Authority } from '../../contracts.ts';
import type { EngineError } from '../../errors.ts';
import { readLog, runLog } from '../../guest/telemetry.ts';
import { layered, layers, type EngineManifest } from '../../manifest.ts';
import { lower_read, readableBy } from '../../query/engine.ts';
import { RUN_VIEW_COLUMNS, RunViewRow, run_view, visible_run_names } from '../../runs/rows.ts';
import { materializeEach } from '../../runs/time.ts';
import type { InferTool, ToolAnswer } from '../ai.ts';
import { bounded, size } from '../context.ts';
import { isList, isObj } from '../draft.ts';
import { HistoryRevisions, recordsTool } from './definitions.ts';
import {
	before,
	callablesFor,
	clippedView,
	err,
	guard,
	ok,
	outputLayers,
	readOutputs,
	readPaths,
	skillOf
} from './helpers.ts';
import {
	APPROVE,
	CLOSED,
	HISTORY_ROWS,
	OVERVIEW_BYTES,
	ReadInput,
	ReadOptions,
	type AgentTool,
	type CatalogueIndex,
	type ReadToolContext,
	type Skill,
	type Spec,
	type ToolContext
} from './types.ts';

export const readAs = (x: ReadToolContext) => (ir: ReadIR) =>
	x.engine
		.read([ir], { as: 'caller', authority: x.authority }, x.bindings)
		.pipe(Effect.map(([got]) => got ?? null));

export const StoredReadBack = Schema.Record(
	Schema.String,
	Schema.Struct({
		rows: Schema.Array(
			Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
				Schema.Record(Schema.String, Schema.Json)
			])
		)
	})
);

const uncursored = (v: Json): Json =>
	!Predicate.isObject(v) || EffectArray.isArray<typeof v>(v)
		? v
		: 'rows' in v
			? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'next'))
			: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, uncursored(x)]));

function searchOf(m: EngineManifest, model: string, readable: readonly string[]): Json {
	const spec = m.models[model]?.search;
	const text = (spec?.text ?? []).filter((f) => readable.includes(f));
	const indexes = Object.entries(spec?.indexes ?? {});
	if (text.length === 0 && indexes.length === 0 && spec?.semantic === undefined) return null;
	return {
		...(text.length === 0
			? {}
			: {
					text: {
						fields: text,
						use: 'search: "<words>" ranks, not proof; where: { "$search": "<words>" } requires each'
					}
				}),
		...Object.fromEntries(
			indexes.map(([name, index]) => [
				name,
				{
					about: index.description,
					input: Object.fromEntries(
						Object.entries(index.input).map(([f, k]) => [
							f,
							describe_kind(k, (custom) => m.custom_fields[custom]?.shape)
						])
					),
					use: `search: { "${name}": <input> }`
				}
			])
		),
		...(spec?.semantic === undefined
			? {}
			: {
					semantic: { fields: spec.semantic.fields, use: 'search: { "semantic": "<text>" }' }
				})
	};
}

function fieldKinds(m: EngineManifest, path: string, output: string): Record<string, string> {
	const root = before(path, '.'),
		model = layers(m)[root]?.[path] ?? root,
		all = layered(m);
	const kind = (f: string): string => {
		const link = all.relationships[`${model}.${f}`];
		if (link !== undefined) return `link to ${[link.to].flat().join(' | ')}`;
		const d = all.models[model]?.fields[f];
		if (d === undefined) return 'system';
		return kind_label(d);
	};
	return Object.fromEntries(exposed(m, root, path, model, output).map((f) => [f, kind(f)]));
}

function shapeOf(m: EngineManifest, a: Authority, path: string, output = 'default'): Json {
	const root = before(path, '.'),
		model = layers(m)[root]?.[path] ?? root,
		all = layered(m);
	const kinds = fieldKinds(m, path, output),
		fields = Object.keys(kinds);
	const below = Object.keys(outputLayers(m, root, output)).filter(
		(p) => p.startsWith(`${path}.`) && !p.slice(path.length + 1).includes('.')
	);
	const writes = path.includes('.')
		? []
		: [...callablesFor(m, a).keys()].filter((c) => c.startsWith(`${root}.`));
	const columns = (verb: 'create' | 'update') => all.exposures[root]?.[verb]?.columns;
	const requiredOf = (owner: string) => (f: string) => {
		const link = all.relationships[`${owner}.${f}`];
		if (link !== undefined) return link.optional !== true && link.default === undefined;
		const d = all.models[owner]?.fields[f];
		return (
			d !== undefined &&
			d.optional !== true &&
			d.default === undefined &&
			!['seq', 'sum', 'count', 'state'].includes(d.kind)
		);
	};
	const outputs = path.includes('.') ? [] : readOutputs(m, a, root);
	return {
		model,
		...(output === 'default' ? {} : { output }),
		...(outputs.length > 1 || outputs[0] !== output ? { outputs } : {}),
		fields: kinds,
		...(path.includes('.') ? {} : { search: searchOf(m, model, fields) }),
		...(below.length === 0
			? {}
			: { layers: Object.fromEntries(below.map((p) => [p, layers(m)[root]?.[p] ?? ''])) }),
		...(writes.length === 0
			? {}
			: {
					writes: Object.fromEntries(
						writes.map((c) => {
							const verb = c.slice(root.length + 1);
							const arms = (
								verb === 'import'
									? (['create', 'update'] as const)
									: verb === 'create' || verb === 'update' || verb === 'delete'
										? ([verb] as const)
										: []
							).flatMap((v) => a.models[root]?.[v] ?? []);
							const judges =
								arms.length > 0 && arms.every((arm) => arm.check)
									? [...new Set(arms.map((arm) => arm.policy))]
									: [];
							const checks = judges.length === 0 ? {} : { checks: judges };
							const cols = verb === 'create' || verb === 'update' ? columns(verb) : undefined;
							if (cols === undefined) return [c, judges.length === 0 ? true : checks];
							const allowed = writable_columns(a, root, verb === 'create' ? 'create' : 'update');
							const own =
								allowed === 'all'
									? cols
									: { ...cols, [root]: (cols[root] ?? []).filter((f) => allowed.has(f)) };
							const required = verb === 'create' ? (cols[root] ?? []).filter(requiredOf(root)) : [];
							return [
								c,
								{ columns: own, ...(required.length === 0 ? {} : { required }), ...checks }
							];
						})
					)
				})
	};
}

const automationSignature = (m: EngineManifest, name: string) =>
	`${name}(${Object.entries(m.automations[name]?.input ?? {})
		.map(
			([field, kind]) =>
				`${field}${kind.optional ? '?' : ''}: ${kind.kind === 'rows' ? `rows<${kind.of}>` : kind_signature(kind)}`
		)
		.join(', ')})`;

/** The base message catalogue's `'key': 'text'` pairs, read from its source. */
export const messageCatalogue = (source: string | null): ReadonlyMap<string, string> =>
	new Map(
		[...(source ?? '').matchAll(/'([^'\n]+)':\s*'((?:[^'\\\n]|\\.)*)'/g)].flatMap(
			([, key, value]) => (key === undefined || value === undefined ? [] : [[key, value] as const])
		)
	);

/**
 * The workspace as a map, scoped to the caller: its basics, the apps they open (group ▸ app ▸ pages), the models they
 * read or write (description, outputs, writes, links, states, effects, syncs, search, notices) and the automations they
 * start (signature, description, trigger, agent use). `names` answers each named item in full: a model or layer with its
 * fields and your writes, an app, or an automation.
 */
export function describeWorkspace(
	m: EngineManifest,
	a: Authority,
	messages: ReadonlyMap<string, string>,
	names: readonly string[] = [],
	totals: ReadonlyMap<string, number> = new Map()
): string {
	const all = layered(m),
		t = (key: string) => messages.get(key) ?? key,
		acts = [...callablesFor(m, a).keys()];
	const roots = new Set(readPaths(m, a).filter((path) => !path.includes('.')));
	const apps = [...new Set([...(m.workspace.apps ?? []), ...Object.keys(m.apps)])].filter(
		(name) => m.apps[name] !== undefined && can_open(m, a, name)
	);
	const models = Object.keys(all.models).filter(
		(name) => roots.has(name) || acts.some((c) => c.startsWith(`${name}.`))
	);
	const automations = a.automations.filter((name) => m.automations[name] !== undefined);
	const definitions = all.integrations;
	const app = (name: string) => {
		const spec = m.apps[name];
		if (spec === undefined) return name;
		const group = name.includes('/') ? name.slice(0, name.indexOf('/')) : undefined,
			label = group === undefined ? undefined : m.groups?.[group]?.title;
		return [
			`${group === undefined ? '' : `${group}${label === undefined ? '' : ` "${t(label)}"`} ▸ `}${name} "${t(spec.title)}": ${t(spec.description)}`,
			...Object.entries(spec.pages).map(
				([page, p]) =>
					`  ├ /app/${name}/${page} "${t(p.title)}"${p.section === undefined ? '' : ` section "${t(p.section)}"`}${p.portal === true ? ' portal' : ''}`
			)
		].join('\n');
	};
	const model = (name: string) => {
		const spec = all.models[name],
			ex = all.exposures[name];
		if (spec === undefined) return name;
		const links = Object.entries(all.relationships).flatMap(([key, r]) => [
			...(key.startsWith(`${name}.`)
				? [`${key.slice(name.length + 1)} → ${[r.to].flat().join(' | ')}`]
				: []),
			...([r.to].flat().includes(name) && r.inverse !== undefined
				? [`${r.inverse} (many ${key.slice(0, key.indexOf('.'))})`]
				: [])
		]);
		const states = Object.entries(spec.fields).flatMap(([f, d]) =>
			d.kind === 'state' ? [`${f}: ${Object.keys(d.states).join(' | ')}`] : []
		);
		const writes = acts
			.filter((c) => c.startsWith(`${name}.`))
			.map((c) => c.slice(name.length + 1));
		const line = (label: string, items: readonly string[]) =>
			items.length === 0 ? [] : [`  ${label} ${items.join(' · ')}`];
		const outputs = roots.has(name) ? readOutputs(m, a, name) : [],
			total = totals.get(name);
		return [
			`${name} "${before(spec.description, '\n').trim()}"${total === undefined ? '' : ` · ${total} ${total === 1 ? 'row' : 'rows'}`}`,
			...line('reads', outputs),
			...line(
				'fields',
				outputs[0] === undefined || names.length > 0
					? []
					: Object.entries(fieldKinds(m, name, outputs[0])).map(
							([field, kind]) => `${field} ${kind}`
						)
			),
			...line('writes', writes),
			...line('links', links),
			...line('state', states),
			...line('effects', EFFECT_VERBS.filter((verb) => ex?.[verb]?.effect === true)),
			...line(
				'syncs',
				Object.entries(ex?.syncs ?? {}).map(([sync, x]) => `${sync} (${x.with})`)
			),
			...line('search', Object.keys(spec.search?.indexes ?? {})),
			...line(
				'notices',
				EFFECT_VERBS.some((verb) => ex?.[verb]?.effect === true)
					? ['on its write and approval events']
					: []
			)
		].join('\n');
	};
	const automation = (name: string) => {
		const spec = m.automations[name];
		if (spec === undefined) return name;
		const on = (spec.on ?? []).map((x) =>
			'cron' in x ? `cron ${x.cron}` : `on ${x.model} ${x.verbs.join('|')}`
		);
		return `${automationSignature(m, name)} "${spec.description}"${on.length === 0 ? '' : ` · ${on.join(', ')}`}${spec.agent === undefined ? '' : ` · agent ${spec.agent}`}`;
	};
	const sections = {
		app: { title: '# Apps (group ▸ app ▸ pages)', names: apps, render: app },
		model: { title: '# Models', names: models, render: model },
		automation: {
			title: '# Automations (start as automation.<name>)',
			names: automations,
			render: automation
		},
		integration: {
			title: '# Integrations (connections are sys_integration rows)',
			names: Object.keys(definitions).sort(),
			render: (name: string) => {
				const spec = definitions[name];
				return spec === undefined
					? name
					: `${name} "${before(spec.description, '\n').trim()}"${driver_of(spec).personal === true ? ' · personal' : ''}`;
			}
		}
	};
	if (names.length > 0) {
		const paths = readPaths(m, a);
		return names
			.map((name) => {
				const shape =
					paths.includes(name) || (a.admin && all.models[name] !== undefined)
						? `\n${JSON.stringify(shapeOf(m, a, name, readOutputs(m, a, before(name, '.'))[0]))}`
						: '';
				const found = Object.values(sections).find((one) => one.names.includes(name));
				return found !== undefined
					? `${found.render(name)}${shape}`
					: shape !== ''
						? `${name}${shape}`
						: `Nothing named ${name} that you can reach.`;
			})
			.join('\n\n');
	}
	const header = `# Workspace tz ${m.workspace.tz} · locale ${m.workspace.locale}${m.workspace.currency === undefined ? '' : ` · currency ${m.workspace.currency}`}`;
	const out = [header];
	let used = size(header);
	for (const sec of Object.values(sections)) {
		if (sec.names.length === 0) continue;
		out.push('', sec.title);
		const rest: string[] = [];
		for (const name of sec.names) {
			const text = rest.length > 0 ? undefined : sec.render(name);
			if (text !== undefined && used + size(text) <= OVERVIEW_BYTES - 1_000) {
				out.push(text);
				used += size(text);
			} else rest.push(name);
		}
		if (rest.length === 0) continue;
		let also = `Also (describe_workspace { names }):`,
			named = 0;
		for (const name of rest) {
			if (used + size(also) + size(name) + 200 > OVERVIEW_BYTES) break;
			also += `${named === 0 ? ' ' : ', '}${name}`;
			named++;
		}
		if (named < rest.length) also += ` … and ${rest.length - named} more`;
		out.push(also);
		used += size(also);
	}
	return out.join('\n');
}

/**
 * `read`: one read request, a layer map over the models and declared layers the actor may read, answered in
 * one engine read as the actor and bounded by the tool-result budget (a lone root's page keeps whole rows); `undefined` when nothing is
 * readable. What the bound cut stays readable with `read_output`.
 */
export function readTool(x: ReadToolContext) {
	const e = x.engine,
		a = x.authority,
		paths = readPaths(e.manifest, a);
	if (paths.length === 0) return undefined;
	const materialize = (node: Json): Json => {
		if (!isObj(node)) return node;
		return Object.fromEntries(
			Object.entries<Json>(node).map(([key, value]) => [
				key,
				key === 'where' && isObj(value)
					? materializeEach(value, { ...x.bindings, actor: actorVarsOf(a) })
					: Object.hasOwn(ReadOptions.fields, key)
						? value
						: materialize(value)
			])
		);
	};
	const answer = (request: ReadRequestJson) =>
		Effect.try({
			try: () =>
				Object.fromEntries(
					Object.entries(request).map(([root, node]) => [root, materialize(node)])
				),
			catch: (cause) =>
				cause instanceof BoltError
					? cause
					: BoltError.make('internal', 'decode', 'Could not decode this read.', cause)
		}).pipe(
			Effect.flatMap((materialized) => lower_read(e.manifest, 'query', [materialized])),
			Effect.flatMap(readAs(x))
		);
	const run = Effect.fn('AgentTool.read')(function* (
		request: ReadRequestJson,
		enrich: (full: Json) => Effect.Effect<Json, EngineError> = Effect.succeed
	) {
		const named = Object.keys(request).filter((path) => !path.includes('.'));
		const single = named.length === 1 ? named[0] : undefined;
		const pageOf = (v: Json): Json => (single !== undefined && isObj(v) ? (v[single] ?? null) : v);
		const wrap = (v: Json): Json => (single === undefined ? v : { [single]: v });
		return yield* Effect.gen(function* () {
			const full = yield* Effect.flatMap(answer(request), enrich),
				shown = bounded(pageOf(full));
			return {
				result: wrap(shown.kept === null ? shown.value : uncursored(shown.value)),
				full,
				bounded: true
			} as const;
		}).pipe(
			Effect.catch((failure) =>
				Effect.gen(function* () {
					if (!(failure instanceof BoltError) || failure.code !== 'invalid')
						return yield* Effect.fail(failure);
					const roots = [
						...new Set(Object.keys(request).map((path) => path.split('.')[0] ?? path))
					];
					const refusals =
						roots.length < 2
							? [failure.message]
							: yield* Effect.forEach(roots, (root) =>
									answer(
										Object.fromEntries(
											Object.entries(request).filter(
												([path]) => path === root || path.startsWith(`${root}.`)
											)
										)
									).pipe(
										Effect.match({
											onSuccess: () => [],
											onFailure: (cause) => (cause instanceof BoltError ? [cause.message] : [])
										})
									)
								).pipe(Effect.map((each) => each.flat()));
					return { result: { error: refusals.join('\n') } };
				})
			)
		);
	});
	return {
		tool: recordsTool,
		run: (
			{ request }: typeof ReadInput.Type,
			enrich?: (full: Json) => Effect.Effect<Json, EngineError>
		): Effect.Effect<ToolAnswer> => {
			const unknown = Object.keys(request).find((path) => !paths.includes(path));
			if (unknown === undefined) return guard(run(request, enrich));
			const twice =
				unknown in e.manifest.models
					? undefined
					: paths.find((path) => !path.includes('.') && unknown.startsWith(path));
			const root = before(unknown, '.');
			const rootLayers = unknown.includes('.')
				? paths.filter((p) => p.startsWith(`${root}.`))
				: [];
			return Effect.succeed(
				err(
					`You read no '${unknown}'. ${
						unknown.includes('.')
							? rootLayers.length > 0
								? `Readable layers on '${root}': ${rootLayers.join(', ')}`
								: `'${root}' has no nested layers you may read.`
							: twice !== undefined
								? `A request reads '${twice}' once: aggregate.by groups its counts, and another read call in the same step reads it again.`
								: `Models: ${paths.filter((p) => !p.includes('.')).join(', ')}`
					}`
				)
			);
		}
	};
}

/** `read` as a tool an inference is lent (`ai.sys_2.infer` naming `read`): the same tool, as the actor. */
export function readInferTool(x: ReadToolContext): InferTool | undefined {
	const read = readTool(x);
	if (read === undefined) return undefined;
	return {
		name: read.tool.name,
		description: read.tool.description,
		input: read.tool.input,
		behavior: read.tool.behavior,
		call: (input) =>
			read.tool.decode(input).pipe(
				Effect.matchEffect({
					onFailure: (error) => Effect.succeed<Json>({ error: error.message }),
					onSuccess: (request) =>
						read
							.run(request)
							.pipe(
								Effect.map((answer) =>
									'result' in answer ? answer.result : { error: 'confirmation needed' }
								)
							)
				})
			)
	};
}

const Instant = Schema.String.check(
	Schema.makeFilter((v) => !Number.isNaN(Date.parse(v)) || 'an ISO instant')
);
const Limit = Schema.Number.check(Schema.isInt());
const RunsNode = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	automation: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(
		Schema.Literals(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'skipped'])
	),
	cause: Schema.optionalKey(Schema.String),
	since: Schema.optionalKey(Instant),
	until: Schema.optionalKey(Instant),
	limit: Schema.optionalKey(Limit),
	after: Schema.optionalKey(Schema.String)
});
const LogsNode = Schema.Struct({
	level: Schema.optionalKey(Schema.Literals(['info', 'warn', 'error'])),
	text: Schema.optionalKey(Schema.String),
	run: Schema.optionalKey(Schema.String),
	automation: Schema.optionalKey(Schema.String),
	conversation: Schema.optionalKey(Schema.String),
	since: Schema.optionalKey(Schema.String),
	until: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Limit),
	after: Schema.optionalKey(Schema.String)
});
const {
	actor_kind: _kind,
	invocation: _invocation,
	order: _order,
	after: _after,
	...AUDIT_FILTERS
} = AuditQuery.fields;
const AuditNode = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	after: Schema.optionalKey(Schema.NonEmptyString),
	...AUDIT_FILTERS
});
const ApprovalsNode = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	ids: Schema.optionalKey(Schema.Array(Schema.String)),
	all: Schema.optionalKey(Schema.Boolean)
});
const RunList = Schema.Struct({ ...RunViewRow.fields, finished: Schema.NullOr(Schema.String) });

const ledgerNode = <S extends Schema.Top & { readonly DecodingServices: never }>(
	schema: S,
	root: string,
	node: unknown
) =>
	root === '$runs' && Predicate.isObject(node) && 'aggregate' in node
		? Effect.fail(
				BoltError.make(
					'invalid_input',
					'decode',
					'$runs does not support aggregate; pass { automation?, status?, cause?, since?, until?, limit?, after? } and summarize rows in memory or run_js.'
				)
			)
		: Schema.decodeUnknownEffect(schema, CLOSED)(node).pipe(
				Effect.mapError((error) =>
					BoltError.make('invalid_input', 'decode', `${root}: ${error.message}`, error)
				)
			);

export function ledgerRoots(
	x: ToolContext
): { readonly [root: string]: (node: unknown, call: string) => Effect.Effect<ToolAnswer> } {
	const e = x.engine,
		a = x.authority;
	if (a.actor.kind !== 'member') return {};
	const member = a.actor;
	const readable = readableBy(e.read, e.manifest, a, x.bindings);
	const head = (row: typeof RunList.Type, view: NonNullable<ReturnType<typeof run_view>>) => ({
		id: view.id,
		automation: view.automation,
		status: view.status === 'stopped' ? 'cancelled' : view.status,
		cause: view.cause,
		due: view.due_at,
		started: view.started,
		finished: row.finished,
		attempt_count: view.attempt_count
	});
	const runs = Effect.fn('AgentTool.runs')(function* (node: unknown, call: string) {
		const i = yield* ledgerNode(RunsNode, '$runs', node);
		const after = Option.getOrNull(
			Schema.decodeUnknownOption(
				Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))
			)(i.after ?? '')
		);
		if (i.after !== undefined && after === null)
			return err('$runs: after is a next a page answered.');
		const limit = Math.min(Math.max(1, i.limit ?? 20), 100),
			name = i.automation;
		const rows = yield* e.db.rows(RunList, {
			text: `SELECT ${RUN_VIEW_COLUMNS}, finished_at::text AS finished
	FROM sys_run
	WHERE ($1 OR actor = $2 OR automation IN (SELECT jsonb_array_elements_text($3::jsonb)))
		AND ($4::text IS NULL OR id = $4)
		AND ($5::text IS NULL OR automation = $5) AND ($6::text IS NULL OR starts_with(automation, $6))
		AND ($7::text IS NULL OR state = $7) AND ($8::text IS NULL OR cause = $8)
		AND ($9::timestamptz IS NULL OR due_at >= $9::timestamptz) AND ($10::timestamptz IS NULL OR due_at < $10::timestamptz)
		AND ($11::timestamptz IS NULL OR (due_at, id) < ($11::timestamptz, $12::text))
	ORDER BY due_at DESC, id DESC LIMIT ${limit + 1}`,
			params: [
				a.admin,
				actor_ref(member),
				JSON.stringify(visible_run_names(a)),
				i.id ?? null,
				name === undefined || name.endsWith('*') ? null : name,
				name !== undefined && name.endsWith('*') ? name.slice(0, -1) : null,
				i.status === 'cancelled' ? 'stopped' : (i.status ?? null),
				i.cause ?? null,
				i.since ?? null,
				i.until ?? null,
				after?.[0] ?? null,
				after?.[1] ?? null
			]
		});
		const shown = rows.slice(0, limit).flatMap((row) => {
			const view = run_view(a, row);
			return view === null ? [] : [{ row, view }];
		});
		if (i.id !== undefined) {
			const one = shown[0];
			if (one === undefined) return err(`$runs: no automation run ${i.id} you may read.`);
			const { row, view } = one;
			const lines =
				view.input === undefined
					? []
					: yield* runLog(x.logs, view.id).pipe(
							Effect.map((entries) =>
								typeof entries === 'string'
									? entries
									: entries.map(({ id, at, severity, event, attributes }): Json => ({
											id,
											at,
											severity,
											event,
											attributes
										}))
							)
						);
			return clippedView(
				(clip) => ({
					rows: [
						{
							...head(row, view),
							progress: clip(view.progress, 2048),
							error: clip(view.error, 4096),
							...(view.input === undefined
								? {}
								: {
										input: clip(view.input, 4096),
										result: clip(view.result ?? null, 4096),
										attempts: EffectArray.isArray<typeof view.attempts>(view.attempts)
											? view.attempts.map((attempt) => clip(attempt, 1024))
											: clip(view.attempts ?? null, 4096),
										logs: typeof lines === 'string' ? lines : lines.map((line) => clip(line, 1024))
									})
						}
					],
					next: null
				}),
				call
			);
		}
		const last = rows.length > limit ? rows[limit - 1] : undefined;
		return clippedView(
			(clip) => ({
				rows: shown.map(({ row, view }) => ({
					...head(row, view),
					error:
						view.error === null
							? null
							: {
									code: view.error.code,
									...(view.error.message === undefined
										? {}
										: { message: clip(view.error.message, 200) })
								},
					progress: clip(view.progress, 512)
				})),
				next: last === undefined ? null : JSON.stringify([last.due_at, last.id])
			}),
			call
		);
	});
	const approvals = Effect.fn('AgentTool.approvals')(function* (node: unknown) {
		const i = yield* ledgerNode(ApprovalsNode, '$approvals', node);
		return ok({
			rows: yield* e.approvals.list({ model: i.model, ids: i.ids, all: i.all }, a, readable),
			next: null
		});
	});
	const logs = Effect.fn('AgentTool.logs')(function* (node: unknown, call: string) {
		const { level, after, limit: asked, ...rest } = yield* ledgerNode(LogsNode, '$logs', node);
		const limit = Math.min(Math.max(1, asked ?? 50), 200);
		const rows = yield* readLog(x.logs, {
			...rest,
			...(level === undefined ? {} : { min: level }),
			...(after === undefined ? {} : { before: after }),
			limit
		});
		const last = rows.length === limit ? rows.at(-1) : undefined;
		return clippedView(
			(clip) => ({
				rows: rows.map((row) => ({
					id: row.id,
					at: row.at,
					level: row.severity,
					event: row.event,
					invocation: row.invocation,
					run: row.run,
					conversation: row.conversation,
					attributes: clip(row.attributes, 1024)
				})),
				next: last === undefined ? null : last.id
			}),
			call
		);
	});
	const audit = e.audit;
	const trail =
		audit === undefined || !a.admin || member.external
			? undefined
			: Effect.fn('AgentTool.audit')(function* (node: unknown) {
					const { id, ...query } = yield* ledgerNode(AuditNode, '$audit', node);
					if (id === undefined) return ok(yield* audit.query({ order: 'newest', ...query }));
					const event = yield* audit.detail(id);
					return event === null
						? err(`$audit: no event ${id}.`)
						: ok({ rows: [event], next: null });
				});
	const guarded =
		(work: (node: unknown, call: string) => Effect.Effect<ToolAnswer, EngineError | PortFailure>) =>
		(node: unknown, call: string) =>
			guard(work(node, call));
	return {
		$runs: guarded(runs),
		$approvals: guarded(approvals),
		...(a.admin ? { $logs: guarded(logs) } : {}),
		...(trail === undefined ? {} : { $audit: guarded(trail) })
	};
}

const recordHistory = Effect.fn('AgentTool.recordHistory')(function* (
	x: ToolContext,
	model: string,
	id: string,
	output: string | undefined
) {
	const e = x.engine;
	const ir = yield* lower_read(e.manifest, 'history', [
		model,
		id,
		output === undefined ? {} : { output }
	]);
	const revisions = yield* Schema.decodeUnknownEffect(HistoryRevisions)(yield* readAs(x)(ir)).pipe(
		Effect.mapError((error) => BoltError.make('internal', 'decode', error.message, error))
	);
	const people = [
		...new Set(revisions.flatMap((r) => (r.actor?.kind === 'member' ? [r.actor.id] : [])))
	];
	const named =
		people.length === 0
			? []
			: yield* e.db.rows(
					Schema.Struct({ id: Schema.String, label: Schema.NullOr(Schema.String) }),
					{
						text: 'SELECT id::text AS id, coalesce(name, email, phone) AS label FROM sys_user WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))',
						params: [JSON.stringify(people)]
					}
				);
	const label = new Map(named.map((p) => [p.id, p.label]));
	return revisions.map(({ actor, ...revision }): Json => ({
		...revision,
		by:
			actor === null
				? null
				: actor.kind === 'member'
					? (label.get(actor.id) ?? 'a member')
					: actor.kind
	}));
});

export const withExtras = Effect.fn('AgentTool.readExtras')(function* (
	x: ToolContext,
	full: Json,
	extras: {
		readonly [root: string]: {
			readonly history: boolean;
			readonly approvals: boolean;
			readonly output: string | undefined;
		};
	}
) {
	if (Object.keys(extras).length === 0) return full;
	const e = x.engine,
		a = x.authority,
		readable = readableBy(e.read, e.manifest, a, x.bindings);
	const pages: { readonly [root: string]: Json } = isObj(full) ? full : {};
	const out: { [root: string]: Json } = {};
	for (const [root, page] of Object.entries(pages)) {
		const want = extras[root],
			rows = isObj(page) && isList(page['rows']) ? page['rows'] : undefined;
		if (want === undefined || rows === undefined || !isObj(page)) {
			out[root] = page;
			continue;
		}
		if (want.history && rows.length > HISTORY_ROWS)
			return yield* BoltError.make(
				'invalid_input',
				'decode',
				`${root}: history reads at most ${HISTORY_ROWS} rows; set limit.`
			);
		const ids = rows.flatMap((row) =>
			isObj(row) && typeof row['id'] === 'string' ? [row['id']] : []
		);
		const requests = want.approvals
			? yield* e.approvals.list({ model: root, records: ids, all: true }, a, readable)
			: [];
		const histories = want.history
			? yield* Effect.forEach(ids, (id) => recordHistory(x, root, id, want.output), {
					concurrency: 4
				})
			: [];
		out[root] = {
			...page,
			rows: rows.map((row) => {
				if (!isObj(row) || typeof row['id'] !== 'string') return row;
				const id = row['id'];
				return {
					...row,
					...(want.history ? { $history: histories[ids.indexOf(id)] ?? [] } : {}),
					...(want.approvals
						? {
								$approvals: requests.filter((request) =>
									request.records.some((r) => r.model === root && r.id === id)
								)
							}
						: {})
				};
			})
		};
	}
	return out;
});

const NOTE_FIELDS = 30;

const toolLine = (tool: Pick<AgentTool, 'name' | 'description' | 'input'>) => {
	const properties =
		isObj(tool.input) && isObj(tool.input['properties']) ? tool.input['properties'] : {};
	const required =
		isObj(tool.input) && isList(tool.input['required']) ? tool.input['required'] : [];
	const args = Object.entries(properties).map(([arg, schema]) => {
		const type = isObj(schema) && typeof schema['type'] === 'string' ? schema['type'] : 'json';
		return `${arg}${required.includes(arg) ? '' : '?'}: ${type}`;
	});
	return `${tool.name}(${args.join(', ')}) — ${before(tool.description, '\n').trim()}`;
};

export function catalogueIndex(
	m: EngineManifest,
	a: Authority,
	skills: { readonly [name: string]: Skill },
	mcp: readonly AgentTool[],
	acts: ReadonlyMap<string, Spec>,
	automations: readonly string[],
	syncs: readonly {
		readonly model: string;
		readonly sync: string;
		readonly kind: string;
		readonly modes: readonly string[];
	}[]
): CatalogueIndex {
	const index: { [key: string]: string } = {};
	for (const [name, skill] of Object.entries(skills)) {
		const own = skill.files.filter(
			(f) => f !== 'SKILL.md' && !f.split('/').includes('node_modules')
		);
		const fileList =
			own.length === 0
				? ''
				: ` [files: ${own.slice(0, 12).join(', ')}${own.length > 12 ? `, … +${own.length - 12}` : ''}]`;
		index[`skill:${name}`] = `${name} — ${skillOf(skill.text).description}${fileList}`;
	}
	const roots = readPaths(m, a).filter((path) => !path.includes('.'));
	const writes = new Map<string, string[]>();
	for (const callable of acts.keys()) {
		const dot = callable.lastIndexOf('.'),
			model = callable.slice(0, dot);
		if (callable === APPROVE) index['native:decide'] = 'decide(request_id, decision, reason?)';
		else if (callable === 'sys_invitation.create') index['native:invite'] = 'invite(members)';
		else if (m.models[model] === undefined) index[`native:${callable}`] = callable;
		else writes.set(model, [...(writes.get(model) ?? []), callable.slice(dot + 1)]);
	}
	for (const model of new Set([...roots, ...writes.keys()])) {
		const outputs = roots.includes(model) ? readOutputs(m, a, model) : [],
			fields = outputs[0] === undefined ? [] : Object.entries(fieldKinds(m, model, outputs[0]));
		const shown = fields.slice(0, NOTE_FIELDS).map(([field, kind]) => `${field}: ${kind}`);
		index[`model:${model}`] = [
			`${model}(${shown.join(', ')}${fields.length > shown.length ? `, … ${fields.length - shown.length} more` : ''})`,
			outputs.length === 1 && outputs[0] === 'default'
				? ''
				: ` reads ${outputs.join(', ') || 'none'}`,
			writes.has(model) ? ` writes ${writes.get(model)?.join(', ')}` : ''
		].join('');
	}
	for (const name of automations) {
		const spec = m.automations[name];
		if (spec !== undefined)
			index[`automation:${name}`] =
				`automation.${automationSignature(m, name)} — ${before(spec.description, '\n').trim()}`;
	}
	for (const sync of syncs)
		index[`sync:${sync.model}.${sync.sync}`] =
			`${sync.model}.${sync.sync} (${sync.kind}: ${sync.modes.join(', ')})`;
	if (a.admin)
		index['native:workspace'] =
			'Workspace display settings: read sys_workspace, then act sys_workspace.update with its id and revision to change name. Administrator only; no source change. Private sys_config is not an editable model.';
	if (a.actor.kind === 'member' && readOutputs(m, a, 'sys_user').includes('personal'))
		index['native:personal'] =
			'Personal settings: read sys_user output personal (your id is actor.id), then act sys_user.update with its id and revision. preferences.appearance is light, dark or system; preferences.locale is en or zh; preferences.sounds is a boolean. Merge the existing preferences when changing a key. No source edit or browser tool is needed.';
	for (const tool of mcp) index[`tool:${tool.name}`] = toolLine(tool);
	return index;
}

const SECTIONS = [
	['skill:', 'Skills (skill reads one or several via requests)'],
	['model:', 'Models (fields; reads and writes beyond the default)'],
	['native:', 'Native operations'],
	['page:', 'Pages (page { path }, exact paths)'],
	['automation:', 'Automations (run { automation, input })'],
	['sync:', 'Syncs (sync)'],
	['tool:', 'Tools (run_tool { name, input })']
] as const;

const NOTE_CHANGES = 10;

/**
 * The catalogue note: at a conversation's start (or after a compaction), every line but the MCP tools, which are native;
 * after a merge, only what changed since the last note: added or changed lines, removed names, or counts past
 * `NOTE_CHANGES`; `undefined` when nothing changed since. A tool added after the start is reached through run_tool.
 */
export function catalogueNote(
	index: CatalogueIndex,
	previous: CatalogueIndex | undefined
): string | undefined {
	const sec = (keys: readonly string[]) =>
		SECTIONS.flatMap(([prefix, title]) => {
			const lines = keys.filter((key) => key.startsWith(prefix)).map((key) => index[key] ?? '');
			return lines.length === 0 ? [] : [`${title}:`, ...lines.map((line) => `- ${line}`)];
		});
	if (previous === undefined)
		return [
			'[Catalogue]',
			...sec(Object.keys(index).filter((key) => !key.startsWith('tool:')))
		].join('\n');
	const changed = Object.keys(index).filter((key) => previous[key] !== index[key]);
	const removed = Object.keys(previous).filter((key) => index[key] === undefined);
	if (changed.length === 0 && removed.length === 0) return undefined;
	const name = (key: string) => key.slice(key.indexOf(':') + 1);
	if (changed.length + removed.length > NOTE_CHANGES) {
		const added = changed.filter((key) => previous[key] === undefined).length;
		return `[Catalogue changed by a merge] ${added} added, ${changed.length - added} changed, ${removed.length} removed: describe_workspace and skill read them.`;
	}
	return [
		'[Catalogue changed by a merge]',
		...sec(changed),
		...(removed.length === 0 ? [] : [`Removed: ${removed.map(name).join(', ')}`])
	].join('\n');
}
