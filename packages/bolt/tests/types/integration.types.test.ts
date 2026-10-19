import { Effect } from 'effect';
// Type corpus for integrations, connections, instances and envoys. Each `@ts-expect-error` line is a planted mistake
// `bolt check` (tsc) refuses; the `expectTypeOf` lines are what the generated names derive. Never run, only checked.
import { expectTypeOf } from '@effect/vitest';
import {
	automation,
	collection,
	envoy,
	integration,
	policy,
	relationship,
	workspace
} from '../../src/index.ts';
import type {
	CalendarEvent,
	Check,
	ConfigurationOf,
	ConnectionName,
	ConversationOf,
	DriverOf,
	EnvoyName,
	FeedRow,
	Id,
	InputOf,
	InstanceId,
	IntegrationName,
	IntegrationOf,
	MessageItem,
	RequestOf,
	RequestResult,
	SendInput,
	Where
} from '../../src/index.ts';
import type { StartableName } from '../../src/decl/access/policy.ts';
import type { IntegrationSpecOf, StoredRow } from '../../src/decl/names.ts';
import type { DatabaseResult } from '../../src/engine/integrations/database.ts';
import type { ConnectionErrors } from '../../src/decl/verify.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

// ── what the names derive ──
expectTypeOf<IntegrationName>().toEqualTypeOf<
	| 'erp'
	| 'kingdee'
	| 'support_mail'
	| 'company_chat'
	| 'calendar'
	| 'whatsapp'
	| 'email'
	| 'telegram'
	| 'slack'
	| 'discord'
	| 'wechat'
>();
expectTypeOf<ConnectionName>().toEqualTypeOf<
	'erp' | 'ledger_main' | 'support' | 'whatsapp' | 'chat'
>();
expectTypeOf<EnvoyName>().toEqualTypeOf<'desk'>();
expectTypeOf<IntegrationOf<'ledger_main'>>().toEqualTypeOf<'kingdee'>();
expectTypeOf<IntegrationOf<InstanceId<'calendar'>>>().toEqualTypeOf<'calendar'>();
expectTypeOf<DriverOf<'kingdee'>>().toEqualTypeOf<'sqlserver'>();
expectTypeOf<ConversationOf<'support_mail'>>().toEqualTypeOf<'email'>();
expectTypeOf<ConversationOf<'company_chat'>>().toEqualTypeOf<'chat'>();
expectTypeOf<ConversationOf<'erp'>>().toBeNever();
expectTypeOf<SendInput<'whatsapp'>['text']>().toEqualTypeOf<string>();
expectTypeOf<SendInput<'email'>['subject']>().toEqualTypeOf<string>();
expectTypeOf<RequestOf<'kingdee'>>().toHaveProperty('statement');
expectTypeOf<RequestOf<'erp', { kind: 'int' }>>().toHaveProperty('method');
expectTypeOf<RequestResult<'kingdee'>>().toEqualTypeOf<DatabaseResult>();
expectTypeOf<RequestOf<'whatsapp'>>().toBeNever();
// an FK pinned to a definition holds its instances; an unpinned one any instance
expectTypeOf<StoredRow<'customers'>['hotline']>().toEqualTypeOf<InstanceId<'whatsapp'> | null>();
expectTypeOf<StoredRow<'products'>['source']>().toEqualTypeOf<InstanceId<'kingdee'>>();
expectTypeOf<
	StoredRow<'notice_notes'>['integration']
>().toEqualTypeOf<Id<'sys_integration'> | null>();
expectTypeOf<InstanceId<'kingdee'>>().toExtend<Id<'sys_integration'>>();
// a feed row: the feed fields, less the instance FK (stamped) and the local fields (the collection's update columns)
expectTypeOf<keyof FeedRow<'products'>>().toEqualTypeOf<
	'external_code' | 'name' | 'active' | 'price'
>();
expectTypeOf<FeedRow<'products'>['external_code']>().toEqualTypeOf<string>();
expectTypeOf<keyof FeedRow<'entries'>>().toEqualTypeOf<
	'calendar_id' | 'external_id' | 'subject' | 'event_status'
>();
// feed runs are startable; their input is nothing
expectTypeOf<
	'kingdee.products' | 'support_mail.notices' | 'calendar.entries'
>().toExtend<StartableName>();
// the instance an envoy turn or a feed run is for, on an instance FK (pinned or not)
const onHotline: Where<'customers'> = { hotline: { eq: { actor: 'instance' } } };
const onAny: Where<'notice_notes'> = { integration: { eq: { actor: 'instance' } } };
void onHotline;
void onAny;
// a conversation connection deploying an envoy is fine
expectTypeOf<
	Check<ConnectionErrors<{ w: { integration: 'whatsapp'; envoy: 'desk' } }>>
>().toEqualTypeOf<true>();
// an instance's configuration as stored: every defaulted field present (decoding fills it), an optional one without a
// default absent or null
expectTypeOf<ConfigurationOf<'kingdee'>>().toEqualTypeOf<{
	readonly maxLagMinutes: number;
	readonly databases: readonly string[];
}>();
expectTypeOf<ConfigurationOf<'company_chat'>>().toEqualTypeOf<{
	readonly baseUrl: string;
	readonly room: string;
	readonly mute: boolean | null;
	readonly topic?: string | null;
}>();
// the input that creates or updates one may still omit a defaulted field
expectTypeOf<InputOf<IntegrationSpecOf<'kingdee'>['configuration']>>().toEqualTypeOf<{
	readonly maxLagMinutes?: number;
	readonly databases?: readonly string[];
}>();

// ── bodies, typed from the literal ──
rt.kingdee.feed('products', {
	read: function* (cursor, ctx) {
		expectTypeOf(ctx.instance).toEqualTypeOf<InstanceId<'kingdee'>>();
		expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
		expectTypeOf(ctx.configuration.databases).toEqualTypeOf<readonly string[]>();
		const { rows } = yield* ctx.request({ statement: 'SELECT 1', parameters: {} });
		void rows;
		return {
			changes: [{ delete: { external_code: 'P1' } }],
			cursor,
			more: false,
			retained: false,
			snapshot: 'begin'
		};
	}
});
rt.support_mail.feed('notices', {
	map: function* (mails) {
		expectTypeOf(mails).toEqualTypeOf<readonly MessageItem<'email'>[]>();
		// one attachment shape: the stored file's (`id` only when stored)
		expectTypeOf<MessageItem<'email'>['attachments'][number]>().toEqualTypeOf<{
			readonly id?: Id<'sys_file'>;
			readonly name: string;
			readonly mime: string;
			readonly bytes: number;
		}>();
		return [];
	}
});
rt.calendar.feed('entries', {
	map: function* (events, ctx) {
		expectTypeOf(events).toEqualTypeOf<readonly CalendarEvent[]>();
		expectTypeOf(ctx.partition).toEqualTypeOf<string | null>();
		expectTypeOf(ctx.configuration.calendars).toEqualTypeOf<readonly string[]>();
		return [];
	}
});
rt.kingdee.outbound('orders', {
	build: (order) => ({ number: order.number }),
	run: function* (payload, ctx) {
		expectTypeOf(payload).toEqualTypeOf<{ readonly number: string }>();
		expectTypeOf(ctx.key).toEqualTypeOf<string>();
		expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
		return { id: payload.number };
	}
});
rt.kingdee.test(function* (ctx) {
	expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
});
rt.company_chat.receive(function* ({ configuration }) {
	expectTypeOf(configuration.room).toEqualTypeOf<string>();
	expectTypeOf(configuration.mute).toEqualTypeOf<boolean | null>();
	expectTypeOf(configuration.topic).toEqualTypeOf<string | null | undefined>();
	// @ts-expect-error IN48 an optional field without a default may be absent from a stored configuration
	const topic: string | null = configuration.topic;
	void topic;
	return { messages: [] };
});
rt.company_chat.send(function* (_, ctx) {
	expectTypeOf(ctx.configuration.baseUrl).toEqualTypeOf<string>();
	expectTypeOf(ctx.configuration.room).toEqualTypeOf<string>();
	return { id: ctx.key };
});
// @ts-expect-error IN49 a stored configuration always holds its defaulted fields
const undefaulted: ConfigurationOf<'kingdee'> = { databases: [] };
// @ts-expect-error IN50 and a field with neither a default nor optional: true
const unset: ConfigurationOf<'company_chat'> = { room: 'general', mute: false };
void undefaulted;
void unset;
rt.support_mail.outbound('confirmations', {
	build: (order) =>
		order.note === null ? null : { to: ['a@b.co'], subject: 'x', text: order.note },
	events: {
		replied: ({ reply }) => {
			expectTypeOf(reply.subject).toEqualTypeOf<string>();
			return {};
		}
	}
});
const notify = automation({ description: 'x', runAs: ['sales_rep'] });
notify.run(function* (_, ctx) {
	expectTypeOf(yield* ctx.send('whatsapp', { to: '+6590000000', text: 'x' })).toEqualTypeOf<
		Id<'sys_message'>
	>();
	yield* ctx.send('support', { to: ['a@b.co'], subject: 'x', text: 'y' });
	const hotline = '' as InstanceId<'whatsapp'>;
	yield* ctx.send(hotline, { to: '+6590000000', text: 'x' });
	expectTypeOf(
		yield* ctx.request('erp', { method: 'GET', path: 'n', output: { kind: 'int' } })
	).toEqualTypeOf<number>();
	expectTypeOf(
		yield* ctx.request('ledger_main', { statement: 'SELECT 1', parameters: {} })
	).toEqualTypeOf<DatabaseResult>();
	const routes = yield* ctx
		.request('erp', { method: 'POST', path: 'route', body: {}, output: { kind: 'json' } })
		.pipe(Effect.catchTags({ FacilityFailure: Effect.succeed, Unavailable: Effect.succeed }));
	if (
		typeof routes === 'object' &&
		routes !== null &&
		'kind' in routes &&
		routes.kind === 'unavailable'
	)
		return;

	// ── the planted mistakes: sends and requests ──
	// @ts-expect-error IN1 a chat payload for an email connection
	yield* ctx.send('support', { to: '+6590000000', text: 'x' });
	// @ts-expect-error IN2 a send through a connection that carries no conversation
	yield* ctx.send('erp', { to: '+6590000000', text: 'x' });
	// @ts-expect-error IN3 an http op on a sqlserver instance
	yield* ctx.request('ledger_main', { method: 'GET', path: 'x', output: { kind: 'json' } });
	// @ts-expect-error IN4 a request through a conversation instance
	yield* ctx.request('whatsapp', { method: 'GET', path: 'x', output: { kind: 'json' } });
	// @ts-expect-error IN5 an instance of another definition's kind of payload
	yield* ctx.send('' as InstanceId<'support_mail'>, { to: '+6590000000', text: 'x' });
});

// ── the planted mistakes: literals ──
// @ts-expect-error IN6 envoy on a connection that carries no conversation (`__verify`)
const noConversation: Check<ConnectionErrors<{ desk: { integration: 'erp'; envoy: 'desk' } }>> =
	true;
void noConversation;
// @ts-expect-error IN7 an unknown integration name
workspace({ tz: 'UTC', locale: 'en', connections: { mail: { integration: 'emial' } } });
workspace({
	tz: 'UTC',
	locale: 'en',
	// @ts-expect-error IN8 an unknown envoy on a connection
	connections: { wa: { integration: 'whatsapp', envoy: 'dsk' } }
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN9 an unknown collection in a feed's into
	feeds: { p: { into: 'prodcts', key: [], cron: '@hourly' } }
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN10 a key field the target lacks
	feeds: { p: { into: 'products', key: ['code'], cron: '@hourly' } }
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN11 a pulled feed without its cron
	feeds: { p: { into: 'products', key: ['external_code'] } }
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN12 a cron with four fields
	feeds: { p: { into: 'products', key: ['external_code'], cron: '0 2 * *' } }
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN13 a message feed on a definition with no conversation
	feeds: { p: { into: 'products', key: ['external_code'], from: 'messages' } }
});
const invalidPartitionFeed = {
	description: 'x',
	driver: 'calendar',
	configuration: { region: { kind: 'text' } },
	feeds: {
		e: {
			into: 'entries',
			from: 'driver',
			key: ['calendar_id', 'external_id'],
			partitions: 'region'
		}
	}
} as const;
// @ts-expect-error IN14 feed partitions naming a field that is not text-many
integration('calendar', invalidPartitionFeed);
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	feeds: {
		p: {
			into: 'products',
			key: ['external_code'],
			cron: '@hourly',
			// @ts-expect-error IN15 a removed patch of a local field
			removed: { commission_factor: 0 }
		}
	}
});
integration('support_mail', {
	description: 'x',
	driver: 'email',
	// @ts-expect-error IN16 an outbound via another definition's connection
	outbound: { o: { from: 'orders', via: 'ledger_main' } }
});
integration('support_mail', {
	description: 'x',
	driver: 'email',
	// @ts-expect-error IN17 an outbound via an FK pinned to another definition
	outbound: { o: { from: 'orders', via: 'ledger' } }
});
integration('support_mail', {
	description: 'x',
	driver: 'email',
	// @ts-expect-error IN18 a credential on a conversation driver
	credential: { password: { kind: 'text' } }
});
// @ts-expect-error IN19 a base URL that is neither https nor a text configuration field
integration('erp', { description: 'x', driver: 'http', http: { baseUrl: 'ftp://erp' } });
integration('erp', {
	description: 'x',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	// @ts-expect-error IN20 bearer auth naming no credential field
	http: { baseUrl: 'https://erp', auth: { bearer: 'tokn' } }
});
integration('company_chat', {
	description: 'x',
	driver: 'http',
	// @ts-expect-error IN21 a custom conversation without its webhook
	conversation: { kind: 'chat', handle: 'phone' }
});
// @ts-expect-error IN22 an unknown driver
integration('erp', { description: 'x', driver: 'ftp' });
// @ts-expect-error IN23 a definition name no folder declares
integration('erpp', { description: 'x', driver: 'http' });
// one place declares OAuth, for every driver that grants: the definition's `oauth`
integration('erp', {
	description: 'x',
	driver: 'http',
	http: { baseUrl: 'https://erp' },
	oauth: {
		client: 'CALENDAR_CLIENT',
		secret: 'CALENDAR_SECRET',
		authorize: 'https://idp/authorize',
		token: 'https://idp/token'
	}
});
integration('kingdee', {
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error IN42 oauth on a driver that runs no grant
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
integration('erp', {
	description: 'x',
	driver: 'http',
	http: { baseUrl: 'https://erp' },
	// @ts-expect-error IN43 an http grant without its endpoints
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
integration('erp', {
	description: 'x',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	// @ts-expect-error IN44 http auth beside an oauth grant
	http: { baseUrl: 'https://erp', auth: { bearer: 'token' } },
	oauth: {
		client: 'CALENDAR_CLIENT',
		secret: 'CALENDAR_SECRET',
		authorize: 'https://idp/authorize',
		token: 'https://idp/token'
	}
});
integration('erp', {
	description: 'x',
	driver: 'http',
	http: {
		baseUrl: 'https://erp',
		auth: {
			// @ts-expect-error IN45 oauth under http.auth (it is the definition's)
			oauth: {
				client: 'CALENDAR_CLIENT',
				secret: 'CALENDAR_SECRET',
				authorize: 'https://idp/authorize',
				token: 'https://idp/token'
			}
		}
	}
});
integration('calendar', {
	description: 'x',
	driver: 'calendar',
	// @ts-expect-error IN46 an OAuth client that is no secret name
	oauth: { client: 'calendar-client', secret: 'CALENDAR_SECRET' }
});
integration('company_chat', {
	description: 'x',
	driver: 'http',
	credential: { s: { kind: 'text' } },
	http: { baseUrl: 'https://chat' },
	// @ts-expect-error IN47 a webhook scheme bolt does not verify
	webhook: { scheme: 'google-calendar', secret: 's' },
	conversation: { kind: 'chat', handle: 'phone' }
});
// @ts-expect-error IN24 a body for an undeclared feed
rt.kingdee.feed('prodcts', {
	read: function* (cursor) {
		return { changes: [], cursor, more: false };
	}
});
rt.kingdee.feed('products', {
	// @ts-expect-error IN25 a local field in a feed row
	read: function* (cursor) {
		return {
			changes: [{ upsert: { external_code: 'P1', name: 'x', commission_factor: '1.2' } }],
			cursor,
			more: false
		};
	}
});
rt.calendar.feed('entries', {
	// @ts-expect-error IN25b a local field in a mapped row, through an array's map
	map: function* (events) {
		return events.map((e) => ({
			upsert: {
				calendar_id: 'c',
				external_id: e.id,
				subject: 'x',
				event_status: e.status,
				filed: true
			}
		}));
	}
});
rt.kingdee.feed('products', {
	// @ts-expect-error IN26 a map body on a pulled feed
	map: function* () {
		return [];
	}
});
// @ts-expect-error IN27 a command rule without its run
rt.kingdee.outbound('orders', { build: (order) => ({ n: order.number }) });
rt.support_mail.outbound('confirmations', {
	// @ts-expect-error IN28 a mail without its subject
	build: () => ({ to: ['a@b.co'] })
});
// @ts-expect-error IN29 receive on a definition with no custom conversation
rt.erp.receive(function* () {
	return { messages: [] };
});
// @ts-expect-error IN30 a create grant on a feed target
policy({ description: 'x', grants: { products: { create: true } } });
// @ts-expect-error IN31 a delete grant on a feed target
policy({ description: 'x', grants: { products: { delete: true } } });
policy({
	description: 'x',
	grants: { products: { read: true, update: { fields: ['commission_factor'] } } }
});
// @ts-expect-error IN32 create on a feed target's collection
collection('products', { read: { fields: 'all' }, create: { input: { columns: ['name'] } } });
relationship({
	'orders.audit': {
		to: 'sys_integration',
		optional: true,
		// @ts-expect-error IN33 a misspelt definition in a relationship's where
		where: { integration: { eq: 'kingde' } }
	}
});
relationship({
	// @ts-expect-error IN34 an instance FK pinned by anything but its definition
	'orders.audit': { to: 'sys_integration', optional: true, where: { name: { eq: 'x' } } }
});
// @ts-expect-error IN35 { actor: 'instance' } on a field that is no FK to sys_integration
const onText: Where<'orders'> = { note: { eq: { actor: 'instance' } } };
void onText;
policy({
	description: 'x',
	// @ts-expect-error IN36 { actor: 'instance' } on an FK to another collection
	grants: { orders: { read: { customer: { eq: { actor: 'instance' } } } } }
});
envoy({
	name: 'x',
	audience: 'private',
	// @ts-expect-error IN37 an unknown policy in an envoy
	policies: ['sales_rap'],
	delegation: 'disabled',
	task: 'x'
});
// @ts-expect-error IN38 an envoy without policies
envoy({ name: 'x', audience: 'private', policies: [], delegation: 'disabled', task: 'x' });
envoy({
	name: 'x',
	audience: 'public',
	policies: ['sales_rep'],
	delegation: 'enabled',
	// @ts-expect-error IN39 an unknown DM authority
	dm: 'member',
	task: 'x'
});
envoy({
	name: 'x',
	// @ts-expect-error IN40 an audience envoys do not have
	audience: 'members',
	policies: ['sales_rep'],
	delegation: 'disabled',
	task: 'x'
});
envoy({
	name: 'x',
	audience: 'public',
	policies: ['sales_rep'],
	delegation: 'enabled',
	dm: 'envoy',
	triage: { scope: 'group' },
	task: 'x'
});
// @ts-expect-error IN41 a feed run that is not declared
policy({ description: 'x', grants: {}, automations: ['kingdee.stock'] });
