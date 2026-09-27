// The built-in custom fields (§3.3.2): declared exactly as a workspace's `src/data/custom_field/<f>/+definition.ts` is, and
// rendered by the ui's built-in `+renderer.svelte` equivalents (`@norbital-ai/ui` `BUILTIN_FIELDS`, same shape, same
// `{ view: CustomFieldView }` contract). The stored kinds `money`, `file`, `point` and `text` `format: 'phone'` render
// through them by default; a model may also store one as `{ kind: 'custom', of: '<name>' }`, typed by its shape like any
// custom field. A workspace custom field may not take one of these names (`discover/reserved-name`).
import { customField } from './custom-field.ts';

const money = customField({ description: 'An exact amount in the workspace currency, kept as a decimal.', shape: { kind: 'money' }, label: 'Money' });
const file = customField({ description: 'A stored file: its id, name, MIME type and size.', shape: { kind: 'file', accept: ['*/*'], max: '20MiB' }, label: 'File' });
const point = customField({ description: 'A latitude and longitude, picked on a map or found by address.', shape: { kind: 'point' }, label: 'Location' });
const phone = customField({ description: 'A phone number in E.164 (+6591234567), typed with its country calling code.', shape: { kind: 'text', format: 'phone' }, label: 'Phone' });

/**
 * The built-ins as the names index maps a workspace's custom field (`typeof import(<definition>).default`), written out:
 * `customField()` checks its shape against every custom field name, so `typeof` of the declarations would be circular.
 */
export type BuiltinFields = {
	money: { spec: { shape: { readonly kind: 'money' } } };
	file: { spec: { shape: { readonly kind: 'file'; readonly accept: readonly ['*/*']; readonly max: '20MiB' } } };
	point: { spec: { shape: { readonly kind: 'point' } } };
	phone: { spec: { shape: { readonly kind: 'text'; readonly format: 'phone' } } };
};
/** The built-in custom fields by name; the declarations are checked against `BuiltinFields`. */
export const BUILTIN_FIELDS = { money, file, point, phone } satisfies BuiltinFields;
