/**
 * What a workspace needs from its environment.
 *
 * `+env.ts` at the workspace root is the one place a workspace says which secrets it expects — a
 * provider API key, a signing secret, a geocoding token. It is a *declaration*, never a value: the
 * values live in the Secrets vault behind the system database facility, and only server-side code
 * can read them.
 *
 * Every entry is optional by construction. A workspace runs with an empty vault, and code that reads
 * a secret is handed `string | null` — there is no `required` flag to promise otherwise, because a
 * promise the platform cannot keep only moves the failure to a worse place. A capability that cannot
 * work without its key refuses at the point of use, where it can say which key is missing.
 */

/** One declared environment variable. */
export interface EnvironmentVariableSpec {
	/** Human label for the Secrets form. Falls back to the variable name. */
	readonly label?: string;
	/** What this secret is for, and where to obtain one. Shown under the field. */
	readonly description?: string;
	/**
	 * A value the workspace can run with when the vault has none.
	 *
	 * Only for non-sensitive settings — a base URL, a region. A default for a credential would be a
	 * credential in source, so `secret: true` and `default` are refused together.
	 */
	readonly default?: string;
	/**
	 * Whether the value is sensitive. Sensitive values are write-only: once stored they are never
	 * returned to any client, and the form shows whether one is set, never what it is.
	 *
	 * Defaults to `true`. A declaration that says nothing is treated as a secret, because the cost of
	 * guessing wrong in that direction is a leaked credential.
	 */
	readonly secret?: boolean;
}

export interface EnvironmentSpec {
	readonly variables: Readonly<Record<string, EnvironmentVariableSpec>>;
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Declares the environment a workspace expects.
 *
 * Names are validated here rather than at read time: a typo in `+env.ts` should fail the build, not
 * surface months later as a capability that silently never turns on.
 */
export const defineEnvironment = <
	const T extends Readonly<Record<string, EnvironmentVariableSpec>>
>(
	variables: T
): EnvironmentSpec & { readonly variables: T } => {
	for (const [name, declaration] of Object.entries(variables)) {
		if (!NAME_PATTERN.test(name)) {
			throw new TypeError(
				`Environment variable "${name}" must be SCREAMING_SNAKE_CASE, so it reads the same in the vault, the form and the shell.`
			);
		}
		if (declaration.default !== undefined && declaration.secret !== false) {
			throw new TypeError(
				`Environment variable "${name}" declares a default and is a secret. A default for a secret is a credential written into source; mark it \`secret: false\` if it genuinely is not one.`
			);
		}
	}
	return Object.freeze({ variables });
};

/**
 * The half of a declaration a browser may see: names, labels, descriptions and whether a value is
 * set — never a value, and never a default that belongs to a secret.
 */
export interface EnvironmentVariableView {
	readonly name: string;
	readonly label: string;
	readonly description?: string;
	readonly secret: boolean;
	readonly default?: string;
}

/**
 * Projects a declaration for the Secrets form.
 *
 * Separate from the declaration itself so the boundary is a function someone has to call, rather
 * than a convention someone has to remember: whatever this returns is what the client is allowed to
 * know, and it cannot return a value because it is never given one.
 */
export const describeEnvironment = (
	declaration: EnvironmentSpec | undefined
): ReadonlyArray<EnvironmentVariableView> =>
	Object.entries(declaration?.variables ?? {})
		.map(([name, variable]) => {
			const secret = variable.secret ?? true;
			return {
				name,
				label: variable.label ?? name,
				...(variable.description === undefined ? {} : { description: variable.description }),
				secret,
				...(secret || variable.default === undefined ? {} : { default: variable.default })
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
