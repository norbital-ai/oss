import { Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { SkillDeclaration, type ToolDeclaration, type WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import type { HostToolsInterface } from '#lib/runtime/facilities/services.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { SkillError, ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';

const platformToolNames = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection',
	'write_collection'
] as const;
const PlatformToolNames = Schema.Literals([...platformToolNames]);
type PlatformToolName = Schema.Schema.Type<typeof PlatformToolNames>;

export const isPlatformTool = Schema.is(PlatformToolNames);

export const platformToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'describe_workspace',
		description: 'Describe collections, apps, envoys, tools, automations, and integrations.',
		command: 'platform:describe_workspace'
	},
	{
		name: 'list_skills',
		description: 'List skill names available to this agent.',
		command: 'platform:list_skills'
	},
	{
		name: 'read_skill',
		description: 'Read a skill body by name.',
		command: 'platform:read_skill'
	},
	{
		name: 'read_collection',
		description: 'Read records from a collection the subject can access.',
		command: 'platform:read_collection'
	},
	{
		name: 'write_collection',
		description: 'Create, update, or delete a collection record.',
		command: 'platform:write_collection'
	}
];

const SkillNameInput = Schema.Struct({ name: Schema.NonEmptyString });
const CollectionReadInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	limit: Schema.optionalKey(Schema.Number)
});
const CollectionWriteInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete']),
	id: Schema.NonEmptyString,
	values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});

type ToolExecutionContext = Readonly<{
	readonly effectId: EffectIdType;
	readonly subject: Identity.Subject;
	readonly agentName: string;
	/** The skills this subject's policies grant. */
	readonly skills: ReadonlyArray<SkillDeclaration>;
	/** The tools this turn was offered, so `describe_workspace` reports what is actually reachable. */
	readonly toolNames: ReadonlyArray<string>;
	readonly workspace: Workspace.Interface;
	readonly collections: Collections.Interface;
	readonly hostTools: HostToolsInterface;
}>;

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'platform', tool: 'invalid-input' }))
	);

/** Reads from the already policy-filtered compiled Skill registry. */
export const readSkillBody = Effect.fn('Agents.readSkillBody')(function* (
	skills: ReadonlyArray<SkillDeclaration>,
	name: string
) {
	const decodedName = yield* Schema.decodeUnknownEffect(SkillDeclaration.fields.name)(name).pipe(
		Effect.mapError(() => new SkillError({ name, reason: 'invalid-name' }))
	);
	const skill = skills.find((candidate) => candidate.name === decodedName);
	if (skill === undefined) return yield* new SkillError({ name: decodedName, reason: 'missing' });
	return skill.body;
});

/**
 * What `describe_workspace` returns to the model: the workspace's declared surface plus what this
 * subject may actually call. The two halves are different answers — the model is told what the
 * workspace has, and what the caller is entitled to — so the response is its own shape.
 */
const DescribeWorkspaceResult = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	collections: Schema.Array(Schema.String),
	apps: Schema.Array(Schema.String),
	tools: Schema.Array(Schema.String),
	skills: Schema.Array(Schema.String),
	automations: Schema.Array(Schema.String),
	envoys: Schema.Array(Schema.String),
	integrations: Schema.Array(Schema.String)
});
type DescribeWorkspaceResult = Schema.Schema.Type<typeof DescribeWorkspaceResult>;

/**
 * The workspace's declared surface — its name, version and every group it declares, projected to
 * the names a model is told about. This is the half of `describe_workspace` every caller shares,
 * read from the definition in one place.
 */
const declaredSurface = (
	definition: WorkspaceDefinition
): Pick<
	DescribeWorkspaceResult,
	'name' | 'version' | 'collections' | 'apps' | 'automations' | 'envoys' | 'integrations'
> => ({
	name: definition.name,
	version: definition.version,
	collections: definition.collections.map((collection) => collection.name),
	apps: definition.apps.map((app) => app.name),
	automations: definition.automations.map((automation) => automation.name),
	envoys: definition.envoys.map((envoy) => envoy.name),
	integrations: definition.integrations.map((integration) => integration.name)
});

/** Executes one platform tool against workspace, collection, and skill facilities. */
export const executePlatformTool = Effect.fn('Agents.executePlatformTool')(function* (
	name: PlatformToolName,
	input: Schema.Json,
	context: ToolExecutionContext
) {
	switch (name) {
		case 'describe_workspace': {
			const definition = context.workspace.definition;
			return {
				...declaredSurface(definition),
				// What *this* subject may call, not what the workspace declares. Two people asking the
				// same web agent to describe the workspace get different answers, because they hold
				// different policies — which is the honest reading of "what can I do here".
				tools: context.toolNames,
				skills: context.skills.map(({ name: skill }) => skill)
			} satisfies DescribeWorkspaceResult;
		}
		case 'list_skills':
			return { skills: context.skills.map(({ name: skill }) => skill) };
		case 'read_skill': {
			const parsed = yield* decode(SkillNameInput, input);
			return { name: parsed.name, body: yield* readSkillBody(context.skills, parsed.name) };
		}
		case 'read_collection': {
			const parsed = yield* decode(CollectionReadInput, input);
			// No second ceiling. `src/+agent.ts` could name a `collections` allowlist that sat under the
			// policy and duplicated it, so a workspace had two places to say what an agent may reach and
			// two ways for them to disagree. `findMany` applies the subject's grants, which is the one
			// answer — a collection no policy grants returns nothing whether or not a list named it.
			return yield* context.collections.findMany(context.effectId, context.subject, {
				collection: parsed.collection,
				limit: parsed.limit ?? 50
			});
		}
		case 'write_collection': {
			const parsed = yield* decode(CollectionWriteInput, input);
			switch (parsed.operation) {
				case 'create':
					yield* context.collections.create(context.effectId, context.subject, {
						collection: parsed.collection,
						id: parsed.id,
						values: parsed.values ?? {}
					});
					break;
				case 'update':
					yield* context.collections.update(context.effectId, context.subject, {
						collection: parsed.collection,
						id: parsed.id,
						values: parsed.values ?? {}
					});
					break;
				case 'delete':
					yield* context.collections.delete(
						context.effectId,
						context.subject,
						parsed.collection,
						parsed.id
					);
					break;
				default: {
					const _exhaustive: never = parsed.operation;
					return _exhaustive;
				}
			}
			return { collection: parsed.collection, id: parsed.id, operation: parsed.operation };
		}
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
});

/** Routes a host or sandbox tool through the host-tools facility. */
export const executeHostTool = Effect.fn('Agents.executeHostTool')(function* (
	name: string,
	input: Schema.Json,
	context: ToolExecutionContext
) {
	return (yield* context.hostTools.execute(EffectId.make(`${context.effectId}:host:${name}`), {
		tool: name,
		input
	})).output;
});
