// The manifest the engine consumes (C1, H1): the declaration literals by path-derived name, bodies stripped (an attached
// body is marked `true`), decoded once at each boundary that reads one (`bolt check`, `readArtifact`). Its parts are the
// decl types. `bolt check` proves an authored literal against its type (tsc over the source, then `Verify`), so a part
// decodes as an object of its declared type, while the manifest's own shape (its parts, the workspace, the teams, the
// connections and the agent text) decodes exactly: an unknown part, a part that is no object or a workspace without its
// zone is `ManifestInvalid`. The accessors derive, once per manifest, what interiors recomputed and cast.
// Runtime imports stay off `contracts.ts`: it re-exports this module.
import { Predicate, Result, Schema } from 'effect';
import type { Manifest } from '../compiler/load.ts';
import type { TeamData, TeamEntries, SourceTeam } from '../decl/access/team.ts';
import type { CollectionSpec } from '../decl/collection.ts';
import type { customField } from '../decl/custom-field.ts';
import type { FieldKind, InputFields } from '../decl/fields.ts';
import type { ModelSpec } from '../decl/model.ts';
import type { RelationshipSpec } from '../decl/names.ts';
import type { EnvoySpec, mcp } from '../decl/runtime/agent.ts';
import type { AppSpec, GroupSpec } from '../decl/runtime/app.ts';
import type { AutomationSpec } from '../decl/runtime/automation.ts';
import type { IntegrationSpec } from '../decl/runtime/integration.ts';
import type { KioskSpec } from '../decl/runtime/kiosk.ts';
import { SYSTEM } from '../system/index.ts';
import { ManifestInvalid } from './errors.ts';

// ── parts without a decl type of their own: the literal as the manifest holds it ──
/** A `+*.policy.ts` literal; each collection's grant is the access compiler's to read (`access/authority.ts`). */
type PolicyData = {
	description: string;
	grants: { readonly [collection: string]: { readonly [key: string]: unknown } };
	automations?: readonly string[];
	capabilities?: { readonly [kind: string]: readonly string[] };
	limits?: { readonly [key: string]: unknown };
};
/** A `+pipeline.ts` literal; `records` and `map` are required bodies, the optional ones are marked when attached. */
type PipelineData = {
	import?: {
		description: string;
		input: InputFields;
		context?: InputFields;
		onConflict?: 'update' | 'keep';
		known?: true;
		related?: { readonly [relation: string]: true };
		scope?: { by: readonly string[]; range?: string; of?: true };
		check?: true;
		template?: true;
	};
	export?: {
		description: string;
		select: readonly string[];
		where?: object;
		format: 'csv' | 'xlsx' | 'json';
	};
};
/** A definition's optional test body is marked in the engine projection. */
type IntegrationData = IntegrationSpec & { readonly test?: true };
/** A custom field's literal; `check` marks an attached `validate`. */
type CustomFieldData = ReturnType<typeof customField>['spec'] & { check?: true };

/** A part the compiler proved against `T`: an object here. */
const part = <T extends object>(identifier: string) =>
	Schema.declare((u: unknown): u is T => Predicate.isObject(u), { identifier });
const parts = <T extends object>(identifier: string) =>
	Schema.Record(Schema.String, part<T>(identifier));

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
			collection: Schema.String,
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
/** `+agent.md`, `+agent.external.md` and the skills, as text. */
const Agent = Schema.Struct({
	internal: Schema.optionalKey(Schema.String),
	external: Schema.optionalKey(Schema.String),
	skills: Schema.Record(Schema.String, Schema.String)
});

export const EngineManifestSchema = Schema.Struct({
	workspace: Workspace,
	models: parts<ModelSpec>('model'),
	relationships: parts<RelationshipSpec>('relationship'),
	collections: parts<CollectionSpec>('collection'),
	/** The workspace's integration definitions by name (bolt's conversation definitions are `SYSTEM.integrations`). */
	integrations: parts<IntegrationData>('integration definition'),
	pipelines: parts<PipelineData>('pipeline'),
	policies: parts<PolicyData>('policy'),
	teams: Teams,
	automations: parts<AutomationSpec>('automation'),
	/** The named instances, by slot (the `sys_integration` id). */
	connections: Schema.Record(Schema.String, Connection),
	/** The envoy roles by id (`src/agent/envoy/+<id>.envoy.ts`). */
	envoys: parts<EnvoySpec>('envoy'),
	mcp: parts<ReturnType<typeof mcp>>('mcp server'),
	apps: parts<AppSpec>('app'),
	/** `+kiosk.ts` literals: standalone kiosks with their assigned policies. */
	kiosks: Schema.optionalKey(parts<KioskSpec>('kiosk')),
	/** `+group.ts` literals: nav groups of apps. */ // hook:shell
	groups: Schema.optionalKey(parts<GroupSpec>('group')),
	customFields: parts<CustomFieldData>('custom field'),
	agent: Agent
});
/** Pure data: declaration literals by path-derived name, bodies stripped (they run in the guest). */
export type EngineManifest = Schema.Schema.Type<typeof EngineManifestSchema>;

const decode = Schema.decodeUnknownResult(EngineManifestSchema, {
	errors: 'all',
	onExcessProperty: 'error',
	propertyOrder: 'original'
});
/** The one manifest decoder (A.4): `bolt check`'s evaluated manifest and every artifact read. */
export const decodeManifest = (u: unknown): Result.Result<EngineManifest, ManifestInvalid> =>
	Result.mapError(decode(u), (e) => new ManifestInvalid({ issues: e.message.split('\n') }));

const object = (v: unknown): { readonly [key: string]: unknown } =>
	Predicate.isObject(v) ? v : {};
/** A `{ name, spec }` (or `{ spec, bodies }`) wrapper gives its literal; a bare literal is itself. */
const literal = (v: unknown): unknown => (Predicate.isObject(v) && 'spec' in v ? v.spec : v);
const specs = (role: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(role).map(([k, v]) => [k, literal(v)]));
const defined = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
/** P1's loaded manifest as the engine's, before `decodeManifest`: `+secrets.ts` joins the workspace as `secrets`. */
export function projectManifest(m: Manifest): unknown {
	const { connections = {}, ...workspace } = object(m.workspace['']);
	const secrets = m.secrets[''];
	return {
		workspace: secrets === undefined ? workspace : { ...workspace, secrets },
		models: specs(m.model),
		relationships: m.relationship[''] ?? {},
		collections: specs(m.collection),
		integrations: Object.fromEntries(
			Object.entries(m.integration_definition).map(([name, definition]) => {
				const bodies = object(object(definition)['bodies']);
				return [
					name,
					{ ...object(literal(definition)), ...(bodies['test'] === true ? { test: true } : {}) }
				];
			})
		),
		pipelines: specs(m.pipeline),
		policies: specs(m.policy),
		teams: m.team[''] ?? {},
		automations: specs(m.automation),
		connections,
		envoys: specs(m.envoy),
		mcp: specs(m.mcp),
		apps: specs(m.app),
		kiosks: specs(m.kiosk),
		groups: specs(m.group),
		customFields: specs(m.custom_field),
		agent: {
			...defined({ internal: m.agent[''], external: m.agent_external[''] }),
			skills: specs(m.skill)
		}
	};
}
/** A loaded manifest the caller has already checked, decoded; a refusal throws `ManifestInvalid` (tests, fixtures). */
export const engineManifest = (m: Manifest): EngineManifest =>
	Result.getOrThrow(decodeManifest(projectManifest(m)));

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
/** The manifest with the built-in layer beside the workspace's models, relationships, collections and integrations. */
export const layered = memo((m): EngineManifest => ({
	...m,
	models: { ...SYSTEM.models, ...m.models },
	relationships: { ...SYSTEM.relationships, ...m.relationships },
	collections: { ...SYSTEM.collections, ...m.collections },
	integrations: { ...SYSTEM.integrations, ...m.integrations }
}));

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
