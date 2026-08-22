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

import { Record, Schema } from 'effect';

/** One declared environment variable. */
const EnvironmentVariableSpecSchema = Schema.Struct({
	/** Human label for the Secrets form. Falls back to the variable name. */
	label: Schema.optional(Schema.String),
	/** What this secret is for, and where to obtain one. Shown under the field. */
	description: Schema.optional(Schema.String),
	/**
	 * A value the workspace can run with when the vault has none.
	 *
	 * Only for non-sensitive settings — a base URL, a region. A default for a credential would be a
	 * credential in source, so `secret: true` and `default` are refused together.
	 */
	default: Schema.optional(Schema.String),
	/**
	 * Whether the value is sensitive. Sensitive values are write-only: once stored they are never
	 * returned to any client, and the form shows whether one is set, never what it is.
	 *
	 * Defaults to `true`. A declaration that says nothing is treated as a secret, because the cost of
	 * guessing wrong in that direction is a leaked credential.
	 */
	secret: Schema.optional(Schema.Boolean)
});

interface EnvironmentVariableSpec extends Schema.Schema.Type<
	typeof EnvironmentVariableSpecSchema
> {}

const EnvironmentSpecSchema = Schema.Struct({
	variables: Schema.Record(Schema.String, EnvironmentVariableSpecSchema)
});

export interface EnvironmentSpec extends Schema.Schema.Type<typeof EnvironmentSpecSchema> {}

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

/** The half of a declaration a browser may see: names, labels, descriptions and whether a value is
 * set — never a value, and never a default that belongs to a secret.
 */
const EnvironmentVariableViewSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	label: Schema.NonEmptyString,
	description: Schema.optional(Schema.String),
	secret: Schema.Boolean,
	default: Schema.optional(Schema.String)
});

const decodeEnvironmentVariableView = Schema.decodeUnknownSync(EnvironmentVariableViewSchema);

export type EnvironmentVariableView = Schema.Schema.Type<typeof EnvironmentVariableViewSchema>;

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
			return decodeEnvironmentVariableView(
				Record.filter({
				name,
				label: variable.label ?? name,
				description: variable.description,
				secret,
				default: secret || variable.default === undefined ? undefined : variable.default
				}, (value) => value !== undefined)
			);
		})
		.sort((left, right) => left.name.localeCompare(right.name));
