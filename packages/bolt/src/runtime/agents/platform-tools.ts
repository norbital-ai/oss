import { Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '../../authoring/workspace-schema.js';
import { Collections } from '../collections/collections.js';
import { Files, HostTools } from '../facilities/services.js';
import type { Identity } from '../identity/identity.js';
import { Workspace } from '../workspace.js';
import { SkillError, ToolNotAllowed } from './agent-errors.js';

export const platformToolNames = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'read_collection',
	'write_collection'
] as const;
export type PlatformToolName = (typeof platformToolNames)[number];

export const platformToolSpecs: ReadonlyArray<ToolDeclaration> = [
	{
		name: 'describe_workspace',
		description: 'Describe collections, apps, agents, tools, automations, and channels.',
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

export const isPlatformTool = (name: string): name is PlatformToolName =>
	(platformToolNames as ReadonlyArray<string>).includes(name);

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

export type ToolExecutionContext = Readonly<{
	readonly effectId: EffectIdType;
	readonly subject: Identity.Subject;
	readonly agentName: string;
	/** The skills this subject's policies grant. */
	readonly skills: ReadonlyArray<string>;
	/** The tools this turn was offered, so `describe_workspace` reports what is actually reachable. */
	readonly toolNames: ReadonlyArray<string>;
	readonly workspace: Workspace.Interface;
	readonly collections: Collections.Interface;
	readonly hostTools: HostTools.Interface;
	readonly files: Files.Interface;
}>;

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'platform', tool: 'invalid-input' }))
	);

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
				name: definition.name,
				version: definition.version,
				collections: definition.collections.map((collection) => collection.name),
				apps: definition.apps.map((app) => app.name),
				// What *this* subject may call, not what the workspace declares. Two people asking the
				// same web agent to describe the workspace get different answers, because they hold
				// different policies — which is the honest reading of "what can I do here".
				tools: context.toolNames,
				skills: context.skills,
				automations: definition.automations.map((automation) => automation.name),
				envoys: definition.envoys.map((envoy) => envoy.name),
				integrations: definition.integrations.map((integration) => integration.name)
			};
		}
		case 'list_skills':
			return { skills: context.skills };
		case 'read_skill': {
			const parsed = yield* decode(SkillNameInput, input);
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.name)) {
				return yield* new SkillError({ name: parsed.name, reason: 'invalid-name' });
			}
			const response = yield* context.files.execute(context.effectId, {
				_tag: 'Read',
				key: `skills/${parsed.name}/SKILL.md`
			});
			if (response.bytes === undefined) {
				return yield* new SkillError({ name: parsed.name, reason: 'missing' });
			}
			return { name: parsed.name, body: new TextDecoder().decode(response.bytes) };
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
