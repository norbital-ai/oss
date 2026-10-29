// The manifest the engine consumes (C1, H1): the declaration literals by path-derived name, bodies stripped (an attached
// body is marked `true`), decoded once at each boundary that reads one (`bolt check`, `readArtifact`). Its parts are the
// decl types. `bolt check` proves an authored literal against its type (tsc over the source, then `Verify`), so a part
// decodes as an object of its declared type, while the manifest's own shape (its parts, the workspace, the teams, the
// connections, the policies and the agent text) decodes exactly: an unknown part, a part that is no object or a workspace
// without its zone is `ManifestInvalid`. The accessors derive, once per manifest, what interiors recomputed and cast.
// Runtime imports stay off `contracts.ts`: it re-exports this module.
import { Predicate, Result, Schema } from 'effect';
import type { TeamData, TeamEntries, SourceTeam } from '../decl/access/team.ts';
import type { customField } from '../decl/custom-field.ts';
import type { FieldKind } from '../decl/fields.ts';
import {
	layerModels,
	splitModel,
	type ExposureSpec,
	type ModelLiteral,
	type ModelSpec
} from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { Role } from '../decl/layout.ts';
import type { EnvoySpec, mcp } from '../decl/runtime/agent.ts';
import type { AppSpec, GroupSpec } from '../decl/runtime/app.ts';
import type { AutomationSpec } from '../decl/runtime/automation.ts';
import type { IntegrationSpec } from '../decl/runtime/integration.ts';
import type { KioskSpec } from '../decl/runtime/kiosk.ts';
import { SYSTEM } from '../system/index.ts';
import { ManifestInvalid } from './errors.ts';
import { NEEDS, needsOf } from '../facilities/needs.ts';

// ── parts without a decl type of their own: the literal as the manifest holds it ──
/** A `history` (or identity read) scope: `true` or a `Where`. */
const ScopeWhere = Schema.Union([Schema.Literal(true), Schema.JsonObject]);
/** `{ where }` of a `history` grant; a `Where` naming a model field `where` is told apart by `scopeObject`. */
export const ScopeData = Schema.Struct({ where: Schema.optionalKey(ScopeWhere) });
export type ScopeData = typeof ScopeData.Type;
/** A `history` grant (or an identity model's `read`): `true`, a scope object or a bare `Where`. */
const GrantArm = Schema.Union([Schema.Literal(true), ScopeData, Schema.JsonObject]);
export type GrantArm = typeof GrantArm.Type;
/** One read layer of a grant: its row filter. */
export const LayerGrant = Schema.Struct({ where: Schema.optionalKey(Schema.JsonObject) });
/**
 * A grant of one read output: `true`, a layer map by read path, or (on an identity model, `sys_user`/`sys_invitation`)
 * a bare `Where`.
 */
const ReadGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Record(Schema.String, LayerGrant),
	Schema.JsonObject
]);
export type ReadGrantData = typeof ReadGrantData.Type;
/**
 * A create or update grant: `true`, or the `columns` per write path it admits and `check: true` when its policy declares
 * the callback the guest runs (`policy.<p>.grants.<model>.<op>.check`).
 */
const WriteGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Struct({
		columns: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
		check: Schema.optionalKey(Schema.Literal(true))
	})
]);
export type WriteGrantData = typeof WriteGrantData.Type;
const DeleteGrantData = Schema.Union([
	Schema.Literal(true),
	Schema.Struct({ check: Schema.optionalKey(Schema.Literal(true)) })
]);
export type DeleteGrantData = typeof DeleteGrantData.Type;
/** A policy's grant on one model, workspace-agnostic (the decl side is `Grant<C>`): `read` grants `default`, `outputs` named ones. */
const GrantData = Schema.Struct({
	read: Schema.optionalKey(ReadGrantData),
	outputs: Schema.optionalKey(Schema.Record(Schema.String, ReadGrantData)),
	history: Schema.optionalKey(GrantArm),
	create: Schema.optionalKey(WriteGrantData),
	update: Schema.optionalKey(WriteGrantData),
	delete: Schema.optionalKey(DeleteGrantData),
	moves: Schema.optionalKey(
		Schema.Union([Schema.Literal('all'), Schema.Record(Schema.String, Schema.Array(Schema.String))])
	)
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
	automations: Schema.optionalKey(Schema.Array(Schema.String)),
	capabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	limits: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([LimitData, Schema.Array(LimitData)]))
	)
});
/** A definition's optional test body is marked in the engine projection. */
type IntegrationData = IntegrationSpec & { readonly test?: true };
/** A custom field's literal; `check` marks its `validate`. */
type CustomFieldData = Omit<ReturnType<typeof customField>['spec'], 'validate'> & { check?: true };

/** A part the compiler proved against `T`: an object here. */
const part = <T extends object>(identifier: string) =>
	Schema.declare((u: unknown): u is T => Predicate.isObject(u), { identifier });
const parts = <T extends object>(identifier: string) =>
	Schema.Record(Schema.String, part<T>(identifier));
const ModelData = part<ModelSpec>('model').check(
	Schema.makeFilter((model) =>
		model.was === undefined || typeof model.was === 'string'
			? undefined
			: 'was must be a previous model name'
	)
);

// ── the parts decoded exactly ──
const SecretDecl = Schema.Struct({
	label: Schema.String,
	description: Schema.optionalKey(Schema.String)
});
const ModelClass = Schema.Literals(['default', 'fast', 'strong']);
const Ai = Schema.Struct({
	models: Schema.Array(ModelClass),
	default: ModelClass,
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
	)
});
/** `+workspace.ts` with `+secrets.ts` joined into `secrets`; its `connections` are their own part. */
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
/** `+team.ts`: a handle's policy list, or its structured definition. */
const Teams = Schema.Record(
	Schema.String,
	Schema.Union([
		Schema.Array(Schema.String),
		Schema.Struct({
			name: Schema.optionalKey(Schema.String),
			parent: Schema.optionalKey(Schema.NullOr(Schema.String)),
			policies: Schema.Array(Schema.String)
		})
	])
);
/** A `+workspace.ts` connection: the named instance `<slot>` of `integration`, with its default envoy. */
const Connection = Schema.Struct({
	integration: Schema.String,
	envoy: Schema.optionalKey(Schema.String)
});
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

const manifestFields = {
	workspace: Workspace,
	models: Schema.Record(Schema.String, ModelData),
	relationships: parts<RelationshipSpec>('relationship'),
	exposures: parts<ExposureSpec>('model'),
	/** The workspace's integration definitions by name (bolt's conversation definitions are `SYSTEM.integrations`). */
	integrations: parts<IntegrationData>('integration definition'),
	policies: Schema.Record(Schema.String, PolicyData),
	teams: Teams,
	automations: parts<AutomationSpec>('automation'),
	/** The named instances, by slot (the `sys_integration` id). */
	connections: Schema.Record(Schema.String, Connection),
	/** The envoy roles by id (`src/agent/envoy/+<id>.envoy.ts`). */
	envoys: parts<EnvoySpec>('envoy'),
	mcp: parts<ReturnType<typeof mcp>>('mcp server'),
	apps: parts<AppSpec>('app'),
	/** `+kiosk.ts` literals: standalone kiosks with their assigned policies and the origins that may frame them (`embed`). */
	kiosks: Schema.optionalKey(parts<KioskSpec>('kiosk')),
	/** `+group.ts` literals: nav groups of apps. */ // hook:shell
	groups: Schema.optionalKey(parts<GroupSpec>('group')),
	customFields: parts<CustomFieldData>('custom field'),
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
export const decodeManifest = (u: unknown): Result.Result<EngineManifest, ManifestInvalid> =>
	Result.mapError(decode(u), invalid);
/** `bolt check`'s evaluated manifest (`projectManifest`), decoded, with its needs recorded. */
export const decodeProjectedManifest = (
	u: unknown
): Result.Result<EngineManifest, ManifestInvalid> =>
	Result.mapBoth(decodeProjected(u), {
		onFailure: invalid,
		onSuccess: (m) => ({ ...m, needs: needsOf(m) })
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
 * A role whose literal carries a body (`integration`'s `test`, `customField`'s `validate`, `automation`'s `run`): the data
 * without it, and `<as>: true` where the engine needs to know it exists. A body is a function, or the check serializer's `true`.
 */
const marked = (role: Record<string, unknown>, body: string, as?: string) =>
	Object.fromEntries(
		Object.entries(role).map(([name, v]) => {
			const { [body]: fn, ...data } = object(literal(v));
			return [name, as === undefined || fn === undefined ? data : { ...data, [as]: true }];
		})
	);
/** A write grant's `check` callback (`policy.<p>.grants.<model>.<op>.check`, run in the guest) marked `true`. */
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
										Predicate.isObject(arm) && 'check' in arm && typeof arm.check === 'function'
											? { ...arm, check: true }
											: arm
									])
								)
							: grant
					])
				)
			}
		: p;
/** A `model()` literal (the compiler proved it against its type); anything else is left to `decodeManifest` to refuse. */
const isModelLiteral = (u: unknown): u is ModelLiteral =>
	Predicate.isObject(u) && 'fields' in u && Predicate.isObject(u.fields);
/** Each model literal split into the engine's three parts (`splitModel`): storage, its refs, and its exposure when it has `read`. */
function modelParts(role: Record<string, unknown>) {
	const models: { [name: string]: unknown } = {},
		relationships: { [key: string]: unknown } = {},
		exposures: { [name: string]: unknown } = {};
	for (const [name, v] of Object.entries(role)) {
		const lit = literal(v);
		if (!isModelLiteral(lit)) {
			models[name] = lit;
			continue;
		}
		const parts = splitModel(name, lit);
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

/** P1's loaded manifest as the engine's, before `decodeManifest`: `+secrets.ts` joins the workspace as `secrets`. */
export function projectManifest(m: LoadedManifest): unknown {
	const { connections = {}, ...workspace } = object(m.workspace['']);
	const secrets = m.secrets[''];
	return {
		workspace: secrets === undefined ? workspace : { ...workspace, secrets },
		...modelParts(m.model),
		integrations: marked(m.integration_definition, 'test', 'test'),
		policies: Object.fromEntries(
			Object.entries(m.policy).map(([name, v]) => [name, policyData(literal(v))])
		),
		teams: m.team[''] ?? {},
		automations: marked(m.automation, 'run'),
		connections,
		envoys: specs(m.envoy),
		mcp: specs(m.mcp),
		apps: specs(m.app),
		kiosks: specs(m.kiosk),
		groups: specs(m.group),
		customFields: marked(m.custom_field, 'validate', 'check'),
		agent: {
			...defined({ internal: m.agent[''], external: m.agent_external[''] }),
			skills: specs(m.skill)
		}
	};
}
/** A loaded manifest the caller has already checked, decoded; a refusal throws `ManifestInvalid` (tests, fixtures). */
export const engineManifest = (m: LoadedManifest): EngineManifest =>
	Result.getOrThrow(decodeProjectedManifest(projectManifest(m)));

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

/** The envoys anyone may reach (`audience: 'public'`): their threads are in every member's list (rule 61). */
export const publicEnvoys = memo((m): readonly string[] =>
	Object.entries(m.envoys)
		.filter(([, e]) => e.audience === 'public')
		.map(([name]) => name)
);
/** The secret names `+secrets.ts` declares, their values sealed in the tenant store. */
export const declaredSecrets = memo((m): readonly string[] =>
	Object.keys(m.workspace.secrets ?? {})
);
/** The apps whose public pages a visitor opens through a Turnstile challenge. */
export const challengedApps = memo((m): readonly string[] =>
	Object.entries(m.apps)
		.filter(([, a]) => typeof a.audience === 'object' && a.audience.challenge === 'turnstile')
		.map(([name]) => name)
);
/** The source teams in one shape: a policy list is a team labelled by its handle, without a parent. */
const structuredTeam = (entry: readonly string[] | TeamData): entry is TeamData =>
	!Array.isArray(entry);
/** A schema slice's team entries in the same runtime shape as the manifest catalogue. */
export function teamEntries(entries: TeamEntries): { readonly [handle: string]: SourceTeam } {
	return Object.fromEntries(
		Object.entries(entries).map(([handle, entry]) => [
			handle,
			structuredTeam(entry)
				? { name: entry.name ?? handle, parent: entry.parent ?? null, policies: entry.policies }
				: { name: handle, parent: null, policies: entry }
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
 * Per exposed model (the built-in layer's included), each declared layer path → the model behind it (`layerModels`):
 * what the store scope, the authority and the lowering key every path by. `bolt check` refuses a path that resolves to
 * nothing (`model/layer`), so a decoded artifact's paths all resolve.
 */
export const layers = memo(
	(m): { readonly [model: string]: { readonly [path: string]: string } } => {
		const all = layered(m);
		return Object.fromEntries(
			Object.entries(all.exposures).map(([model, c]) => [
				model,
				layerModels(model, c, all.relationships).models
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
	readonly spec: RelationshipSpec;
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
