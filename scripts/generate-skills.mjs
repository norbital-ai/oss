import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const skillsRoot = path.join(repositoryRoot, 'skills');
const outputFile = path.join(repositoryRoot, 'packages/pod/src/lib/skills/skills.generated.ts');

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);

function fail(message) {
	throw new Error(message);
}

function readArguments(argv) {
	const check = argv.includes('--check');
	const unknown = argv.filter((argument) => argument !== '--check');
	if (unknown.length > 0) {
		fail(`Unknown argument: ${unknown[0]}`);
	}
	return { check };
}

function leadingWhitespace(line) {
	const match = line.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

function parseQuotedScalar(value) {
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

function parseBlockScalar(lines, startIndex, contentIndent, indicator) {
	const folded = indicator.startsWith('>');
	let index = startIndex;
	const chunks = [];

	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === '') {
			if (folded) {
				chunks.push('\n');
			} else {
				chunks.push('');
			}
			index += 1;
			continue;
		}

		const indent = leadingWhitespace(line);
		if (indent <= contentIndent) {
			break;
		}

		chunks.push(line.slice(indent));
		index += 1;
	}

	let value;
	if (folded) {
		value = '';
		for (const chunk of chunks) {
			if (chunk === '\n') {
				value += '\n';
			} else if (value === '' || value.endsWith('\n')) {
				value += chunk.trimEnd();
			} else {
				value += ` ${chunk.trimEnd()}`;
			}
		}
		if (indicator.endsWith('-')) {
			value = value.trimEnd();
		}
	} else {
		value = chunks.join('\n');
		if (indicator.endsWith('-')) {
			value = value.replace(/\n+$/, '');
		}
	}

	return { value, nextIndex: index };
}

function parseScalarValue(rest, lines, lineIndex, filePath) {
	const trimmed = rest.trim();
	if (trimmed === '' || /^([>|])([-+]?)$/.test(trimmed)) {
		const indicator = trimmed === '' ? '|' : trimmed;
		const contentIndent = leadingWhitespace(lines[lineIndex]);
		return parseBlockScalar(lines, lineIndex + 1, contentIndent, indicator);
	}

	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return { value: parseQuotedScalar(trimmed), nextIndex: lineIndex + 1 };
	}

	return { value: trimmed, nextIndex: lineIndex + 1 };
}

function parseFrontmatterMap(text, filePath) {
	const lines = text.split(/\r?\n/);
	const result = {};
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === '') {
			index += 1;
			continue;
		}

		const keyMatch = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
		if (!keyMatch) {
			fail(`${filePath}: invalid frontmatter line: ${line}`);
		}

		const key = keyMatch[1];
		if (!FRONTMATTER_KEYS.has(key)) {
			fail(`${filePath}: unsupported frontmatter key: ${key}`);
		}

		const rest = keyMatch[2];
		if (key === 'metadata') {
			if (rest.trim() !== '') {
				fail(`${filePath}: metadata must be a map`);
			}
			const metadata = {};
			index += 1;
			while (index < lines.length && leadingWhitespace(lines[index]) > 0) {
				const metaMatch = lines[index].match(/^\s+([a-z][a-z0-9_]*):\s*(.*)$/);
				if (!metaMatch) {
					fail(`${filePath}: invalid metadata entry: ${lines[index]}`);
				}
				const parsed = parseScalarValue(metaMatch[2], lines, index, filePath);
				metadata[metaMatch[1]] = parsed.value;
				index = parsed.nextIndex;
			}
			result.metadata = metadata;
			continue;
		}

		const parsed = parseScalarValue(rest, lines, index, filePath);
		result[key] = parsed.value;
		index = parsed.nextIndex;
	}

	return result;
}

function parseSkillMarkdown(content, filePath) {
	if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
		fail(`${filePath}: SKILL.md must start with frontmatter (---)`);
	}

	const openLength = content.startsWith('---\r\n') ? 5 : 4;
	const closeMatch = content.slice(openLength).match(/\r?\n---(?:\r?\n|$)/);
	if (!closeMatch || closeMatch.index === undefined) {
		fail(`${filePath}: SKILL.md frontmatter is not closed with ---`);
	}

	const frontmatterText = content.slice(openLength, openLength + closeMatch.index);
	let body = content.slice(openLength + closeMatch.index + closeMatch[0].length);
	body = body.replace(/^(\s*\r?\n)+/, '');

	return {
		...parseFrontmatterMap(frontmatterText, filePath),
		body
	};
}

function validateSkillFrontmatter(parsed, directoryName, filePath) {
	if (!parsed.name || parsed.name.trim() === '') {
		fail(`${filePath}: frontmatter requires non-empty name`);
	}
	if (!parsed.description || parsed.description.trim() === '') {
		fail(`${filePath}: frontmatter requires non-empty description`);
	}
	if (parsed.name.length > 64 || !SKILL_NAME_PATTERN.test(parsed.name)) {
		fail(`${filePath}: name must be lowercase hyphenated and at most 64 characters`);
	}
	if (parsed.name !== directoryName) {
		fail(`${filePath}: name "${parsed.name}" must match directory "${directoryName}"`);
	}
	if (parsed.description.length > 1024) {
		fail(`${filePath}: description exceeds 1024 characters`);
	}
	if (parsed.compatibility && parsed.compatibility.length > 500) {
		fail(`${filePath}: compatibility exceeds 500 characters`);
	}
}

function collectSkillFiles(skillDirectory) {
	const files = [];

	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}

			const relativePath = path.relative(skillDirectory, fullPath).split(path.sep).join('/');
			if (relativePath === 'SKILL.md') {
				continue;
			}

			files.push({
				path: relativePath,
				text: readFileSync(fullPath, 'utf8')
			});
		}
	}

	walk(skillDirectory);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
}

function discoverSkillDirectories() {
	return readdirSync(skillsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

function loadSkills() {
	return discoverSkillDirectories().map((directoryName) => {
		const skillDirectory = path.join(skillsRoot, directoryName);
		const skillFile = path.join(skillDirectory, 'SKILL.md');
		const parsed = parseSkillMarkdown(readFileSync(skillFile, 'utf8'), skillFile);
		validateSkillFrontmatter(parsed, directoryName, skillFile);

		const skill = {
			name: parsed.name,
			description: parsed.description,
			body: parsed.body,
			files: collectSkillFiles(skillDirectory),
			origin: 'host'
		};

		if (parsed.license) {
			skill.license = parsed.license;
		}
		if (parsed.compatibility) {
			skill.compatibility = parsed.compatibility;
		}
		if (parsed.metadata && Object.keys(parsed.metadata).length > 0) {
			skill.metadata = parsed.metadata;
		}

		return skill;
	});
}

function emitMetadata(metadata) {
	const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
	const lines = ['\t\tmetadata: {'];
	for (const [key, value] of entries) {
		lines.push(`\t\t\t${key}: ${JSON.stringify(value)},`);
	}
	lines.push('\t\t},');
	return lines.join('\n');
}

function emitSkill(skill) {
	const lines = ['\t{'];
	lines.push(`\t\tname: ${JSON.stringify(skill.name)},`);
	lines.push(`\t\tdescription: ${JSON.stringify(skill.description)},`);
	if (skill.license) {
		lines.push(`\t\tlicense: ${JSON.stringify(skill.license)},`);
	}
	if (skill.compatibility) {
		lines.push(`\t\tcompatibility: ${JSON.stringify(skill.compatibility)},`);
	}
	if (skill.metadata) {
		lines.push(emitMetadata(skill.metadata));
	}
	lines.push(`\t\tbody: ${JSON.stringify(skill.body)},`);
	lines.push('\t\tfiles: [');
	for (const file of skill.files) {
		lines.push('\t\t\t{');
		lines.push(`\t\t\t\tpath: ${JSON.stringify(file.path)},`);
		lines.push(`\t\t\t\ttext: ${JSON.stringify(file.text)}`);
		lines.push('\t\t\t},');
	}
	lines.push('\t\t],');
	lines.push("\t\torigin: 'host'");
	lines.push('\t}');
	return lines.join('\n');
}

function generateSource(skills) {
	const header = [
		'// Generated by scripts/generate-skills.mjs from skills/. Do not edit.',
		'// Run `pnpm skills:generate` after changing any file under skills/.',
		'',
		"import type { Skill } from './types.js';",
		'',
		'export const HOST_SKILLS: readonly Skill[] = ['
	];

	const body = skills.map((skill) => emitSkill(skill)).join(',\n');
	return `${header.join('\n')}\n${body}\n];\n`;
}

function formatSource(source) {
	try {
		return execFileSync(
			'pnpm',
			['exec', 'prettier', '--stdin-filepath', path.relative(repositoryRoot, outputFile)],
			{
				cwd: repositoryRoot,
				input: source,
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe']
			}
		);
	} catch (cause) {
		const detail = cause?.stderr?.toString().trim();
		fail(`prettier failed${detail ? `: ${detail}` : ''}`);
	}
}

function main() {
	const options = readArguments(process.argv.slice(2));
	const skills = loadSkills();
	const source = formatSource(generateSource(skills));

	if (options.check) {
		let existing;
		try {
			existing = readFileSync(outputFile, 'utf8');
		} catch {
			fail(`${outputFile} is missing. Run \`pnpm skills:generate\`.`);
		}
		if (existing !== source) {
			console.error(`${outputFile} is out of date. Run \`pnpm skills:generate\`.`);
			process.exit(1);
		}
		console.log('skills.generated.ts is up to date.');
		return;
	}

	writeFileSync(outputFile, source, 'utf8');
	console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} (${skills.length} skills).`);
}

main();
