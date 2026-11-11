// Connections are integration declarations; model syncs own their adapters. Checked, never executed.
import { Effect } from 'effect';
import { expectTypeOf } from '@effect/vitest';
import { instance_id, is_instance, policy, workspace } from '../../src/index.ts';
import { bind_integration, bind_model } from '../../src/declarations.ts';
import type {
	AutomationCtx,
	CalendarEvent,
	ConfigurationOf,
	ConnectionName,
	ConversationOf,
	DriverOf,
	Id,
	InputOf,
	InstanceId,
	IntegrationName,
	IntegrationOf,
	RequestOf,
	RequestResult,
	SendInput,
	StartInput,
	SyncRow,
	Where
} from '../../src/index.ts';
import type { StartableName } from '../../src/decl/access/policy.ts';
import type { IntegrationSpecOf, StoredRow } from '../../src/decl/names.ts';
import type { DatabaseResult } from '../../src/engine/integrations/database.ts';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';

expectTypeOf<IntegrationName>().toEqualTypeOf<
	| 'erp'
	| 'kingdee'
	| 'support_mail'
	| 'calendar'
	| 'chat'
	| 'whatsapp'
	| 'email'
	| 'telegram'
	| 'slack'
	| 'discord'
	| 'wechat'
>();
expectTypeOf<ConnectionName>().toEqualTypeOf<'erp' | 'ledger_main' | 'support' | 'whatsapp'>();
expectTypeOf<IntegrationOf<'ledger_main'>>().toEqualTypeOf<'kingdee'>();
expectTypeOf<IntegrationOf<InstanceId<'calendar'>>>().toEqualTypeOf<'calendar'>();
expectTypeOf<DriverOf<'kingdee'>>().toEqualTypeOf<'sqlserver'>();
expectTypeOf<ConversationOf<'support_mail'>>().toEqualTypeOf<'email'>();
expectTypeOf<ConversationOf<'erp'>>().toBeNever();
expectTypeOf<SendInput<'whatsapp'>['text']>().toEqualTypeOf<string>();
expectTypeOf<SendInput<'email'>['subject']>().toEqualTypeOf<string>();
expectTypeOf<RequestOf<'kingdee'>>().toHaveProperty('op');
expectTypeOf<RequestOf<'erp', { kind: 'int' }>>().toHaveProperty('method');
expectTypeOf<RequestResult<'kingdee'>>().toEqualTypeOf<DatabaseResult>();
expectTypeOf<RequestOf<'whatsapp'>>().toBeNever();
expectTypeOf<StoredRow<'customers'>['hotline']>().toEqualTypeOf<InstanceId<'whatsapp'> | null>();
expectTypeOf<StoredRow<'products'>['source']>().toEqualTypeOf<InstanceId<'kingdee'>>();
expectTypeOf<
	StoredRow<'notice_notes'>['integration']
>().toEqualTypeOf<Id<'sys_integration'> | null>();
expectTypeOf<InstanceId<'kingdee'>>().toExtend<Id<'sys_integration'>>();
expectTypeOf<SyncRow<'products'>['external_code']>().toEqualTypeOf<string | undefined>();
expectTypeOf<
	'products.sync.ledger' | 'notices.sync.mail' | 'entries.sync.calendar'
>().toExtend<StartableName>();
expectTypeOf<StartInput<'products.sync.ledger'>>().toEqualTypeOf<{
	readonly [key: string]: never;
}>();
expectTypeOf<ConfigurationOf<'kingdee'>>().toEqualTypeOf<{
	readonly maxLagMinutes: number;
	readonly databases: readonly string[];
}>();
expectTypeOf<ConfigurationOf<'erp'>>().toEqualTypeOf<{
	readonly baseUrl: string;
	readonly room: string;
	readonly mute: boolean | null;
	readonly topic?: string | null;
}>();
expectTypeOf<InputOf<IntegrationSpecOf<'kingdee'>['configuration']>>().toEqualTypeOf<{
	readonly maxLagMinutes?: number;
	readonly databases?: readonly string[];
}>();
const onHotline: Where<'customers'> = { hotline: { eq: { var: 'requestor.instance' } } };
const onAny: Where<'notice_notes'> = { integration: { eq: { var: 'requestor.instance' } } };
void onHotline;
void onAny;

bind_model('products')({
	...m.products.spec,
	syncs: {
		ledger: {
			with: 'kingdee',
			read: function* ({ cursor, instance }, ctx) {
				expectTypeOf(instance).toEqualTypeOf<InstanceId<'kingdee'>>();
				expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
				const { rows } = yield* ctx.request({ op: 'values', values: { n: 1 } });
				void rows;
				return {
					rows: [{ $id: 'P1', $deleted: true }],
					cursor,
					more: false,
					retained: false,
					snapshot: 'begin'
				};
			}
		}
	}
});
bind_model('entries')({
	...m.entries.spec,
	syncs: {
		calendar: {
			with: 'calendar',
			partitions: 'calendars',
			read: function* ({ items, partition }, ctx) {
				expectTypeOf(items).toEqualTypeOf<readonly CalendarEvent[]>();
				expectTypeOf(partition).toEqualTypeOf<string | null>();
				expectTypeOf(ctx.configuration.calendars).toEqualTypeOf<readonly string[]>();
				return { rows: [] };
			}
		}
	}
});
bind_model('orders')({
	description: m.orders.spec.description,
	record_label: m.orders.spec.record_label,
	fields: m.orders.spec.fields,
	outputs: { default: { fields: 'all' } },
	syncs: {
		ledger: {
			with: 'kingdee',
			write: function* ({ row, $id, $version, instance }, ctx) {
				expectTypeOf(instance).toEqualTypeOf<InstanceId<'kingdee'>>();
				expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
				yield* ctx.request({ op: 'values', values: { n: 1 } });
				return { $id: $id ?? row.number, ...($version === null ? {} : { $version }) };
			}
		}
	}
});
bind_integration('kingdee')({
	...rt.kingdee.spec,
	test: function* (ctx) {
		expectTypeOf(ctx.configuration.maxLagMinutes).toEqualTypeOf<number>();
	}
});

declare const ctx: AutomationCtx;
declare const instance: StoredRow<'sys_integration'>;
if (is_instance('whatsapp', instance))
	expectTypeOf(instance.id).toEqualTypeOf<InstanceId<'whatsapp'>>();
expectTypeOf(instance_id('kingdee', instance)).toEqualTypeOf<InstanceId<'kingdee'>>();
Effect.gen(function* () {
	expectTypeOf(yield* ctx.send('whatsapp', { to: '+6590000000', text: 'x' })).toEqualTypeOf<
		Id<'sys_message'>
	>();
	yield* ctx.send('support', { to: ['a@b.co'], subject: 'x', text: 'y' });
	yield* ctx.send(instance_id('whatsapp', instance), { to: '+6590000000', text: 'x' });
	expectTypeOf(
		yield* ctx.request('erp', { method: 'GET', path: 'n', output: { kind: 'int' } })
	).toEqualTypeOf<number>();
	expectTypeOf(
		yield* ctx.request('ledger_main', { op: 'values', values: { n: 1 } })
	).toEqualTypeOf<DatabaseResult>();
	// @ts-expect-error email payloads require subject and recipient lists
	yield* ctx.send('support', { to: '+6590000000', text: 'x' });
	// @ts-expect-error an ERP connection carries no conversation
	yield* ctx.send('erp', { to: '+6590000000', text: 'x' });
	// @ts-expect-error database requests do not accept HTTP operations
	yield* ctx.request('ledger_main', { method: 'GET', path: 'x', output: { kind: 'json' } });
	// @ts-expect-error a conversation driver has no HTTP requester
	yield* ctx.request('whatsapp', { method: 'GET', path: 'x', output: { kind: 'json' } });
});

// @ts-expect-error no declaration has this integration name
workspace({ tz: 'UTC', locale: 'en', connections: { mail: { integration: 'emial' } } });
bind_integration('support_mail')({
	description: 'x',
	driver: 'email',
	// @ts-expect-error conversation credentials belong to the provider
	credential: { password: { kind: 'text' } }
});
// @ts-expect-error an HTTP base URL is https or a text configuration field
bind_integration('erp')({ description: 'x', driver: 'http', http: { baseUrl: 'ftp://erp' } });
bind_integration('erp')({
	description: 'x',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	// @ts-expect-error bearer auth names a credential field
	http: { baseUrl: 'https://erp', auth: { bearer: 'tokn' } }
});
// @ts-expect-error drivers are enumerated
bind_integration('erp')({ description: 'x', driver: 'ftp' });
// @ts-expect-error the declaration name must be known
bind_integration('erpp')({ description: 'x', driver: 'http' });
bind_integration('erp')({
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
bind_integration('kingdee')({
	description: 'x',
	driver: 'sqlserver',
	// @ts-expect-error a database driver offers no OAuth grant
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
bind_integration('erp')({
	description: 'x',
	driver: 'http',
	http: { baseUrl: 'https://erp' },
	// @ts-expect-error an HTTP OAuth grant needs its endpoints
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
bind_integration('calendar')({
	description: 'x',
	driver: 'calendar',
	// @ts-expect-error OAuth credentials name secrets
	oauth: { client: 'calendar-client', secret: 'CALENDAR_SECRET' }
});
bind_integration('erp')({
	description: 'x',
	driver: 'http',
	credential: { s: { kind: 'text' } },
	http: { baseUrl: 'https://chat' },
	// @ts-expect-error webhook schemes are enumerated
	webhook: { verify: { scheme: 'google-calendar', secret: 's' } }
});
bind_model('orders')({
	...m.orders.spec,
	fields: {
		...m.orders.spec.fields,
		audit: {
			kind: 'ref',
			to: 'sys_integration',
			optional: true,
			// @ts-expect-error an instance reference names a definition
			where: { integration: { eq: 'kingde' } }
		}
	}
});
// @ts-expect-error instance operands require an integration reference
const onText: Where<'orders'> = { note: { eq: { var: 'requestor.instance' } } };
void onText;
policy({
	description: 'x',
	grants: {
		// @ts-expect-error a customer reference is not an integration reference
		orders: { outputs: { default: { where: { customer: { eq: { var: 'requestor.instance' } } } } } }
	}
});
// @ts-expect-error only declared sync reads are startable
policy({ description: 'x', grants: {}, capabilities: { automations: ['products.sync.stock'] } });
