export type JsonPatchOperation = {
	op: 'add' | 'remove' | 'replace';
	path: string;
	value?: unknown;
};

/**
 * Parse a JSON string, returning `null` on failure.
 *
 * Returns `unknown` — callers must narrow the result (e.g. with a Zod schema
 * or a type guard) before treating it as a concrete type. This is the
 * unvalidated boundary parse; structured validation belongs at the call site.
 */
export function safeParse(json: string): unknown {
	try {
		// stupidity:allow R6b -- this boundary intentionally returns unknown for caller validation
		return JSON.parse(json);
	} catch {
		return null;
	}
}

export function safeStringify(value: unknown, space?: number): string {
	try {
		return JSON.stringify(value, null, space);
	} catch {
		return '{"error":"Unable to stringify value"}';
	}
}

function escapePointer(s: string): string {
	return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pathJoin(base: string, key: string): string {
	return `${base}/${escapePointer(key)}`;
}

export function deepDiff(a: unknown, b: unknown, basePath = ''): JsonPatchOperation[] {
	if (a === b) return [];

	if (Array.isArray(a) && Array.isArray(b)) {
		const ops: JsonPatchOperation[] = [];
		const maxLen = Math.max(a.length, b.length);
		for (let i = 0; i < maxLen; i++) {
			const p = `${basePath}/${i}`;
			if (i >= b.length) {
				ops.push({ op: 'remove', path: p });
			} else if (i >= a.length) {
				ops.push({ op: 'add', path: p, value: b[i] });
			} else {
				ops.push(...deepDiff(a[i], b[i], p));
			}
		}
		return ops;
	}

	if (
		a !== null &&
		typeof a === 'object' &&
		!Array.isArray(a) &&
		b !== null &&
		typeof b === 'object' &&
		!Array.isArray(b)
	) {
		const ops: JsonPatchOperation[] = [];
		const seen = new Set<string>();

		for (const key of Object.keys(a)) {
			seen.add(key);
			if (!(key in b)) {
				ops.push({ op: 'remove', path: pathJoin(basePath, key) });
			} else {
				ops.push(...deepDiff(Reflect.get(a, key), Reflect.get(b, key), pathJoin(basePath, key)));
			}
		}

		for (const key of Object.keys(b)) {
			if (!seen.has(key)) {
				ops.push({ op: 'add', path: pathJoin(basePath, key), value: Reflect.get(b, key) });
			}
		}

		return ops;
	}

	return [{ op: 'replace', path: basePath, value: b }];
}
