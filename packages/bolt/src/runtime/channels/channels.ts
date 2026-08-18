import { Context, Effect, Layer, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { Agents } from '../agents/agents.js';
import { AccessControl } from '../access/access-control.js';
import { ApprovalConflict } from '../approvals/approvals.js';
import { PendingApproval } from '../collections/collections.js';
import type { WhereCompileError } from '../collections/where.js';
import { Communication } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import type { Identity } from '../identity/identity.js';
import { Workspace } from '../workspace.js';

/** Carries channel error through the typed channels failure channel without losing diagnostic context. */
export class ChannelError extends Schema.TaggedError<ChannelError>()(
	'Bolt.Channels.Error',
	{
		channel: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'channel' as const;
	readonly retryable = false;
}
export const ChannelStatus = Schema.Struct({ channel: Schema.NonEmptyString, registered: Schema.Boolean, received: Schema.Number, replied: Schema.Number });
export interface ChannelStatus extends Schema.Schema.Type<typeof ChannelStatus> {}
export type Interface = Readonly<{
	readonly register: (effectId: EffectId, channelName: string) => Effect.Effect<void, ChannelError | Database.FacilityError>;
	/** Runs an agent turn, so it inherits every way that turn can fail, including a refused filter. */
	readonly receive: (effectId: EffectId, subject: Identity.Subject, channelName: string, conversationId: string, message: string) => Effect.Effect<Agents.TurnResult, ChannelError | Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError | Agents.SkillError | Agents.ToolNotAllowed | ApprovalConflict | PendingApproval | WhereCompileError>;
	readonly reply: (effectId: EffectId, channelName: string, recipient: string, payload: Schema.Json) => Effect.Effect<void, ChannelError | Database.FacilityError | Database.FacilityError>;
	readonly status: (effectId: EffectId, channelName: string) => Effect.Effect<ChannelStatus, ChannelError | Database.FacilityError>;
}>;
/** Identifies the channels service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Channels');
export const layer = Layer.effect(Service, Effect.gen(function* () {
	const workspace = yield* Workspace.Service;
	const agents = yield* Agents.Service;
	const communication = yield* Communication.Service;
	const database = yield* Database.Service;
	/** Owns declaration behavior at the channels boundary so validation and typed semantics stay consistent for every caller. */
	const declarations = { find: (channelName: string) => workspace.definition.channels.find(({ name }) => name === channelName) };
	const requireChannel = Effect.fn('Channels.requireChannel')(function* (channelName: string) {
		const channel = declarations.find(channelName);
		if (channel === undefined) return yield* new ChannelError({ channel: channelName, message: 'Unknown channel' });
		return channel;
	});
	return Service.of({
		register: Effect.fn('Channels.register')(function* (effectId, channelName) {
			yield* requireChannel(channelName);
			yield* database.execute(effectId, { _tag: 'Query', sql: 'insert into bolt_channel_registrations (channel_name) values ($1) on conflict do nothing', parameters: [channelName] });
		}),
		receive: Effect.fn('Channels.receive')(function* (effectId, subject, channelName, conversationId, message) {
			const channel = yield* requireChannel(channelName);
			const result = yield* agents.turn(effectId, subject, channel.agent, conversationId, message);
			yield* database.execute(effectId, { _tag: 'Query', sql: 'insert into bolt_channel_receipts (channel_name, conversation_id, direction) values ($1, $2, $3)', parameters: [channelName, conversationId, 'inbound'] });
			yield* communication.execute(effectId, { _tag: 'Send', channel: channel.transport, recipient: subject.userId, payload: result.output });
			return result;
		}),
		reply: Effect.fn('Channels.reply')(function* (effectId, channelName, recipient, payload) {
			const channel = yield* requireChannel(channelName);
			yield* communication.execute(effectId, { _tag: 'Send', channel: channel.transport, recipient, payload });
			yield* database.execute(effectId, { _tag: 'Query', sql: 'insert into bolt_channel_receipts (channel_name, conversation_id, direction) values ($1, $2, $3)', parameters: [channelName, recipient, 'outbound'] });
		}),
		status: Effect.fn('Channels.status')(function* (effectId, channelName) {
			yield* requireChannel(channelName);
			const result = yield* database.execute(effectId, { _tag: 'Query', sql: 'select exists(select 1 from bolt_channel_registrations where channel_name = $1) as registered, count(*) filter (where direction = \'inbound\') as received, count(*) filter (where direction = \'outbound\') as replied from bolt_channel_receipts where channel_name = $1', parameters: [channelName] });
			const row = result.rows[0] ?? {};
			const registered = typeof row === 'object' && row !== null && Reflect.get(row, 'registered') === true;
			const received = typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'received') ?? 0) : 0;
			const replied = typeof row === 'object' && row !== null ? Number(Reflect.get(row, 'replied') ?? 0) : 0;
			return { channel: channelName, registered, received, replied };
		})
	});
}));
export * as Channels from './channels.js';
