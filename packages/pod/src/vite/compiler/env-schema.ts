/** Keys declared in `src/+env.ts`, split for virtual modules and generated types. */
export type ParsedEnvSchema = {
	readonly private: readonly string[];
	readonly public: readonly string[];
};

const ENV_KEY_PATTERN = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\{/gm;

/** Parse env variable names from authored source without executing the module. */
export function parseEnvSchemaSource(source: string): ParsedEnvSchema | null {
	if (!source.includes('defineEnvVars')) return null;
	const keys: Array<{ readonly name: string; readonly public: boolean }> = [];
	for (const match of source.matchAll(ENV_KEY_PATTERN)) {
		const name = match[1];
		if (!name) continue;
		const start = match.index ?? 0;
		const chunk = source.slice(start, start + 800);
		keys.push({ name, public: /\bpublic\s*:\s*true\b/.test(chunk) });
	}
	if (keys.length === 0) return null;
	return {
		private: keys.filter((key) => !key.public).map((key) => key.name),
		public: keys.filter((key) => key.public).map((key) => key.name)
	};
}

export function renderEnvModuleTypes(envVars: ParsedEnvSchema): string {
	const privateExports = envVars.private
		.map((name) => `\texport const ${name}: string | undefined;`)
		.join('\n');
	const publicExports = envVars.public
		.map((name) => `\texport const ${name}: string | undefined;`)
		.join('\n');
	return [
		"declare module '$app/env/private' {",
		privateExports || '\texport {};',
		'}',
		'',
		"declare module '$app/env/public' {",
		publicExports || '\texport {};',
		'}',
		''
	].join('\n');
}

export function renderEnvVirtualModule(
	kind: 'private' | 'public',
	names: readonly string[]
): string {
	return names.map((name) => `export const ${name} = process.env.${name};`).join('\n') + '\n';
}
