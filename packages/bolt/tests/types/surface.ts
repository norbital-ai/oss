// Type corpus for the declarations the P1 review added (§3.3.1 `team` and `messages`, §3.3.10 signature helpers).
// Each `@ts-expect-error` line is a planted mistake; a clean tsc proves both the passes and the rejections.
import { messages, model, team } from '../../src/index.ts';
import type {
	BtreeField,
	FileField,
	InstanceId,
	KeyValues,
	OutputOf,
	PeriodField,
	RelPath,
	RequiredBtreeField,
	SearchableField,
	State,
	TextField,
	VectorField
} from '../../src/index.ts';
import type { LocaleErrors } from '../../src/decl/verify.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

// ── team(): keys are TeamName, values name policies ──
team({ Sales: ['sales_rep'], Finance: [] });
// @ts-expect-error T1 an unknown policy
// prettier-ignore
team({ Sales: ['sales_rap'] });
// @ts-expect-error T2 a team holds a list of policies, not one
// prettier-ignore
team({ Sales: 'sales_rep' });

// Source handles are case-sensitive and labels do not merge them.
team({ Sales: ['sales_rep'], sales: ['sales_rep'] });
// @ts-expect-error T3 an unknown source parent
// prettier-ignore
team({ Sales: { policies: ['sales_rep'], parent: 'missing' } });

// ── messages(): a locale's keys ⊆ the base, checked by the __verify line ──
messages({ hello: 'Hello' });
// @ts-expect-error M1 a message is a string
// prettier-ignore
messages({ hello: 1 });
is<Eq<LocaleErrors<{ ms: { hello: string } }, { hello: string }>, never>>();
is<
	Eq<
		LocaleErrors<{ ms: { helo: string } }, { hello: string }>,
		"i18n: +ms.messages.ts key 'helo' is not in +messages.ts"
	>
>();

// ── model search: the semantic model is one +workspace.ts declares, at the width it declares ──
model({
	description: 'x',
	label: 'body',
	fields: { body: { kind: 'text' } },
	search: { text: ['body'], semantic: { fields: ['body'], model: 'text_small', dim: 1536 } }
});
// @ts-expect-error S1 an embedding model +workspace.ts does not declare
// prettier-ignore
model({ description: 'x', label: 'body', fields: { body: { kind: 'text' } }, search: { text: ['body'], semantic: { fields: ['body'], model: 'text_big', dim: 1536 } } });
// @ts-expect-error the embedding column's width is stated, never guessed
// prettier-ignore
model({ description: 'x', label: 'body', fields: { body: { kind: 'text' } }, search: { text: ['body'], semantic: { fields: ['body'], model: 'text_small' } } });

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
