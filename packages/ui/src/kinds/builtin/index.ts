// The built-in custom fields (`money`, `file`, `point`, `phone`): registered exactly as a tenant's
// `src/data/custom_field/<f>/` is (`{ shape, label, renderer }`, the renderer taking `{ view: CustomFieldView }`), under
// the name a stored kind renders as (`fieldName`). Bolt declares the same four with `customField()`, so a model may also
// reference one as `{ kind: 'custom', of: 'phone' }`. A host's entry of the same name wins (a tenant's name never clashes:
// `bolt check` refuses it).
import type { CustomFieldEntry, KindsHost } from '../context.js';
import { fieldName, type Kind } from '../kind.js';
import FileField from './file.svelte';
import MoneyField from './money.svelte';
import PhoneField from './phone.svelte';
import PointField from './point.svelte';

/** The host's built-in custom fields (money, file, point, phone), rendered like a tenant's own; a tenant field of the same name wins. */
export const BUILTIN_FIELDS: { readonly [name: string]: CustomFieldEntry } = {
	money: { shape: { kind: 'money' }, label: 'Money', renderer: MoneyField },
	file: { shape: { kind: 'file', accept: ['*/*'], max: '20MiB' }, label: 'File', renderer: FileField },
	point: { shape: { kind: 'point' }, label: 'Location', renderer: PointField },
	phone: { shape: { kind: 'text', format: 'phone' }, label: 'Phone', renderer: PhoneField }
};

/** The custom field a kind renders through (the host's, else a built-in), and the kind its renderer reads: a custom reference's shape, else the field's own literal. */
export function fieldEntry(kind: Kind, host: KindsHost): { entry: CustomFieldEntry; kind: Kind } | undefined {
	const name = fieldName(kind);
	const entry = name === undefined ? undefined : (host.customFields?.[name] ?? BUILTIN_FIELDS[name]);
	return entry === undefined ? undefined : { entry, kind: kind.kind === 'custom' ? entry.shape : kind };
}
