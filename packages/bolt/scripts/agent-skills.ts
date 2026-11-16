/// <reference types="node" />
// The agent and documentation consume the same source skills. No runtime filesystem access.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../skills', import.meta.url));
const entries: Record<
	string,
	{ authoring: boolean; digest: string; files: Record<string, string> }
> = {};
for (const folder of readdirSync(root).sort()) {
	const path = join(root, folder, 'SKILL.md');
	if (!existsSync(path)) continue;
	const text = readFileSync(path, 'utf8'),
		front = text.split(/^---$/m)[1] ?? '';
	if (!/^agent: true$/m.test(front)) continue;
	const name = /^name: (.+)$/m.exec(front)?.[1];
	if (name === undefined || name !== folder)
		throw new Error(`Agent skill name must match its folder: ${folder}`);
	const files = Object.fromEntries(
		readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' })
			.filter((file) => file.endsWith('.md'))
			.sort()
			.map((file) => [file, readFileSync(join(root, folder, file), 'utf8')])
	);
	entries[name] = {
		authoring: /^authoring: true$/m.test(front),
		digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
		files
	};
}
const target = new URL('../src/engine/agent/skills.generated.ts', import.meta.url);
const generated = `// Generated from oss/skills by scripts/agent-skills.ts. Do not edit.
export const SKILL_SOURCES: Readonly<Record<string, { readonly authoring: boolean; readonly digest: string; readonly files: Readonly<Record<string, string>> }>> = ${JSON.stringify(entries, null, '\t')};
`;
if (!existsSync(target) || readFileSync(target, 'utf8') !== generated)
	writeFileSync(target, generated);
