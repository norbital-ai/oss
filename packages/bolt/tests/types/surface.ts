// Type corpus for the declaration surface: `messages`, models and their derived names.
// Each `@ts-expect-error` line is a planted mistake; a clean tsc proves both the passes and the rejections.
import { messages, model } from '../../src/index.ts';
import type { InstanceId } from '../../src/index.ts';
import type { LocaleErrors } from '../../src/decl/verify.ts';
import './registry.ts';
import type {
	BtreeField,
	FileField,
	PeriodField,
	RelPath,
	RequiredBtreeField,
	SearchableField,
	TextField,
	VectorField
} from '../../src/decl/names.ts';
import type { KeyValues } from '../../src/decl/ctx.ts';
import type { OutputOf } from '../../src/decl/body.ts';
import type { State } from '../../src/decl/access/policy.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// ── messages(): a locale's keys ⊆ the base, checked by the __verify line ──
messages({ hello: 'Hello' });
// @ts-expect-error M1 a message is a string
// prettier-ignore
messages({ hello: 1 });
is<Eq<LocaleErrors<{ ms: { hello: string } }, { hello: string }>, never>>();
// a native model caption may live only in the locale: the base humanizes it
is<
	Eq<
		LocaleErrors<
			{ ms: { hello: string; 'models.orders.fields.title': string } },
			{ hello: string }
		>,
		never
	>
>();
is<
	Eq<
		LocaleErrors<{ ms: { helo: string } }, { hello: string }>,
		"i18n: +ms.messages.ts key 'helo' is not in +messages.ts"
	>
>();

// ── model search: the semantic model is one +workspace.ts declares, at the width it declares ──
model('semantic_case', {
	description: 'x',
	record_label: 'record.body',
	fields: { body: { kind: 'text' } },

	indexes: {
		find: { text: ['body'] },
		semantic: { semantic: { fields: ['body'], model: 'text_small', dim: 1536 } }
	}
});
// @ts-expect-error S1 an embedding model +workspace.ts does not declare
// prettier-ignore
model('semantic_case', { description: 'x', record_label: "record.body", fields: { body: { kind: 'text' } }, indexes: { find: { text: ['body'] }, semantic: { semantic: { fields: ['body'], model: 'text_big', dim: 1536 } } } });
// @ts-expect-error the embedding column's width is stated, never guessed
// prettier-ignore
model('semantic_case', { description: 'x', record_label: "record.body", fields: { body: { kind: 'text' } }, indexes: { find: { text: ['body'] }, semantic: { semantic: { fields: ['body'], model: 'text_small' } } } });

// ── signature helpers ──
is<Eq<State<'orders'>, 'draft' | 'submitted' | 'ordered'>>();
is<Eq<PeriodField<'sites'>, 'open'>>();
is<Eq<FileField<'sites'>, 'photos'>>();
is<Eq<VectorField<'orders'>, 'colour'>>();
is<Eq<TextField<'notices'>, 'message_id' | 'subject'>>();
is<
	Eq<
		SearchableField<'customers'>,
		| 'name'
		| 'email'
		| 'tier'
		| 'tags'
		| 'name_upper'
		| 'email_lower'
		| 'email_label'
		| 'email_default'
		| 'email_chain'
	>
>();
is<Eq<RelPath<'orders'>, `lines.${'item' | 'qty' | 'price' | 'amount' | 'order'}`>>();
is<Eq<'due' extends BtreeField<'orders'> ? 1 : 0, 1>>();
is<Eq<'total' extends BtreeField<'orders'> ? 1 : 0, 0>>(); // a roll-up is not indexable
is<Eq<'due' extends RequiredBtreeField<'orders'> ? 1 : 0, 0>>(); // optional
is<Eq<'customer' extends RequiredBtreeField<'orders'> ? 1 : 0, 1>>(); // a required FK
is<
	Eq<
		KeyValues<'notices'>,
		{ readonly inbox: InstanceId<'support_mail'>; readonly message_id: string }
	>
>();
is<Eq<KeyValues<'orders'>, never>>(); // no `key`
is<Eq<OutputOf<{ output: { kind: 'int' } }>, number>>();
