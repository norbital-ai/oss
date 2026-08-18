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
	readonly skills: ReadonlyArray<string>;
	readonly workspace: Workspace.Interface;
	readonly collections: Collections.Interface;
	readonly hostTools: HostTools.Interface;
	readonly files: Files.Interface;
	/**
	 * The collections `src/+agent.ts` put in reach, when it named any.
	 *
	 * A second ceiling under the policy, not a replacement for one: the subject's grants still decide
	 * what a read returns. This is the author saying which part of their own workspace this agent is
	 * for, and it was declared and discarded — a workspace scoped to one collection had an agent that
	 * could read and write every one of them.
	 */
	readonly allowedCollections?: ReadonlyArray<string>;
}>;

/** Refuses a collection the agent was not scoped to, naming the tool rather than the collection. */
const requireCollection = (context: ToolExecutionContext, tool: string, collection: string) =>
	context.allowedCollections === undefined || context.allowedCollections.includes(collection)
		? Effect.void
		: Effect.fail(new ToolNotAllowed({ agent: context.agentName, tool }));

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
				agents: definition.agents.map((agent) => ({
					name: agent.name,
					tools: agent.tools.map((tool) => tool.name),
					skills: agent.skills
				})),
				automations: definition.automations.map((automation) => automation.name),
				channels: definition.channels.map((channel) => channel.name),
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
			yield* requireCollection(context, name, parsed.collection);
			return yield* context.collections.findMany(context.effectId, context.subject, {
				collection: parsed.collection,
				limit: parsed.limit ?? 50
			});
		}
		case 'write_collection': {
			const parsed = yield* decode(CollectionWriteInput, input);
			yield* requireCollection(context, name, parsed.collection);
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
