// Connections are integration declarations; model syncs own their adapters. Checked, never executed.
import { Effect } from 'effect';
import { expectTypeOf } from '@effect/vitest';
import { instance_id, integration, is_instance, model, policy, sync, workspace } from '../../src/index.ts';
import type { IntegrationName } from '../../src/decl/names.ts';
import type { AutomationCtx, Id, InputOf, InstanceId, StartInput, SyncRow, Where } from '../../src/index.ts';
import type { CalendarEvent } from '../../src/decl/runtime/integration.ts';
import type { SyncKey } from '../../src/decl/names.ts';
import type { IntegrationSpecOf, StoredRow } from '../../src/decl/names.ts';
import type { DatabaseResult } from '@norbital-ai/host-api';
import * as m from './fixture/models.ts';
import * as rt from './fixture/runtime.ts';
import './registry.ts';
import type {
	ConfigurationOf,
	ConversationOf,
	DriverOf,
	RequestOf,
	RequestResult,
	SendInput
} from '../../src/decl/runtime/integration.ts';
import type { IntegrationOf } from '../../src/decl/runtime/names.ts';

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
// a definition name is no instance
expectTypeOf<IntegrationOf<'kingdee'>>().toBeNever();
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
	'products.ledger' | 'notices.mail' | 'entries.calendar'
>().toExtend<SyncKey>();
expectTypeOf<StartInput<'products.sync.ledger'>>().toBeNever();
expectTypeOf<ConfigurationOf<'kingdee'>>().toEqualTypeOf<{
	readonly max_lag_minutes: number;
	readonly databases: readonly string[];
}>();
expectTypeOf<ConfigurationOf<'erp'>>().toEqualTypeOf<{
	readonly base_url: string;
	readonly room: string;
	readonly mute: boolean | null;
	readonly topic?: string | null;
}>();
expectTypeOf<InputOf<IntegrationSpecOf<'kingdee'>['configuration']>>().toEqualTypeOf<{
	readonly max_lag_minutes?: number;
	readonly databases?: readonly string[];
}>();
const onHotline: Where<'customers'> = { hotline: { eq: { var: 'actor.instance' } } };
const onAny: Where<'notice_notes'> = { integration: { eq: { var: 'actor.instance' } } };
void onHotline;
void onAny;

sync('products', 'ledger', {
	with: 'kingdee',
	read: function* ({ cursor, instance }, ctx) {
		expectTypeOf(instance).toEqualTypeOf<InstanceId<'kingdee'>>();
		expectTypeOf(ctx.configuration.max_lag_minutes).toEqualTypeOf<number>();
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
});
sync('entries', 'calendar', {
	with: 'calendar',
	partitions: 'calendars',
	read: function* ({ items, partition }, ctx) {
		expectTypeOf(items).toEqualTypeOf<readonly CalendarEvent[]>();
		expectTypeOf(partition).toEqualTypeOf<string | null>();
		expectTypeOf(ctx.configuration.calendars).toEqualTypeOf<readonly string[]>();
		return { rows: [] };
	}
});
sync('orders', 'ledger', {
	with: 'kingdee',
	write: function* ({ row, $id, $version, instance }, ctx) {
		expectTypeOf(instance).toEqualTypeOf<InstanceId<'kingdee'>>();
		expectTypeOf(ctx.configuration.max_lag_minutes).toEqualTypeOf<number>();
		yield* ctx.request({ op: 'values', values: { n: 1 } });
		return { $id: $id ?? row.number, ...($version === null ? {} : { $version }) };
	}
});
integration('kingdee', {
	...rt.kingdee.spec,
	test: function* (ctx) {
		expectTypeOf(ctx.configuration.max_lag_minutes).toEqualTypeOf<number>();
	}
});

declare const ctx: AutomationCtx;
declare const whatsapp: InstanceId<'whatsapp'>;
declare const support_mail: InstanceId<'support_mail'>;
declare const erp: InstanceId<'erp'>;
declare const kingdee: InstanceId<'kingdee'>;
declare const instance: StoredRow<'sys_integration'>;
if (is_instance('whatsapp', instance))
	expectTypeOf(instance.id).toEqualTypeOf<InstanceId<'whatsapp'>>();
expectTypeOf(instance_id('kingdee', instance)).toEqualTypeOf<InstanceId<'kingdee'>>();
Effect.gen(function* () {
	expectTypeOf(yield* ctx.send(whatsapp, { to: '+6590000000', text: 'x' })).toEqualTypeOf<
		Id<'sys_message'>
	>();
	yield* ctx.send(support_mail, { to: ['a@b.co'], subject: 'x', text: 'y' });
	yield* ctx.send(instance_id('whatsapp', instance), { to: '+6590000000', text: 'x' });
	expectTypeOf(
		yield* ctx.request(erp, { method: 'GET', path: 'n', output: { kind: 'int' } })
	).toEqualTypeOf<number>();
	expectTypeOf(
		yield* ctx.request(kingdee, { op: 'values', values: { n: 1 } })
	).toEqualTypeOf<DatabaseResult>();
	// @ts-expect-error email payloads require subject and recipient lists
	yield* ctx.send(support_mail, { to: '+6590000000', text: 'x' });
	// @ts-expect-error an ERP connection carries no conversation
	yield* ctx.send(erp, { to: '+6590000000', text: 'x' });
	// @ts-expect-error database requests do not accept HTTP operations
	yield* ctx.request(kingdee, { method: 'GET', path: 'x', output: { kind: 'json' } });
	// @ts-expect-error a conversation driver has no HTTP requester
	yield* ctx.request(whatsapp, { method: 'GET', path: 'x', output: { kind: 'json' } });
});

// @ts-expect-error source connection slots are retired
workspace({ tz: 'UTC', locale: 'en', connections: { mail: { integration: 'emial' } } });
integration('support_mail', {
	description: 'x',
	driver: 'email',
	// @ts-expect-error conversation credentials belong to the provider
	credential: { password: { kind: 'text' } }
});
// @ts-expect-error an HTTP base URL is https or a text configuration field
integration('erp', { description: 'x', driver: 'http', http: { base_url: 'ftp://erp' } });
integration('erp', {
	description: 'x',
	driver: 'http',
	credential: { token: { kind: 'text' } },
	// @ts-expect-error bearer auth names a credential field
	http: { base_url: 'https://erp', auth: { bearer: 'tokn' } }
});
// @ts-expect-error drivers are enumerated
integration('erp', { description: 'x', driver: 'ftp' });
// @ts-expect-error the declaration name must be known
integration('erpp', { description: 'x', driver: 'http' });
integration('erp', {
	description: 'x',
	driver: 'http',
	http: { base_url: 'https://erp' },
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
	// @ts-expect-error a database driver offers no OAuth grant
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
integration('erp', {
	description: 'x',
	driver: 'http',
	http: { base_url: 'https://erp' },
	// @ts-expect-error an HTTP OAuth grant needs its endpoints
	oauth: { client: 'CALENDAR_CLIENT', secret: 'CALENDAR_SECRET' }
});
integration('calendar', {
	description: 'x',
	driver: 'calendar',
	// @ts-expect-error OAuth credentials name secrets
	oauth: { client: 'calendar-client', secret: 'CALENDAR_SECRET' }
});
model('orders', {
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
const onText: Where<'orders'> = { note: { eq: { var: 'actor.instance' } } };
void onText;
policy({
	description: 'x',
	grants: {
		// @ts-expect-error a customer reference is not an integration reference
		orders: { outputs: { default: { where: { customer: { eq: { var: 'actor.instance' } } } } } }
	}
});
// @ts-expect-error only declared sync reads are startable
policy({ description: 'x', grants: {}, capabilities: { syncs: ['products.stock'] } });
