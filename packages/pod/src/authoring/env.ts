/**
 * Environment variables for this workspace — declared in `src/+env.ts`.
 *
 * Values live in the facility database and are cached on `process.env` at boot. Tenant code
 * reads them through `$app/env/private` and `$app/env/public`, the same modules SvelteKit
 * exposes. `$app/env/private` is server-only.
 *
 * The compiler lifts private keys into `manifest.secrets` and public keys into `manifest.env.public`.
 * Integration `{ env: 'NAME' }` references must name a declared private key. Every key is optional:
 * a missing value is `undefined` and callers handle it.
 */
export interface EnvVarConfig<T = string> {
	/** Standard Schema applied when a value is present. Missing is always legal. */
	readonly schema?: StandardSchemaV1<string | undefined, T>;
	/**
	 * When `true`, the variable may be imported from `$app/env/public`. Otherwise it is available only
	 * from `$app/env/private`, which is server-only.
	 */
	readonly public?: boolean;
	/**
	 * When `true`, the build-time value is inlined. Pod treats workspace env as runtime-only today;
	 * the flag exists so the declaration matches SvelteKit's contract.
	 */
	readonly static?: boolean;
	/** Inline documentation for Studio and hover help. */
	readonly description?: string;
}

/** Minimal Standard Schema surface — enough for Zod and other validators without taking a dependency. */
export interface StandardSchemaV1<Input, Output = Input> {
	readonly '~standard': StandardSchemaV1Props<Input, Output>;
}

type StandardSchemaIssue = { readonly message: string };

type StandardSchemaResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly StandardSchemaIssue[] };

interface StandardSchemaV1Props<Input, Output> {
	readonly validate: (
		value: Input
	) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
}

export type EnvVarsDeclaration = Readonly<Record<string, EnvVarConfig>>;

/** Identity function so `src/+env.ts` is type-checked where it is written. */
export function defineEnvVars<const T extends Record<string, EnvVarConfig>>(variables: T): T {
	return variables;
}
