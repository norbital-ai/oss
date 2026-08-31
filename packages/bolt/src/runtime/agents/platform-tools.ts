import { Effect, Schema } from 'effect';
import { and, desc, eq, gt, lt, sql, type SQL } from 'drizzle-orm';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import {
	SkillDeclaration,
	type ToolDeclaration,
	type WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import type { HostToolsInterface } from '#lib/runtime/facilities/services.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { SkillError, ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
import { aliased, composer, executeBuilt } from '#lib/runtime/persistence.js';

const { chat_session: chatSession, chat_message: chatMessage } = SYSTEM_MODEL_TABLES;

const platformToolNames = [
	'describe_workspace',
	'list_skills',
	'read_skill',
	'search_envoy_history',
	'load_media',
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
		name: 'search_envoy_history',
		description:
			'Search the complete stored chat transcript by text or date, including messages queued while this task is running. Defaults to this conversation; this_envoy is available only when policy grants it. Takes a scope, never a conversation or principal id.',
		command: 'platform:search_envoy_history',
		inputSchema: {
			type: 'object',
			properties: {
				scope: { type: 'string', enum: ['this_conversation', 'this_envoy'] },
				query: { type: 'string' },
				before: { type: 'string', format: 'date-time' },
				after: { type: 'string', format: 'date-time' },
				nearestTo: { type: 'string', format: 'date-time' },
				limit: { type: 'integer', minimum: 1, maximum: 50 },
				cursor: { type: 'string' }
			},
			additionalProperties: false
		}
	},
	{
		name: 'load_media',
		description:
			'Load one image this conversation holds as a source, into the turn as bytes the model can see.',
		command: 'platform:load_media',
		inputSchema: {
			type: 'object',
			properties: { storageKey: { type: 'string', minLength: 1 } },
			required: ['storageKey'],
			additionalProperties: false
		}
	},
	{
		name: 'read_collection',
		description:
			'Read records from a collection the subject can access. Pass collection, an optional limit from 1 to 50, and the cursor returned by a previous read.',
		command: 'platform:read_collection',
		inputSchema: {
			type: 'object',
			properties: {
				collection: { type: 'string', minLength: 1 },
				limit: { type: 'integer', minimum: 1, maximum: 50 },
				cursor: { type: 'string', minLength: 1 }
			},
			required: ['collection'],
			additionalProperties: false
		}
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
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(50)
		)
	),
	cursor: Schema.optionalKey(Schema.NonEmptyString)
});
const CollectionWriteInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	operation: Schema.Literals(['create', 'update', 'delete']),
	id: Schema.NonEmptyString,
	values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
const EnvoyHistoryInput = Schema.Struct({
	scope: Schema.optionalKey(Schema.Literals(['this_conversation', 'this_envoy'])),
	query: Schema.optionalKey(Schema.String),
	before: Schema.optionalKey(Schema.NonEmptyString),
	after: Schema.optionalKey(Schema.NonEmptyString),
	nearestTo: Schema.optionalKey(Schema.NonEmptyString),
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(1),
			Schema.isLessThanOrEqualTo(50)
		)
	),
	cursor: Schema.optionalKey(Schema.NonEmptyString)
});
const EnvoyHistoryRow = Schema.Struct({
	conversation_id: Schema.String,
	created_at: Schema.String,
	role: Schema.String,
	content: Schema.Union([Schema.String, Schema.Null])
});
const decodeEnvoyHistoryRow = Schema.decodeUnknownOption(EnvoyHistoryRow);

type ToolExecutionContext = Readonly<{
	readonly effectId: EffectIdType;
	readonly subject: Identity.Subject;
	readonly agentName: string;
	readonly conversationId: string;
	readonly database: Database.Interface;
	readonly envoyWideHistory: boolean;
	/** The skills this subject's policies grant. */
	readonly skills: ReadonlyArray<SkillDeclaration>;
	/** The tools this turn was offered, so `describe_workspace` reports what is actually reachable. */
	readonly toolNames: ReadonlyArray<string>;
	/** Collections on which this subject has at least one read or write grant. */
	readonly collectionNames: ReadonlyArray<string>;
	readonly workspace: Workspace.Interface;
	readonly collections: Collections.Interface;
	readonly hostTools: HostToolsInterface;
}>;

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(() => new ToolNotAllowed({ agent: 'platform', tool: 'invalid-input' }))
	);

const instant = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
};

/**
 * A fresh collection read is prompt evidence immediately, before the older-output pruning window
 * can act on it. Keeping its encoded result below 16 KiB prevents one wide row set from adding the
 * 38–64 KiB seen in ordinary agent histories while still leaving room for several useful rows.
 */
export const READ_COLLECTION_RESULT_BYTE_LIMIT = 16 * 1024;

const serializedBytes = (value: Schema.Json): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

const defaultCollectionCursor = (row: Schema.Json | undefined): string | null =>
	row === undefined ? null : encodeCollectionCursor([{ column: 'id', direction: 'asc' }], row);

/**
 * Gives the model the largest complete row prefix whose serialized envelope fits the hard byte
 * ceiling. A cursor is cut after the last returned row, so truncation never asks the next read to
 * repeat evidence or silently skip a row. If one row alone is too large, no dishonest cursor is
 * emitted: the diagnostic says why zero complete rows could be returned.
 */
export const boundedCollectionReadResult = (
	fetchedRows: ReadonlyArray<Schema.Json>,
	requestedRows: number
): Schema.Json => {
	const pageRows = fetchedRows.slice(0, requestedRows);
	const providerHasMore = fetchedRows.length > requestedRows;
	const encodedRowBytes = pageRows.map(serializedBytes);
	const rowPrefixBytes: Array<number> = [0];
	for (const bytes of encodedRowBytes) rowPrefixBytes.push((rowPrefixBytes.at(-1) ?? 0) + bytes);

	const metadata = (returnedRows: number, originalBytes: number | null) => {
		const omittedRows = pageRows.length - returnedRows;
		const hasMore = providerHasMore || omittedRows > 0;
		const next =
			hasMore && returnedRows > 0 ? defaultCollectionCursor(pageRows[returnedRows - 1]) : null;
		return {
			truncated: omittedRows > 0,
			rowCount: {
				requested: requestedRows,
				fetched: fetchedRows.length,
				page: pageRows.length,
				returned: returnedRows,
				omitted: omittedRows
			},
			cursor: { hasMore, next },
			diagnostic:
				originalBytes === null
					? null
					: {
							code: 'read_collection_result_truncated',
							reason:
								returnedRows === 0
									? 'first-row-exceeds-serialized-byte-limit'
									: 'complete-row-prefix',
							byteLimit: READ_COLLECTION_RESULT_BYTE_LIMIT,
							originalBytes
						}
		};
	};
	const envelope = (returnedRows: number, originalBytes: number | null): Schema.Json => ({
		rows: pageRows.slice(0, returnedRows),
		...metadata(returnedRows, originalBytes)
	});
	const envelopeBytes = (returnedRows: number, originalBytes: number | null): number => {
		// Measure each row once. Re-serializing every shrinking prefix makes a pathological 50-row
		// result quadratic in its already-large payload; only the small metadata changes per candidate.
		const emptyRowsEnvelopeBytes = serializedBytes({
			rows: [],
			...metadata(returnedRows, originalBytes)
		});
		const rowsBytes =
			returnedRows === 0 ? 2 : 2 + (rowPrefixBytes[returnedRows] ?? 0) + (returnedRows - 1);
		return emptyRowsEnvelopeBytes - 2 + rowsBytes;
	};

	const originalBytes = envelopeBytes(pageRows.length, null);
	if (originalBytes <= READ_COLLECTION_RESULT_BYTE_LIMIT) return envelope(pageRows.length, null);

	for (let count = pageRows.length - 1; count >= 0; count -= 1) {
		if (envelopeBytes(count, originalBytes) <= READ_COLLECTION_RESULT_BYTE_LIMIT)
			return envelope(count, originalBytes);
	}

	// The zero-row envelope is fixed-size and therefore always fits the 16 KiB limit.
	return envelope(0, originalBytes);
};

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
				// A collection name is itself workspace information. Do not teach a narrow envoy that a
				// controller-only collection exists merely because it is present in the artifact.
				collections: context.collectionNames,
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
		case 'search_envoy_history': {
			const parsed = yield* decode(EnvoyHistoryInput, input);
			const scope = parsed.scope ?? 'this_conversation';
			if (scope === 'this_envoy' && !context.envoyWideHistory) {
				return yield* new ToolNotAllowed({ agent: context.agentName, tool: `${name}:this_envoy` });
			}
			const before = instant(parsed.before);
			const after = instant(parsed.after);
			const nearestTo = instant(parsed.nearestTo);
			if (
				(parsed.before !== undefined && before === undefined) ||
				(parsed.after !== undefined && after === undefined) ||
				(parsed.nearestTo !== undefined && nearestTo === undefined)
			) {
				return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'invalid-date-filter' });
			}
			const offset = parsed.cursor === undefined ? 0 : Number(parsed.cursor);
			if (!Number.isSafeInteger(offset) || offset < 0) {
				return yield* new ToolNotAllowed({ agent: context.agentName, tool: 'invalid-cursor' });
			}
			const conditions: Array<SQL> = [
				scope === 'this_conversation'
					? eq(chatSession.conversation_id, context.conversationId)
					: and(
							eq(chatSession.agent_name, context.agentName),
							eq(chatSession.envoy_key, context.agentName)
						)!
			];
			if (before !== undefined) conditions.push(lt(chatMessage.created_at, before));
			if (after !== undefined) conditions.push(gt(chatMessage.created_at, after));
			if (parsed.query !== undefined && parsed.query.trim().length > 0) {
				// repository-health:allow SQL1 -- PostgreSQL has no typed Drizzle operator for case-insensitive search over a JSONB transcript projection; all values remain bound parameters.
				conditions.push(sql`${chatMessage.search_text} ilike ${`%${parsed.query.trim()}%`}`);
			}
			const limit = parsed.limit ?? 20;
			let order: SQL = desc(chatMessage.created_at);
			if (nearestTo !== undefined) {
				// repository-health:allow SQL1 -- PostgreSQL timestamp distance is the ordering primitive for nearest-message search; the requested instant remains a bound parameter.
				order = sql`abs(extract(epoch from (${chatMessage.created_at} - ${nearestTo}::timestamptz)))`;
			}
			const result = yield* executeBuilt(
				context.effectId,
				context.database,
				composer
					.select({
						conversation_id: chatMessage.conversation_id,
						created_at: chatMessage.created_at,
						role: chatMessage.role,
						content: aliased(chatMessage.search_text, 'content')
					})
					.from(chatMessage)
					.innerJoin(chatSession, eq(chatSession.conversation_id, chatMessage.conversation_id))
					.where(and(...conditions))
					.orderBy(order, desc(chatMessage.sequence))
					.limit(limit)
					.offset(offset)
			);
			const messages = result.rows.flatMap((row): ReadonlyArray<Schema.Json> => {
				const decoded = decodeEnvoyHistoryRow(row);
				if (decoded._tag === 'None') return [];
				const content = decoded.value.content;
				if (content === null) return [];
				return [
					{
						conversation: decoded.value.conversation_id,
						at: decoded.value.created_at,
						role: decoded.value.role,
						content
					}
				];
			});
			return {
				scope,
				messages,
				nextCursor: result.rows.length === limit ? String(offset + result.rows.length) : null
			};
		}
		case 'read_collection': {
			const parsed = yield* decode(CollectionReadInput, input);
			// No second authorization ceiling. `src/+agent.ts` could name a `collections` allowlist that
			// sat under the policy and duplicated it, so a workspace had two places to say what an agent
			// may reach and two ways for them to disagree. `findMany` applies the subject's grants, which
			// is the one answer — a collection no policy grants returns nothing whether or not a list
			// named it.
			const limit = parsed.limit ?? 50;
			const rows = yield* context.collections.findMany(context.effectId, context.subject, {
				collection: parsed.collection,
				// One look-ahead row makes `cursor.hasMore` truthful even when the requested page is full.
				limit: limit + 1,
				after: parsed.cursor
			});
			return boundedCollectionReadResult(rows, limit);
		}
		case 'write_collection': {
			const parsed = yield* decode(CollectionWriteInput, input);
			switch (parsed.operation) {
				case 'create':
					yield* context.collections.mutate(
						context.effectId,
						context.subject,
						parsed.collection,
						[{ ...(parsed.values ?? {}), id: parsed.id }],
						false,
						0,
						{
							root: { id: parsed.id, action: 'create' }
						}
					);
					break;
				case 'update':
					yield* context.collections.mutate(
						context.effectId,
						context.subject,
						parsed.collection,
						[{ ...(parsed.values ?? {}), id: parsed.id }],
						false,
						0,
						{
							root: { id: parsed.id, action: 'update' }
						}
					);
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
			// `load_media` is intercepted by the turn ahead of this switch — it reads session media
			// through the documents service, which this module does not hold. Naming the reachable
			// case keeps the switch exhaustive without a fallback that could answer a media load.
			if (name === 'load_media')
				return new ToolNotAllowed({ agent: context.agentName, tool: name });
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
