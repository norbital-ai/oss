import { bindingsAt } from '../query/reader.ts';
import { Clock, Context, Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority } from '../contracts.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { publicEnvoys } from '../manifest.ts';
import { Agents, Manifest, Reads, Turns, type AgentCallables } from '../services.ts';
import { Conversation, isStaff, sharedConversations } from './schema.ts';
import { RateWindows, chargesFor } from '../access/rate.ts';
import { TriageService } from './triage.ts';
import { lowerRead } from '../query/engine.ts';

export class AgentBackground extends Context.Service<
	AgentBackground,
	{ readonly start: (effect: Effect.Effect<unknown, EngineError>) => Effect.Effect<void> }
>()('bolt/AgentBackground') {}

/** One query decides access and returns the conversation image. */
export const conversationFor = Effect.fn('Agents.conversationFor')(function* (
	authority: Authority,
	id: string
) {
	const db = yield* TenantDb,
		manifest = yield* Manifest;
	const member = authority.actor.kind === 'member' ? authority.actor.id : null;
	const row = yield* db.one(Conversation, {
		text: `SELECT c.id, c.title, c.owner, c.envoy, c.integration, c.thread, c.parent, c.status, c.model, c.plan, c.goals, c.run
  FROM sys_conversation c WHERE c.id = $1 AND
  ((c.integration IS NULL AND c.owner IS NOT NULL AND ($2 OR c.owner = $3)) OR
   ${sharedConversations({ member: '$3', admin: '$2', staff: '$4', envoys: '$5' })})`,
		params: [
			id,
			authority.admin,
			member,
			isStaff(authority),
			JSON.stringify(publicEnvoys(manifest))
		]
	});
	if (Option.isNone(row))
		return yield* Effect.fail(BoltError.make('notFound', 'admission', 'Not found or no access.'));
	return row.value;
});

const Conv = Schema.Struct({ conversation: Schema.String });
const Msg = Schema.Struct({ message: Schema.String });
const Post = Schema.Struct({
	conversation: Schema.String,
	text: Schema.String,
	attachments: Schema.optionalKey(Schema.Array(Schema.Json)),
	mode: Schema.optionalKey(Schema.Literals(['agent', 'plan', 'compact'])),
	now: Schema.optionalKey(Schema.Boolean),
	tz: Schema.optionalKey(Schema.String)
});
const committed = (value: Json): Json => value;

/** Acquire once in the handler's generation scope; callable runners close over all services. */
export const agentCallables = Effect.gen(function* () {
	const agents = yield* Agents,
		db = yield* TenantDb,
		manifest = yield* Manifest,
		turns = yield* Turns,
		reads = yield* Reads,
		triage = yield* TriageService;
	const windows = new RateWindows();
	const started = yield* AgentBackground;
	const context = yield* Effect.context<TenantDb | Manifest>();
	const readable = (authority: Authority, id: string) =>
		conversationFor(authority, id).pipe(Effect.provide(context));
	const own = Effect.fn('Agents.own')(function* (authority: Authority, id: string) {
		const row = yield* readable(authority, id);
		if (row.integration !== null || row.owner === null)
			return yield* Effect.fail(BoltError.make('notFound', 'admission', 'Not found or no access.'));
		return row;
	});
	const member = (authority: Authority) =>
		authority.actor.kind === 'member' &&
		(authority.actor.external ? manifest.agent.external : manifest.agent.internal) !== undefined
			? authority.actor.id
			: null;
	const message = Effect.fn('Agents.messageFor')(function* (authority: Authority, id: string) {
		const conversation = yield* db.one(
			Schema.Struct({ conversation: Schema.String }).annotate({ identifier: 'sys_message' }),
			{ text: 'SELECT conversation FROM sys_message WHERE id = $1', params: [id] }
		);
		if (Option.isNone(conversation))
			return yield* Effect.fail(BoltError.make('notFound', 'admission', 'Not found or no access.'));
		yield* own(authority, conversation.value.conversation);
		return conversation.value.conversation;
	});
	const background = <A>(effect: Effect.Effect<A, EngineError>) => started.start(effect);
	const entry = <S extends Schema.Codec<unknown, Json>>(
		input: S,
		run: (input: S['Type'], authority: Authority) => Effect.Effect<Json, EngineError>
	) => ({
		input,
		run: (value: unknown, authority: Authority) =>
			Effect.suspend(() =>
				Schema.is(Schema.toType(input))(value)
					? run(value, authority)
					: Effect.fail(BoltError.make('invalid', 'decode', 'the callable input was not decoded'))
			)
	});
	const control = (run: (id: string) => Effect.Effect<void, EngineError>) =>
		entry(
			Conv,
			Effect.fn('Agents.control')(function* (input, authority) {
				yield* own(authority, input.conversation);
				yield* run(input.conversation);
				return committed({ id: input.conversation });
			})
		);
	const table: AgentCallables = {
		'sys_conversation.start': entry(
			Schema.Struct({
				title: Schema.optionalKey(Schema.String),
				model: Schema.optionalKey(Schema.String)
			}),
			Effect.fn('Agents.startCallable')(function* (input, authority) {
				const who = member(authority);
				if (who === null)
					return yield* Effect.fail(
						BoltError.make('forbidden', 'admission', 'The assistant is not available to you here.')
					);
				return committed({ id: yield* agents.start({ owner: who, ...input }) });
			})
		),
		'sys_message.post': entry(
			Post,
			Effect.fn('Agents.postCallable')(function* (input, authority) {
				const who = member(authority),
					conv = yield* own(authority, input.conversation);
				if (who === null || conv.owner !== who)
					return yield* Effect.fail(
						BoltError.make('notFound', 'admission', 'Not found or no access.')
					);
				if (input.text.trim() === '' && (input.attachments?.length ?? 0) === 0)
					return yield* Effect.fail(
						BoltError.make('invalid', 'decode', 'a post needs text or an attachment')
					);
				const files = yield* agents.attachments(who, input.attachments ?? []);
				const limited = windows.charge(
					chargesFor(authority, ['agent'], { actor: who }),
					yield* Clock.currentTimeMillis
				);
				if (!limited.ok)
					return yield* Effect.fail(
						BoltError.make(
							'rateLimited',
							'admission',
							`Too many requests; retry in ${limited.retryAfter} s.`
						)
					);
				const team = authority.key.startsWith('preview:team:')
					? authority.key.split(':')[2]
					: undefined;
				const post = {
					conversation: input.conversation,
					as: { member: who, ...(team === undefined ? {} : { team }) },
					text: input.text,
					author: authority.actor.kind === 'member' ? (authority.actor.email ?? who) : who,
					files,
					...(input.tz === undefined ? {} : { tz: input.tz })
				};
				if (input.mode !== 'compact' && input.now !== true && triage.inApp()) {
					const row = yield* triage.post({
						...post,
						mode: input.mode === 'plan' ? 'plan' : 'agent'
					});
					return committed({ id: row.id });
				}
				yield* turns.release(input.conversation);
				const row = yield* agents.post({
					...post,
					...(input.mode === undefined ? {} : { mode: input.mode })
				});
				yield* background(agents.drain(input.conversation));
				return committed({ id: row.id });
			})
		),
		'sys_conversation.respondNow': control((id) =>
			turns.release(id).pipe(Effect.andThen(background(agents.drain(id))))
		),
		'sys_conversation.stop': control(agents.stop),
		'sys_conversation.resume': control((id) => background(agents.resume(id))),
		'sys_conversation.setModel': entry(
			Schema.Struct({ conversation: Schema.String, model: Schema.String }),
			Effect.fn('Agents.modelCallable')(function* (input, authority) {
				yield* own(authority, input.conversation);
				yield* agents.setModel(input.conversation, input.model);
				return committed({ id: input.conversation, model: input.model });
			})
		),
		'sys_conversation.setAgent': entry(
			Schema.Struct({ conversation: Schema.String, agent: Schema.String }),
			Effect.fn('Agents.agentCallable')(function* (input, authority) {
				yield* own(authority, input.conversation);
				if (!isStaff(authority))
					return yield* Effect.fail(
						BoltError.make(
							'forbidden',
							'admission',
							'Only staff switch the agent of a conversation.'
						)
					);
				yield* agents.setAgent(input.conversation, input.agent);
				return committed({ id: input.conversation, agent: input.agent });
			})
		),
		'sys_message.revise': entry(
			Schema.Struct({ message: Schema.String, text: Schema.String.check(Schema.isPattern(/\S/)) }),
			Effect.fn('Agents.reviseCallable')(function* (input, authority) {
				const conversation = yield* message(authority, input.message),
					id = yield* agents.revise(input.message, input.text, authority);
				yield* background(agents.drain(conversation));
				return committed({ id: Option.getOrNull(id) });
			})
		),
		'sys_message.dequeue': entry(
			Msg,
			Effect.fn('Agents.dequeueCallable')(function* (input, authority) {
				yield* message(authority, input.message);
				yield* agents.dequeue(input.message, authority);
				return committed({ id: input.message });
			})
		),
		'sys_message.reorder': entry(
			Schema.Struct({ conversation: Schema.String, messages: Schema.Array(Schema.String) }),
			Effect.fn('Agents.reorderCallable')(function* (input, authority) {
				yield* own(authority, input.conversation);
				yield* agents.reorder(input.conversation, input.messages, authority);
				return committed({ id: input.conversation });
			})
		),
		'sys_message.executePlan': entry(
			Conv,
			Effect.fn('Agents.executeCallable')(function* (input, authority) {
				const conv = yield* own(authority, input.conversation),
					who = member(authority);
				if (who === null || conv.owner !== who)
					return yield* Effect.fail(
						BoltError.make('notFound', 'admission', 'Not found or no access.')
					);
				yield* background(agents.executePlan(input.conversation, { member: who }));
				return committed({ id: input.conversation });
			})
		),
		'sys_message.discardPlan': control(agents.discardPlan),
		'sys_message.markRead': entry(
			Conv,
			Effect.fn('Agents.readCallable')(function* (input, authority) {
				yield* readable(authority, input.conversation);
				if (authority.actor.kind !== 'member')
					return yield* Effect.fail(
						BoltError.make('notFound', 'admission', 'Not found or no access.')
					);
				yield* agents.markRead(input.conversation, authority.actor.id);
				return committed({ id: input.conversation });
			})
		),
		'sys_message.file': entry(
			Schema.Struct({
				message: Schema.String,
				about: Schema.NullOr(Schema.Struct({ model: Schema.String, id: Schema.String }))
			}),
			Effect.fn('Agents.fileCallable')(function* (input, authority) {
				const image = yield* db.one(
					Schema.Struct({ conversation: Schema.String }).annotate({ identifier: 'sys_message' }),
					{ text: 'SELECT conversation FROM sys_message WHERE id = $1', params: [input.message] }
				);
				if (Option.isNone(image) || !isStaff(authority))
					return yield* Effect.fail(
						BoltError.make('notFound', 'admission', 'Not found or no access.')
					);
				yield* readable(authority, image.value.conversation);
				if (input.about !== null) {
					const now = yield* Clock.currentTimeMillis;
					const answer = yield* reads.run(
						[lowerRead(manifest, 'get', [input.about.model, input.about.id])],
						{ as: 'caller', authority },
						bindingsAt(now, manifest.workspace.tz)
					);
					if (answer[0] == null)
						return yield* Effect.fail(
							BoltError.make('notFound', 'admission', 'Not found or no access.')
						);
				}
				yield* agents.file(input.message, input.about);
				return committed({ id: input.message, about: input.about });
			})
		),
		'sys_message.confirm': entry(
			Schema.Struct({ message: Schema.String, approve: Schema.Boolean }),
			Effect.fn('Agents.confirmCallable')(function* (input, authority) {
				yield* message(authority, input.message);
				yield* background(agents.confirm(input.message, input.approve, authority));
				return committed({ id: input.message });
			})
		)
	};
	return table;
});
