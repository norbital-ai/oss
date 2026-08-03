import { isValidSkillName } from '$lib/skills/types.js';

/**
 * `SKILL.md` frontmatter, parsed to the same rules `scripts/generate-skills.mjs` applies to the
 * skills Pod ships.
 *
 * Two parsers exist because the two inputs arrive at different times — host skills are read at
 * package build, workspace skills at workspace compile — but they must agree, or a skill that is
 * legal in `skills/` would be rejected in `src/skills/` and an author would have no way to tell
 * which set of rules they were being held to. The accepted YAML is deliberately a subset: quoted and
 * plain scalars, `|`/`>` blocks, and a flat `metadata` map. Anything else is refused rather than
 * guessed at, because a frontmatter key that parsed into the wrong shape would surface as a skill
 * the agent reads incorrectly rather than as an error anyone sees.
 */
export type SkillDocument = {
	readonly name: string;
	readonly description: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** `SKILL.md` with its frontmatter removed. */
	readonly body: string;
};

export type SkillDocumentErrorCode = 'SKILL_FRONTMATTER_INVALID' | 'SKILL_NAME_INVALID';

export type SkillDocumentResult =
	| { readonly ok: true; readonly document: SkillDocument }
	| { readonly ok: false; readonly code: SkillDocumentErrorCode; readonly message: string };

const FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
	'name',
	'description',
	'license',
	'compatibility',
	'metadata'
]);
const KEY_LINE = /^([a-z][a-z0-9_]*):\s*(.*)$/;
const METADATA_LINE = /^\s+([a-z][a-z0-9_]*):\s*(.*)$/;
const BLOCK_INDICATOR = /^([>|])([-+]?)$/;
const DESCRIPTION_LIMIT = 1024;
const COMPATIBILITY_LIMIT = 500;

class SkillDocumentError extends Error {
	readonly code: SkillDocumentErrorCode;

	constructor(code: SkillDocumentErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

function fail(code: SkillDocumentErrorCode, message: string): never {
	throw new SkillDocumentError(code, message);
}

function leadingWhitespace(line: string): number {
	return line.length - line.trimStart().length;
}

function parseQuotedScalar(value: string): string {
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replaceAll("''", "'");
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		return value
			.slice(1, -1)
			.replaceAll('\\"', '"')
			.replaceAll('\\n', '\n')
			.replaceAll('\\t', '\t')
			.replaceAll('\\\\', '\\');
	}
	return value;
}

function parseBlockScalar(
	lines: readonly string[],
	startIndex: number,
	contentIndent: number,
	indicator: string
): { value: string; nextIndex: number } {
	const folded = indicator.startsWith('>');
	const chunks: string[] = [];
	let index = startIndex;

	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim() === '') {
			chunks.push(folded ? '\n' : '');
			index += 1;
			continue;
		}

		const indent = leadingWhitespace(line);
		if (indent <= contentIndent) break;

		chunks.push(line.slice(indent));
		index += 1;
	}

	let value: string;
	if (folded) {
		value = '';
		for (const chunk of chunks) {
			if (chunk === '\n') value += '\n';
			else if (value === '' || value.endsWith('\n')) value += chunk.trimEnd();
			else value += ` ${chunk.trimEnd()}`;
		}
		if (indicator.endsWith('-')) value = value.trimEnd();
	} else {
		value = chunks.join('\n');
		if (indicator.endsWith('-')) value = value.replace(/\n+$/, '');
	}

	return { value, nextIndex: index };
}

function parseScalarValue(
	rest: string,
	lines: readonly string[],
	lineIndex: number
): { value: string; nextIndex: number } {
	const trimmed = rest.trim();
	if (trimmed === '' || BLOCK_INDICATOR.test(trimmed)) {
		const indicator = trimmed === '' ? '|' : trimmed;
		return parseBlockScalar(
			lines,
			lineIndex + 1,
			leadingWhitespace(lines[lineIndex] ?? ''),
			indicator
		);
	}
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return { value: parseQuotedScalar(trimmed), nextIndex: lineIndex + 1 };
	}
	return { value: trimmed, nextIndex: lineIndex + 1 };
}

/**
 * Scalars land in a map rather than a typed object so no cast is needed to move an arbitrary key
 * into a known field; validation is the only thing that turns the map into a `SkillDocument`.
 */
type FrontmatterMap = {
	readonly scalars: ReadonlyMap<string, string>;
	readonly metadata: Readonly<Record<string, string>> | undefined;
};

function parseFrontmatterMap(text: string): FrontmatterMap {
	const lines = text.split(/\r?\n/);
	const scalars = new Map<string, string>();
	let metadata: Record<string, string> | undefined;
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? '';
		if (line.trim() === '') {
			index += 1;
			continue;
		}

		const keyMatch = line.match(KEY_LINE);
		if (!keyMatch) fail('SKILL_FRONTMATTER_INVALID', `invalid frontmatter line: ${line}`);
		const key = keyMatch[1] ?? '';
		if (!FRONTMATTER_KEYS.has(key)) {
			fail('SKILL_FRONTMATTER_INVALID', `unsupported frontmatter key: ${key}`);
		}

		if (key === 'metadata') {
			if ((keyMatch[2] ?? '').trim() !== '') {
				fail('SKILL_FRONTMATTER_INVALID', 'metadata must be a map');
			}
			const entries: Record<string, string> = {};
			index += 1;
			while (index < lines.length && leadingWhitespace(lines[index] ?? '') > 0) {
				const entryMatch = (lines[index] ?? '').match(METADATA_LINE);
				if (!entryMatch) {
					fail('SKILL_FRONTMATTER_INVALID', `invalid metadata entry: ${lines[index]}`);
				}
				const parsed = parseScalarValue(entryMatch[2] ?? '', lines, index);
				entries[entryMatch[1] ?? ''] = parsed.value;
				index = parsed.nextIndex;
			}
			metadata = entries;
			continue;
		}

		const parsed = parseScalarValue(keyMatch[2] ?? '', lines, index);
		scalars.set(key, parsed.value);
		index = parsed.nextIndex;
	}

	return { scalars, metadata };
}

function validate(parsed: FrontmatterMap, directoryName: string): Omit<SkillDocument, 'body'> {
	const name = parsed.scalars.get('name') ?? '';
	const description = parsed.scalars.get('description') ?? '';
	const license = parsed.scalars.get('license');
	const compatibility = parsed.scalars.get('compatibility');

	if (name.trim() === '')
		fail('SKILL_FRONTMATTER_INVALID', 'frontmatter requires a non-empty name');
	if (description.trim() === '') {
		fail('SKILL_FRONTMATTER_INVALID', 'frontmatter requires a non-empty description');
	}
	if (!isValidSkillName(name)) {
		fail(
			'SKILL_NAME_INVALID',
			`name ${name} must be lowercase hyphenated and at most 64 characters`
		);
	}
	if (name !== directoryName) {
		fail('SKILL_NAME_INVALID', `name ${name} must match directory ${directoryName}`);
	}
	if (description.length > DESCRIPTION_LIMIT) {
		fail('SKILL_FRONTMATTER_INVALID', `description exceeds ${DESCRIPTION_LIMIT} characters`);
	}
	if (compatibility !== undefined && compatibility.length > COMPATIBILITY_LIMIT) {
		fail('SKILL_FRONTMATTER_INVALID', `compatibility exceeds ${COMPATIBILITY_LIMIT} characters`);
	}

	return {
		name,
		description,
		...(license ? { license } : {}),
		...(compatibility ? { compatibility } : {}),
		...(parsed.metadata && Object.keys(parsed.metadata).length > 0
			? { metadata: parsed.metadata }
			: {})
	};
}

/**
 * Failures come back as data because every caller is a diagnostic collector: one bad skill has to
 * name itself and let the rest of the workspace keep compiling.
 */
export function parseSkillDocument(content: string, directoryName: string): SkillDocumentResult {
	try {
		if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
			fail('SKILL_FRONTMATTER_INVALID', 'SKILL.md must start with frontmatter (---)');
		}
		const openLength = content.startsWith('---\r\n') ? 5 : 4;
		const closeMatch = content.slice(openLength).match(/\r?\n---(?:\r?\n|$)/);
		if (!closeMatch || closeMatch.index === undefined) {
			fail('SKILL_FRONTMATTER_INVALID', 'SKILL.md frontmatter is not closed with ---');
		}

		const frontmatter = content.slice(openLength, openLength + closeMatch.index);
		const body = content
			.slice(openLength + closeMatch.index + closeMatch[0].length)
			.replace(/^(\s*\r?\n)+/, '');
		const fields = validate(parseFrontmatterMap(frontmatter), directoryName);
		return { ok: true, document: { ...fields, body } };
	} catch (error) {
		if (error instanceof SkillDocumentError) {
			return { ok: false, code: error.code, message: error.message };
		}
		throw error;
	}
}
