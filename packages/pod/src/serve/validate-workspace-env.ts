import type { EnvVarConfig, EnvVarsDeclaration } from '../authoring/env.js';

function formatIssues(issues: readonly { readonly message: string }[]): string {
	return issues.map((issue) => issue.message).join('; ');
}

function validatePresentValue(name: string, config: EnvVarConfig, raw: string): void {
	const schema = config.schema;
	if (!schema) return;
	if ('~standard' in schema) {
		const result = schema['~standard'].validate(raw);
		if ('then' in result) {
			throw new Error(`Environment variable ${name} uses an asynchronous schema`);
		}
		if (result.issues?.length) {
			throw new Error(`Invalid environment variable ${name}: ${formatIssues(result.issues)}`);
		}
		return;
	}
	const zodLike = schema as {
		safeParse?(value: unknown): { success: boolean; error?: { message: string } };
	};
	if (typeof zodLike.safeParse === 'function') {
		const result = zodLike.safeParse(raw);
		if (!result.success) {
			throw new Error(
				`Invalid environment variable ${name}: ${result.error?.message ?? 'validation failed'}`
			);
		}
	}
}

/**
 * Check declared workspace env keys against `process.env`.
 *
 * A missing value is always legal — the operator may not have pasted one yet, and callers handle
 * `undefined`. A present value that fails its schema still refuses boot, so a bad paste is caught.
 */
export function validateDeclaredEnvVars(
	variables: EnvVarsDeclaration,
	env: Readonly<Record<string, string | undefined>> = process.env
): void {
	for (const [name, config] of Object.entries(variables)) {
		const raw = env[name]?.trim();
		if (!raw) continue;
		validatePresentValue(name, config, raw);
	}
}
