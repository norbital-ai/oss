// Type corpus for custom fields, built-in and workspace alike (§3.3.2): the built-ins (`money`, `file`, `point`, `phone`)
// sit in the same namespace as a workspace's `src/data/custom_field/<f>/` (here the registry's `rating`), so a model
// references either as `{ kind: 'custom', of }`, the value type flows from the shape, and a renderer's view is typed by
// the name. Each `@ts-expect-error` is a planted mistake `bolt check` must refuse.
import { model } from '../../src/index.ts';
import type { CustomFieldName, CustomFieldView, Decimal, FileRef, Point, ValueOf } from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

// one namespace: built-ins and the workspace's
is<Eq<CustomFieldName, 'money' | 'file' | 'point' | 'phone' | 'rating'>>();

// the value type flows from the shape, built-in or workspace
is<Eq<ValueOf<{ kind: 'custom'; of: 'phone' }>, string>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'money' }>, Decimal>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'file' }>, FileRef>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'point'; optional: true }>, Point | null>>();
is<Eq<ValueOf<{ kind: 'custom'; of: 'rating' }>, { readonly score: number; readonly note?: string | null }>>();

model({ description: 'x', label: 'a', fields: { a: { kind: 'text' },
	mobile: { kind: 'custom', of: 'phone', optional: true }, site: { kind: 'custom', of: 'point', optional: true }, r: { kind: 'custom', of: 'rating', optional: true } } });
// @ts-expect-error B1 a misspelt built-in
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' }, m: { kind: 'custom', of: 'phnoe' } } });
// @ts-expect-error B2 a misspelt workspace custom field
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' }, r: { kind: 'custom', of: 'ratng' } } });
// @ts-expect-error B3 a built-in's default of the wrong type
model({ description: 'x', label: 'a', fields: { a: { kind: 'text' }, m: { kind: 'custom', of: 'phone', default: 65 } } });

// a renderer's view is typed by its name, the same contract for both
is<Eq<CustomFieldView<'phone'>['value'], string | null>>();
is<Eq<CustomFieldView<'rating'>['value'], { readonly score: number; readonly note?: string | null } | null>>();
const shown: CustomFieldView<'point'> = { mode: 'show', dense: true, name: 'point', value: { lat: 1.35, lng: 103.82 } };
void shown;
// @ts-expect-error B4 a phone view holds text
const wrong: CustomFieldView<'phone'> = { mode: 'show', name: 'phone', value: 6591234567 };
void wrong;
