// The manifest the engine consumes (C1, H1): the declaration literals by path-derived name, bodies stripped (an attached
// body is marked `true`), decoded once at each boundary that reads one (`bolt check`, `read_artifact`). Its parts are the
// runtime codecs. Authored literals additionally have the compiler's narrower name/type checks. Every part and the
// manifest's own shape (the workspace, teams, policies and agent text) decodes exactly: an unknown part or a workspace
// without its zone is `ManifestInvalid`. The accessors derive, once per manifest, what interiors recomputed and cast.
// Runtime codecs stay with their owners; `contracts.ts` imports their derived types.
import { Predicate, Result, Schema } from 'effect';
import { FieldData, OutputData } from '../decl/field-data.ts';
import type { TeamEntries, SourceTeam } from '../decl/access/team.ts';
import type { FieldKind } from '../decl/fields.ts';
import { layer_models, column_layers } from '../decl/model.ts';
import { ModelData, RelationshipData, SyncData, split_model } from '../decl/model-data.ts';
import type { Role } from '../decl/layout.ts';
import { AppData, GroupSpec } from '../decl/runtime/app.ts';
import { CallCacheDuration, DeclaredDuration, TriggerSpec } from '../decl/runtime/automation.ts';
import { AutomationInputSchema } from '../decl/runtime/automation-input.ts';
import { IntegrationSpec } from '../decl/runtime/integration.ts';
import { SYSTEM } from '../system/index.ts';
import { ManifestInvalid } from './errors.ts';
import { NEEDS, needs_of } from '../facilities/needs.ts';

// ── parts without a decl type of their own: the literal as the manifest holds it ──
/** A `history` (or identity read) scope: `true` or a `Where`. */
const ReadGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Struct({
		scopes: Schema.optionalKey(Schema.Record(Schema.String, Schema.JsonObject)),
		history: Schema.optionalKey(Schema.Literal(true))
	})
]);
export type ReadGrantData = typeof ReadGrantData.Type;
/**
 * A create or update grant: `true`, or the admitted `columns` and the guest verdict marker.
 */
const writeGrantFields = {
	columns: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	verdict: Schema.optionalKey(Schema.Literal(true))
};
const WriteGrantData = Schema.Union([Schema.Literal(true), Schema.Struct(writeGrantFields)]);
export type WriteGrantData = typeof WriteGrantData.Type;
const UpdateGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Struct({
		...writeGrantFields,
		moves: Schema.optionalKey(
			Schema.Union([
				Schema.Literal('all'),
				Schema.Record(Schema.String, Schema.Array(Schema.String))
			])
		)
	})
]);
const DeleteGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Struct({ verdict: Schema.optionalKey(Schema.Literal(true)) })
]);
export type DeleteGrantData = typeof DeleteGrantData.Type;
/** A policy's grant on one model, with each output's scopes keyed by the compiled read paths. */
const GrantData = Schema.Struct({
	outputs: Schema.optionalKey(Schema.Record(Schema.String, ReadGrantData)),
	create: Schema.optionalKey(WriteGrantData),
	update: Schema.optionalKey(UpdateGrantData),
	delete: Schema.optionalKey(DeleteGrantData)
});
export type GrantData = typeof GrantData.Type;
/** One `limits` entry (rule 38): a bare rate counts per actor (an envoy key: per sender); a list applies every rule. */
const LimitData = Schema.Union([
	Schema.String,
	Schema.Struct({ rate: Schema.String, per: Schema.Literals(['actor', 'ip', 'sender', 'subject']) })
]);
export type LimitData = typeof LimitData.Type;
/** A `+*.policy.ts` literal; its grants decode here once, and the access compiler reads them (`access/authority.ts`). */
const PolicyData = Schema.Struct({
	description: Schema.String,
	grants: Schema.Record(Schema.String, GrantData),
	capabilities: Schema.optionalKey(
		Schema.Struct({
			apps: Schema.optionalKey(Schema.Array(Schema.String)),
			automations: Schema.optionalKey(Schema.Array(Schema.String)),
			syncs: Schema.optionalKey(Schema.Array(Schema.String)),
			mcp: Schema.optionalKey(Schema.Array(Schema.String)),
			tools: Schema.optionalKey(Schema.Array(Schema.String))
		})
	),
	limits: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([LimitData, Schema.Array(LimitData)]))
	)
});
const Marker = Schema.optionalKey(Schema.Literal(true));
const IntegrationData = Schema.Struct({ ...IntegrationSpec.fields, test: Marker });
const CustomFieldData = Schema.Struct({
	description: Schema.String, shape: FieldData,
	label: Schema.optionalKey(Schema.String), search: Marker, check: Marker
});
const McpData = Schema.Struct({
	description: Schema.String, url: Schema.String,
	auth: Schema.optionalKey(Schema.Union([
		Schema.Struct({ bearer: Schema.String }),
		Schema.Struct({ oauth: Schema.Struct({
			client_id: Schema.String, client_secret: Schema.optionalKey(Schema.String),
			scopes: Schema.optionalKey(Schema.Array(Schema.String))
		}) })
	])),
	tools: Schema.optionalKey(Schema.Array(Schema.String))
});
const ReadLayers = Schema.Record(
	Schema.String,
	Schema.Struct({ fields: Schema.Union([Schema.Literal('all'), Schema.Array(Schema.String)]) })
);
const Columns = Schema.Record(Schema.String, Schema.Array(Schema.String));
const ExposureData = Schema.Struct({
	outputs: Schema.StructWithRest(Schema.Struct({ default: ReadLayers }), [
		Schema.Record(Schema.String, ReadLayers)
	]),
	create: Schema.optionalKey(
		Schema.Struct({
			columns: Columns,
			filled: Schema.optionalKey(Columns),
			transform: Marker,
			effect: Marker
		})
	),
	update: Schema.optionalKey(Schema.Struct({ columns: Columns, transform: Marker, effect: Marker })),
	delete: Schema.optionalKey(Schema.Struct({ effect: Marker })),
	syncs: Schema.optionalKey(Schema.Record(Schema.String, SyncData))
});

// ── the parts decoded exactly ──
const SecretDecl = Schema.Struct({
	label: Schema.String,
	description: Schema.optionalKey(Schema.String)
});
const Ai = Schema.Struct({
	embeddings: Schema.optionalKey(Schema.Array(Schema.String))
});
const Signup = Schema.Struct({
	via: Schema.Array(Schema.Literals(['email', 'phone'])),
	policies: Schema.Array(Schema.String),
	party: Schema.optionalKey(
		Schema.Struct({
			model: Schema.String,
			match: Schema.Struct({
				email: Schema.optionalKey(Schema.String),
				phone: Schema.optionalKey(Schema.String)
			})
		})
	),
	challenge: Schema.optionalKey(Schema.Literal('turnstile'))
});
/** Workspace capabilities with the separately declared secrets joined into the workspace. */
const Workspace = Schema.Struct({
	tz: Schema.String,
	locale: Schema.String,
	currency: Schema.optionalKey(Schema.String),
	apps: Schema.optionalKey(Schema.Array(Schema.String)),
	secrets: Schema.optionalKey(Schema.Record(Schema.String, SecretDecl)),
	ai: Schema.optionalKey(Ai),
	convert: Schema.optionalKey(
		Schema.Struct({
			to: Schema.Array(Schema.Literals(['pdf', 'docx', 'pptx', 'odt', 'epub', 'html']))
		})
	),
	csp: Schema.optionalKey(
		Schema.Struct({ connect: Schema.optionalKey(Schema.Array(Schema.String)) })
	),
	agent: Schema.optionalKey(Schema.Struct({ triage: Schema.optionalKey(Schema.Literal(false)) })), // hook:triage
	signup: Schema.optionalKey(Signup)
});
/** `+team.ts`: each handle owns one structured definition. */
const Teams = Schema.Record(
	Schema.String,
	Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
		policies: Schema.Array(Schema.String)
	})
);
/**
 * A skill (compute model §3, "Running a file"): a folder of `SKILL.md`, its scripts and the pure-JavaScript packages it
 * vendors, at most `SKILL_BYTES`. Its `SKILL.md` text, the digest of its tree (sha256 hex of the sorted
 * `<path>\0<sha256 hex>` lines, `\n`-joined) and its file paths, sorted; the bytes are the artifact's `skills/<name>/`.
 */
export const SkillSchema = Schema.Struct({
	text: Schema.String,
	digest: Schema.String,
	files: Schema.Array(Schema.String)
});
export type SkillSpec = typeof SkillSchema.Type;
export const SKILL_BYTES = 10 * 1024 * 1024;
/** The skill's text in its tree (in a workspace's source, the folder's `+skill.md`). */
export const SKILL_FILE = 'SKILL.md';
/** `+agent.md`, `+agent.external.md` (text) and the skills. */
const Agent = Schema.Struct({
	internal: Schema.optionalKey(Schema.String),
	external: Schema.optionalKey(Schema.String),
	skills: Schema.Record(Schema.String, SkillSchema)
});

const AutomationBase = {
	description: Schema.String,
	input: Schema.optionalKey(AutomationInputSchema),
	output: Schema.optionalKey(OutputData),
	policies: Schema.NonEmptyArray(Schema.String),
	agent: Schema.optionalKey(Schema.Literals(['direct', 'confirm', 'never']))
};
const Absent = Schema.optionalKey(Schema.Never);
/** A job may trigger, retry and queue; a call may cache and does none of those. */
const AutomationData = Schema.Union([
	Schema.Struct({
		...AutomationBase,
		mode: Schema.optionalKey(Schema.Literal('job')),
		cache: Absent,
		on: Schema.optionalKey(Schema.Array(TriggerSpec)),
		retry: Schema.optionalKey(
			Schema.Struct({
				attempts: Schema.Literals([2, 3, 4, 5, 6, 7, 8]),
				backoff: Schema.optionalKey(DeclaredDuration)
			})
		),
		concurrency: Schema.optionalKey(
			Schema.Struct({ max: Schema.Literals([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) })
		)
	}),
	Schema.Struct({
		...AutomationBase,
		mode: Schema.Literal('call'),
		cache: Schema.optionalKey(CallCacheDuration),
		on: Absent,
		retry: Absent,
		concurrency: Absent
	})
]);
const MessageCatalogue = Schema.Record(Schema.String, Schema.String);
const manifestFields = {
	workspace: Workspace,
	/** Authored catalogue resolved for the workspace locale; file captions use the same text as its client. */
	messages: Schema.optionalKey(MessageCatalogue),
	models: Schema.Record(Schema.String, ModelData),
	relationships: Schema.Record(Schema.String, RelationshipData),
	exposures: Schema.Record(Schema.String, ExposureData),
	/** The workspace's integration definitions by name (bolt's conversation definitions are `SYSTEM.integrations`). */
	integrations: Schema.Record(Schema.String, IntegrationData),
	policies: Schema.Record(Schema.String, PolicyData),
	teams: Teams,
	automations: Schema.Record(Schema.String, AutomationData),
	mcp: Schema.Record(Schema.String, McpData),
	apps: Schema.Record(Schema.String, AppData),
	/** `+group.ts` literals: nav groups of apps. */ // hook:shell
	groups: Schema.optionalKey(Schema.Record(Schema.String, GroupSpec)),
	custom_fields: Schema.Record(Schema.String, CustomFieldData),
	agent: Agent
};
export const EngineManifestSchema = Schema.Struct({
	...manifestFields,
	/** What the bundle needs from its host (`@norbital-ai/bolt/facilities`), recorded at build. */
	needs: Schema.Array(Schema.Literals(NEEDS))
});
/** Pure data: declaration literals by path-derived name, bodies stripped (they run in the guest). */
export type EngineManifest = Schema.Schema.Type<typeof EngineManifestSchema>;

const options = { errors: 'all', onExcessProperty: 'error' } as const;
const decode = Schema.decodeUnknownResult(EngineManifestSchema, options),
	decodeProjected = Schema.decodeUnknownResult(Schema.Struct(manifestFields), options);
const invalid = (e: Schema.SchemaError) => new ManifestInvalid({ issues: e.message.split('\n') });
/** The one manifest decoder (A.4): every artifact read. */
export const decode_manifest = (u: unknown): Result.Result<EngineManifest, ManifestInvalid> =>
	Result.mapError(decode(u), invalid);
/** `bolt check`'s evaluated manifest (`project_manifest`), decoded, with its needs recorded. */
export const decode_projected_manifest = (
	u: unknown
): Result.Result<EngineManifest, ManifestInvalid> =>
	Result.mapBoth(decodeProjected(u), {
		onFailure: invalid,
		onSuccess: (m) => ({ ...m, needs: needs_of(m) })
	});

const object = (v: unknown): { readonly [key: string]: unknown } =>
	Predicate.isObject(v) ? v : {};
/** A `{ name, spec }` (or `{ spec, bodies }`) wrapper gives its literal; a bare literal is itself. */
const literal = (v: unknown): unknown => (Predicate.isObject(v) && 'spec' in v ? v.spec : v);
const specs = (role: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(role).map(([k, v]) => [k, literal(v)]));
const defined = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
/**
 * A role whose literal carries a body (`integration`'s `test`, `custom_field`'s `validate`, `automation`'s `run`): the data
 * without it, and `<as>: true` where the engine needs to know it exists. A body is a function, or the check serializer's `true`.
 */
const marked = (role: Record<string, unknown>, body: string, as?: string) =>
	Object.fromEntries(
		Object.entries(role).map(([name, v]) => {
			const { [body]: fn, ...data } = object(literal(v));
			return [name, as === undefined || fn === undefined ? data : { ...data, [as]: true }];
		})
	);
/** Lower an output's nested scopes to the same paths as the model output. */
function outputGrant(model: string, output: unknown): unknown {
	if (!Predicate.isObject(output)) return output;
	const scopes: Record<string, unknown> = {};
	const visit = (path: string, value: Readonly<Record<string, unknown>>) => {
		const { where, history, ...children } = value;
		if (history !== undefined && path !== model)
			throw new Error(`'${path}': history belongs on the root output grant`);
		if (where !== undefined || path !== model) scopes[path] = where === undefined ? {} : where;
		for (const [relation, child] of Object.entries(children)) {
			if (relation.includes('.') || !Predicate.isObject(child))
				throw new Error(`'${path}.${relation}': expected a nested output grant`);
			visit(`${path}.${relation}`, child);
		}
	};
	visit(model, output);
	return defined({
		scopes: Object.keys(scopes).length === 0 ? undefined : scopes,
		history: output['history']
	});
}
const writeGrant = (model: string, arm: unknown): unknown =>
	Predicate.isObject(arm) ? {
		...arm,
		...(arm['columns'] === undefined ? {} : { columns: column_layers(model, arm['columns']) }),
		...(typeof arm['verdict'] === 'function' ? { verdict: true } : {})
	} : arm;
/** Lower the read scopes and mark each write grant's guest verdict callback as present. */
const policyData = (p: unknown): unknown =>
	Predicate.isObject(p) && 'grants' in p && Predicate.isObject(p.grants)
		? {
				...p,
				grants: Object.fromEntries(
					Object.entries(object(p.grants)).map(([model, grant]) => [
						model,
						Predicate.isObject(grant)
							? Object.fromEntries(
									Object.entries(object(grant)).map(([op, arm]) => [
										op,
										op === 'outputs' && Predicate.isObject(arm)
											? Object.fromEntries(
													Object.entries(arm).map(([name, output]) => [
														name,
														outputGrant(model, output)
													])
												)
											: op === 'create' || op === 'update' || op === 'delete'
												? writeGrant(model, arm) : arm
									])
								)
							: grant
					])
				)
			}
		: p;
/** Split each model into its storage, its refs and the exposure defined by its outputs. */
function modelParts(role: Record<string, unknown>) {
	const models: { [name: string]: unknown } = {},
		relationships: { [key: string]: unknown } = {},
		exposures: { [name: string]: unknown } = {};
	for (const [name, v] of Object.entries(role)) {
		const parts = split_model(name, literal(v));
		models[name] = parts.model;
		Object.assign(relationships, parts.relationships);
		if (parts.exposure !== undefined) exposures[name] = parts.exposure;
	}
	return { models, relationships, exposures };
}
/**
 * `manifest[role][name]`: a `.ts` role's default export (declarations are data), a `.md` role's text, a `.svelte`
 * role's path (the bundler compiles it).
 */
export type LoadedManifest = { [R in Role]: Record<string, unknown> };

const catalogue = (value: unknown, source: string): typeof MessageCatalogue.Type => {
	const decoded = Schema.decodeUnknownResult(MessageCatalogue)(value);
	if (Result.isFailure(decoded))
		throw new ManifestInvalid({ issues: [`${source}: ${decoded.failure.message}`] });
	return decoded.success;
};
/** The client's base catalogue and exact/language locale precedence, without a browser or inline field text. */
function resolvedMessages(m: LoadedManifest, workspace: Readonly<Record<string, unknown>>) {
	const hasBase = Object.hasOwn(m.messages, '');
	if (!hasBase && Object.keys(m.locale).length === 0) return undefined;
	const locales = new Map(
		Object.entries(m.locale).map(([name, value]) =>
			[name.toLowerCase(), catalogue(value, `locale ${name}`)] as const
		)
	);
	const locale = typeof workspace['locale'] === 'string' ? workspace['locale'].toLowerCase() : '';
	const language = locale.split('-')[0] ?? locale;
	return {
		...(hasBase ? catalogue(m.messages[''], 'messages') : {}),
		...(locales.get(locale) ?? locales.get(language) ?? {})
	};
}

/** P1's loaded manifest as the engine's, before `decode_manifest`: `+secrets.ts` joins the workspace as `secrets`. */
export function project_manifest(m: LoadedManifest): unknown {
	const workspace = object(m.workspace['']);
	const secrets = m.secrets[''];
	const messages = resolvedMessages(m, workspace);
	return {
		workspace: secrets === undefined ? workspace : { ...workspace, secrets },
		...(messages === undefined ? {} : { messages }),
		...modelParts(m.model),
		integrations: marked(m.integration_definition, 'test', 'test'),
		policies: Object.fromEntries(
			Object.entries(m.policy).map(([name, v]) => [name, policyData(literal(v))])
		),
		teams: m.team[''] ?? {},
		automations: marked(m.automation, 'run'),
		mcp: specs(m.mcp),
		apps: m.app,
		groups: m.group,
		custom_fields: marked(m.custom_field, 'validate', 'check'),
		agent: {
			...defined({ internal: m.agent[''], external: m.agent_external[''] }),
			skills: specs(m.skill)
		}
	};
}
/** A loaded manifest the caller has already checked, decoded; a refusal throws `ManifestInvalid` (tests, fixtures). */
export const engine_manifest = (m: LoadedManifest): EngineManifest =>
	Result.getOrThrow(decode_projected_manifest(project_manifest(m)));

// ── accessors: each derived once per decoded manifest ──
const memo = <A>(derive: (m: EngineManifest) => A) => {
	const cache = new WeakMap<EngineManifest, { readonly value: A }>();
	return (m: EngineManifest): A => {
		const hit = cache.get(m);
		if (hit !== undefined) return hit.value;
		const value = derive(m);
		cache.set(m, { value });
		return value;
	};
};

/** The secret names `+secrets.ts` declares, their values sealed in the tenant store. */
export const declared_secrets = memo((m): readonly string[] =>
	Object.keys(m.workspace.secrets ?? {})
);
/** The apps whose public pages a visitor opens through a Turnstile challenge. */
export const challengedApps = memo((m): readonly string[] =>
	Object.entries(m.apps)
		.filter(([, a]) => typeof a.audience === 'object' && a.audience.challenge === 'turnstile')
		.map(([name]) => name)
);
/** A schema slice's team entries in the same runtime shape as the manifest catalogue. */
export function teamEntries(entries: TeamEntries): { readonly [handle: string]: SourceTeam } {
	return Object.fromEntries(
		Object.entries(entries).map(([handle, entry]) => [
			handle,
			{ name: entry.name ?? handle, parent: entry.parent ?? null, policies: entry.policies }
		])
	);
}
export const teams = memo((m): { readonly [handle: string]: SourceTeam } => teamEntries(m.teams));
/** The manifest with the built-in layer beside the workspace's models, relationships, models and integrations. */
export const layered = memo((m): EngineManifest => ({
	...m,
	models: { ...SYSTEM.models, ...m.models },
	relationships: { ...SYSTEM.relationships, ...m.relationships },
	exposures: { ...SYSTEM.exposures, ...m.exposures },
	integrations: { ...SYSTEM.integrations, ...m.integrations }
}));

/**
 * Per exposed model (the built-in layer's included), each declared layer path → the model behind it (`layer_models`):
 * what the store scope, the authority and the lowering key every path by. `bolt check` refuses a path that resolves to
 * nothing (`model/layer`), so a decoded artifact's paths all resolve.
 */
export const layers = memo(
	(m): { readonly [model: string]: { readonly [path: string]: string } } => {
		const all = layered(m);
		return Object.fromEntries(
			Object.entries(all.exposures).map(([model, c]) => [
				model,
				layer_models(model, c, all.relationships).models
			])
		);
	}
);

export type StateKind = Extract<FieldKind, { kind: 'state' }>;
/** `model`'s state field (`bolt check` admits at most one): its name and its states. */
export function stateField(
	m: EngineManifest,
	model: string
): { readonly name: string; readonly spec: StateKind } | undefined {
	for (const [name, spec] of Object.entries(m.models[model]?.fields ?? {}))
		if (spec.kind === 'state') return { name, spec };
	return undefined;
}

/** One relationship, `<from>.<fk>`: its target models (an arc names several) and its inverse many-relation. */
export type Relation = {
	readonly key: string;
	readonly from: string;
	readonly fk: string;
	readonly targets: readonly string[];
	readonly inverse: string | undefined;
	readonly spec: EngineManifest['relationships'][string];
};
/** The relationships indexed once: by the model that declares the FK, and by `<target>.<inverse>`. */
export type RelationIndex = {
	readonly all: readonly Relation[];
	readonly from: ReadonlyMap<string, readonly Relation[]>;
	readonly inverse: ReadonlyMap<string, Relation>;
};
/** The workspace's relationships; `relations(layered(m))` adds the built-in layer's. */
export const relations = memo((m): RelationIndex => {
	const all = Object.entries(m.relationships).map(([key, spec]): Relation => {
		const dot = key.indexOf('.');
		return {
			key,
			from: key.slice(0, dot),
			fk: key.slice(dot + 1),
			targets: typeof spec.to === 'string' ? [spec.to] : spec.to,
			inverse: spec.inverse,
			spec
		};
	});
	return {
		all,
		from: Map.groupBy(all, (r) => r.from),
		inverse: new Map(
			all.flatMap((r) =>
				r.inverse === undefined ? [] : r.targets.map((t) => [`${t}.${r.inverse}`, r] as const)
			)
		)
	};
});
