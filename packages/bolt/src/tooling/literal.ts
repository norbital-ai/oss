import { Array, Predicate } from 'effect';

/** Literal type text: data keeps its exact shape; object callbacks/undefined are omitted. */
export function literal(value: unknown, indent = ''): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return `readonly [${value.map((v) => literal(v, indent)).join(', ')}]`;
	if (!Predicate.isObject(value)) return 'unknown';
	const inner = `${indent}\t`;
	const entries = Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function');
	return entries.length === 0
		? '{}'
		: `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${literal(v, inner)};`).join('\n')}\n${indent}}`;
}
