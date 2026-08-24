// Type utilities for dot-notation paths (e.g. "a.b.c") with full type safety

export type FilterUndefined<T> = T extends undefined ? never : T;
export type FilterNull<T> = T extends null ? never : T;
export type FilterUndefinedAndNull<T> = FilterUndefined<FilterNull<T>>;

export type Path<T> = T extends `${infer Key}.${infer Rest}`
	? [Key, ...Path<Rest>]
	: T extends `${infer Key}`
		? [Key]
		: [];

type ExtractFromObject<O extends Record<PropertyKey, unknown>, K> = K extends keyof O
	? O[K]
	: K extends keyof FilterUndefinedAndNull<O>
		? FilterUndefinedAndNull<O>[K] | undefined
		: undefined;

// `any[]` is structurally necessary here: `any[] extends A`
// tests whether A is an array type. `unknown[]` would change the check's
// assignability semantics and break generic inference.
type ExtractFromArray<A extends readonly any[], K> = any[] extends A
	? A extends readonly (infer T)[]
		? T | undefined
		: undefined
	: K extends keyof A
		? A[K]
		: undefined;

type GetWithArray<O, K> = K extends []
	? O
	: K extends [infer Key, ...infer Rest]
		? O extends Record<PropertyKey, unknown>
			? GetWithArray<ExtractFromObject<O, Key>, Rest>
			: O extends readonly any[] // necessary for array branch test
				? GetWithArray<ExtractFromArray<O, Key>, Rest>
				: undefined
		: never;

export type Get<O, P> = GetWithArray<O, Path<P>>;
