import { Clock, Effect, Schema } from 'effect';
import { and, asc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { composer, dbNow, executeBuilt } from '#lib/runtime/persistence.js';
import { EffectId, ConversationId, MessageId } from '@norbital-ai/bolt-protocol';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Agents from './agents.js';

const command = 'conversations.answer';
const messages = SYSTEM_MODEL_TABLES.conversation_message;
const conversations = SYSTEM_MODEL_TABLES.conversation;
const tasks = SYSTEM_MODEL_TABLES.bolt_task;
const authority = sql<string>`${messages.annotation}->>'executionAuthority'`;
const taskIdFor = (id: string) => `agent:${id}`;
const Candidate = Schema.Struct({ id: MessageId });
const StoredExecution = Schema.Struct({
	conversation_id: ConversationId,
	subject_id: Schema.String,
	authority: Schema.String,
	status: Schema.String
});

/** A crash after admission but before enqueue is repaired by the startup scan below. */
export const schedule = Effect.fn('AgentDriver.schedule')(function* (
	effectId: EffectId,
	messageId: MessageId
) {
	const database = yield* Database.Service;
	const result = yield* executeBuilt(
		effectId,
		database,
		composer
			.select({ id: messages.id })
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversation_id))
			.where(
				and(
					eq(messages.id, messageId),
					eq(messages.state, 'queued'),
					isNull(conversations.parent_id),
					inArray(conversations.status, ['ready', 'running']),
					isNotNull(authority)
				)
			)
	);
	if (result.rows.length === 0) return;
	yield* (yield* TaskQueue.Service).enqueueClaimed(EffectId.make(`${effectId}:enqueue`), {
		command,
		input: { messageId },
		effectId: taskIdFor(messageId),
		nowEpochMs: yield* Clock.currentTimeMillis
	});
});

/** Finds unscheduled admissions only; expired running work already belongs to TaskQueue recovery. */
export const recover = Effect.fn('AgentDriver.recover')(function* (
	effectId: EffectId,
	conversationId?: ConversationId
) {
	const database = yield* Database.Service;
	let after = '';
	while (true) {
		const result = yield* executeBuilt(
			EffectId.make(`${effectId}:scan:${after}`),
			database,
			composer
				.select({ id: messages.id })
				.from(messages)
				.innerJoin(conversations, eq(conversations.id, messages.conversation_id))
				.where(
					and(
						eq(messages.state, 'queued'),
						isNull(conversations.parent_id),
						eq(conversations.status, 'ready'),
						isNotNull(authority),
						after === '' ? undefined : gt(messages.id, after),
						conversationId === undefined ? undefined : eq(conversations.id, conversationId),
						notExists(
							composer
								.select({ id: tasks.effect_id })
								.from(tasks)
								.where(eq(tasks.effect_id, sql`'agent:' || ${messages.id}::text`))
						)
					)
				)
				.orderBy(asc(messages.id))
				.limit(100)
		);
		const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Candidate))(result.rows);
		for (const row of rows) yield* schedule(EffectId.make(`${effectId}:${row.id}`), row.id);
		if (rows.length < 100) return;
		after = rows[rows.length - 1]!.id;
	}
});

/** Only an exact live queue claim can continue a stored person's conversation. */
export function run(
	effectId: EffectId,
	tenantId: string,
	claim: Readonly<{ id: string; attempt: number }> | undefined,
	messageId: MessageId
): Effect.Effect<
	Readonly<{ status: string; conversationId?: ConversationId }>,
	| Effect.Error<ReturnType<Agents.Interface['answerQueued']>>
	| Database.FacilityError
	| Identity.AuthenticationError
	| Schema.SchemaError
	| Error,
	Database.Interface | Identity.Interface | TaskQueue.Interface | Agents.Interface
> {
	return Effect.gen(function* () {
		if (claim === undefined || claim.id !== taskIdFor(messageId))
			return yield* Effect.fail(
				new Error('A conversation continuation requires its exact durable task claim.')
			);
		const database = yield* Database.Service;
		const stored = yield* executeBuilt(
			EffectId.make(`${effectId}:claim`),
			database,
			composer
				.select({
					conversation_id: messages.conversation_id,
					subject_id: conversations.subject_id,
					status: conversations.status,
					authority: authority.as('authority')
				})
				.from(tasks)
				.innerJoin(messages, eq(messages.id, messageId))
				.innerJoin(conversations, eq(conversations.id, messages.conversation_id))
				.where(
					and(
						eq(tasks.effect_id, claim.id),
						eq(tasks.command, command),
						eq(sql<string>`${tasks.input}->>'messageId'`, messageId),
						eq(tasks.status, 'running'),
						eq(tasks.attempts, claim.attempt),
						gt(tasks.lease_expires_at, dbNow()),
						isNull(conversations.parent_id)
					)
				)
		);
		if (stored.rows[0] === undefined)
			return yield* Effect.fail(
				new Error('The conversation continuation no longer holds its task lease.')
			);
		const owner = yield* Schema.decodeUnknownEffect(StoredExecution)(stored.rows[0]);
		if (!['ready', 'running'].includes(owner.status)) return { status: owner.status };
		const agents = yield* Agents.Service;
		const identity = yield* Identity.Service;
		const subject = yield* identity
			.resolveUser(EffectId.make(`${effectId}:identity`), owner.subject_id)
			.pipe(
				Effect.filterOrFail(
					(current) =>
						current.tenantId === tenantId && Agents.executionAuthority(current) === owner.authority,
					() =>
						new Error(
							'Membership changed since this work was admitted. Send a new instruction to continue.'
						)
				),
				Effect.tapError(() =>
					agents.recordExecutionFailure(
						EffectId.make(`${effectId}:refused`),
						{ userId: owner.subject_id, tenantId, teamPath: [], policies: [] },
						owner.conversation_id,
						'The saved execution authority is no longer valid. Send a new instruction to continue.'
					)
				)
			);
		if (owner.status === 'running') {
			// A single driver owns the root and its synchronous children. After lease expiry, close the
			// interrupted children before the parent decides whether to retry their uncertain work.
			if (claim.attempt > 1) {
				const children = yield* executeBuilt(
					EffectId.make(`${effectId}:children`),
					database,
					composer
						.select({ id: conversations.id })
						.from(conversations)
						.where(
							and(
								eq(conversations.parent_id, owner.conversation_id),
								eq(conversations.status, 'running')
							)
						)
				);
				for (const child of yield* Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ id: ConversationId }))
				)(children.rows))
					yield* agents.recoverExecution(
						EffectId.make(`${effectId}:child:${child.id}`),
						subject,
						child.id,
						claim.id
					);
			}
			const recovered =
				claim.attempt > 1 &&
				(yield* agents.recoverExecution(
					EffectId.make(`${effectId}:recover`),
					subject,
					owner.conversation_id,
					claim.id
				));
			if (!recovered) {
				yield* (yield* TaskQueue.Service).defer(
					EffectId.make(`${effectId}:busy`),
					claim.id,
					claim.attempt
				);
				return { status: 'waiting' };
			}
		}
		return yield* agents.answerQueued(effectId, subject, owner.conversation_id).pipe(
			Effect.provideService(Identity.CurrentSubject, subject),
			Effect.provideService(Agents.ExecutionOwner, claim.id),
			Effect.map((result) => ({ conversationId: result.conversationId, status: result.status }))
		);
	});
}
