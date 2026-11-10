import { reviveWire, type Json } from '@norbital-ai/std/wire';

const array = (value: Json): value is readonly Json[] => Array.isArray(value);
const revived = (value: Json): unknown =>
	reviveWire(
		'',
		array(value)
			? value.map(revived)
			: value !== null && typeof value === 'object'
				? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revived(item)]))
				: value
	);

/** The native reader checks the selected fields and projects the typed row at the wire boundary. */
export const readValue = <A>(value: Json): A => revived(value) as A;
