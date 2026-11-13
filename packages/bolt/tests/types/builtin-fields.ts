// Type corpus for custom fields, built-in and workspace alike: the built-ins (`money`, `file`, `point`, `phone`)
// sit in the same namespace as a workspace's `src/data/custom_field/<f>/` (here the registry's `rating`), so a model
// references either as `{ kind: 'custom', of }`, the value type flows from the shape, and a renderer's view is typed by
// the name. Each `@ts-expect-error` is a planted mistake `bolt check` must refuse.
import { bind_model } from '../../src/declarations.ts';
import type { CustomFieldView, FileRef, Point, ValueOf } from '../../src/index.ts';
import type { Decimal } from '@norbital-ai/store';
import './registry.ts';
import type { CustomFieldName } from '../../src/decl/names.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// one namespace: built-ins and the workspace's
is<
	Eq<
		CustomFieldName,
		'money' | 'file' | 'point' | 'phone' | 'rating' | 'variant' | 'scalar_variant'
	>
>();

// the value type flows from the shape, built-in or workspace
is<Eq<ValueOf<{ kind: 'custom'; of: 'phone' }>, string>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'money' }>, Decimal>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'file' }>, FileRef>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'point'; optional: true }>, Point | null>>();
is<
	Eq<
		ValueOf<{ kind: 'custom'; of: 'rating' }>,
		{ readonly score: number; readonly note?: string | null }
	>
>();

bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	fields: {
		a: { kind: 'text' },
		mobile: { kind: 'custom', of: 'phone', optional: true },
		site: { kind: 'custom', of: 'point', optional: true },
		r: { kind: 'custom', of: 'rating', optional: true }
	}
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error B1 a misspelt built-in
	fields: { a: { kind: 'text' }, m: { kind: 'custom', of: 'phnoe' } }
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error B2 a misspelt workspace custom field
	fields: { a: { kind: 'text' }, r: { kind: 'custom', of: 'ratng' } }
});
bind_model('probe')({
	description: 'x',
	record_label: 'record.a',
	// @ts-expect-error B3 a built-in's default of the wrong type
	fields: { a: { kind: 'text' }, m: { kind: 'custom', of: 'phone', default: 65 } }
});

// a renderer's view is typed by its name, the same contract for both
is<Eq<CustomFieldView<'phone'>['value'], string | null>>();
is<
	Eq<
		CustomFieldView<'rating'>['value'],
		{ readonly score: number; readonly note?: string | null } | null
	>
>();
const shown: CustomFieldView<'point'> = {
	mode: 'show',
	dense: true,
	name: 'point',
	value: { lat: 1.35, lng: 103.82 }
};
void shown;
// @ts-expect-error B4 a phone view holds text
const wrong: CustomFieldView<'phone'> = { mode: 'show', name: 'phone', value: 6591234567 };
void wrong;
