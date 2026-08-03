/**
 * What this workspace needs from whichever host is running it — declared in `src/+env.ts`.
 *
 * A workspace never holds a secret value. `private` declares the *names* it will reference from a
 * connection or a webhook signature, with a sentence saying what each one is, so the answer to "what
 * must I provision to run this?" is one file rather than a grep for `{ env: ... }`. The compiler
 * lifts it into `manifest.secrets`, which is the shape a host provisioning surface reads.
 *
 * The declaration is checked, not decorative: a reference to a name that is not here fails the build
 * naming the key. That is the whole reason it is a separate declaration rather than something
 * inferred from the references — an inferred set makes `{ env: 'STRIP_KEY' }` a valid workspace that
 * asks its host for a variable nobody will ever set, and the first sign of it is a 401 in production.
 */
export interface WorkspaceEnvDeclaration {
	/**
	 * Non-secret configuration. Present in the manifest, and safe to be, because a public value is
	 * a deployment choice (a base path, a region name) rather than a credential.
	 */
	readonly public?: Readonly<
		Record<string, { readonly description: string; readonly default?: string }>
	>;
	/** Secret names. Referenced as `{ env: 'NAME' }`; resolved by the host at call time. */
	readonly private?: Readonly<Record<string, { readonly description: string }>>;
}

/** Identity function so `src/+env.ts` is type-checked where it is written. */
export function defineEnv<const T extends WorkspaceEnvDeclaration>(declaration: T): T {
	return declaration;
}
