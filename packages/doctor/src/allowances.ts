/**
 * Reviewed per-line allowances.
 *
 * `repository-health:allow <rule> -- <reason>` beside a finding suppresses that rule at that line.
 * The port dropped this, and the omission was invisible: 139 reviewed exceptions across the realm
 * silently became debt again, including the ones written in this package's own source, and the
 * `LEGACY2` allowance somebody had already written for the one component type the type-aware tier
 * reports.
 *
 * It applies once, where the tiers merge, rather than inside each of them. Suppression is a
 * property of a finding and its line, not of the mechanism that produced it, and three copies of
 * this would be three chances to drift.
 *
 * What counts is deliberately narrow, per `docs/rules.md`: an exact rule id, token-matched so `UI1`
 * cannot suppress `UI10`, followed by `--` and a reason. A blanket marker suppresses nothing.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './index.js';

/** `repository-health:allow <rule> -- <reason>`. The reason is required, not decorative. */
const ALLOWANCE = /repository-health:allow\s+([A-Za-z][A-Za-z0-9_]*)\s+--\s+(\S)/g;

/**
 * A location is `file:line: text`.
 *
 * Non-greedy, so the first `:<digits>: ` wins: the reported source text routinely contains its own
 * `:` and a greedy match would read a line number out of the evidence.
 */
const LOCATION = /^(.+?):(\d+): /;
const PAIR_OWNERS = /^(.*?) <-> (.*?):/;

function marks(line: string, rule: string): boolean {
	ALLOWANCE.lastIndex = 0;
	for (let match = ALLOWANCE.exec(line); match !== null; match = ALLOWANCE.exec(line))
		if (match[1] === rule) return true;
	return false;
}

/** Whether a line is comment text, in any of the three syntaxes these sources use. */
function isComment(line: string): boolean {
	const text = line.trim();
	return (
		text.startsWith('//') ||
		text.startsWith('*') ||
		text.startsWith('/*') ||
		text.startsWith('<!--') ||
		// A wrapped comment's later lines start with prose. `*` covers the `/* … */` convention;
		// an HTML comment has no such marker, so the closing line is the signal.
		text.endsWith('-->') ||
		text.endsWith('*/')
	);
}

/**
 * Whether an allowance for `rule` sits on the reported line, or in the comment block above it.
 *
 * "Immediately before" in practice means the marker is the last line of the comment that explains
 * it, so the block above is walked rather than only the single preceding line. A blank line ends
 * the block: a comment separated from the code is about something else.
 */
function allowedAt(lines: ReadonlyArray<string>, line: number, rule: string): boolean {
	const index = line - 1;
	if (index < 0 || index >= lines.length) return false;
	if (marks(lines[index] ?? '', rule)) return true;
	for (let above = index - 1; above >= 0; above -= 1) {
		const text = lines[above] ?? '';
		if (!isComment(text)) return false;
		if (marks(text, rule)) return true;
	}
	return false;
}

/** Drop every finding a reviewed allowance covers, from whichever tier reported it. */
export function applyAllowances(
	root: string,
	findings: ReadonlyArray<Finding>
): ReadonlyArray<Finding> {
	const sources = new Map<string, ReadonlyArray<string> | undefined>();
	const linesOf = (file: string): ReadonlyArray<string> | undefined => {
		if (!sources.has(file)) {
			const read = Effect.runSync(
				Effect.result(Effect.try(() => readFileSync(join(root, file), 'utf8')))
			);
			sources.set(
				file,
				Result.isSuccess(read)
					? Result.match(read, { onSuccess: (v) => v.split('\n'), onFailure: () => undefined })
					: undefined
			);
		}
		return sources.get(file);
	};

	return findings.filter((finding) => {
		// A pair location names two files (`a <-> b:1:`). The nomination is about the pair, so an
		// allowance on *either* file's reported line suppresses it: the reviewer annotates the
		// file they read, and whichever side that is, it counts.
		const candidates = PAIR_OWNERS.exec(finding.location);
		const files =
			candidates === null
				? [LOCATION.exec(finding.location)?.[1]]
				: [candidates[1], candidates[2]];
		const line = candidates === null ? Number(LOCATION.exec(finding.location)?.[2] ?? 1) : 1;
		for (const file of files) {
			if (file === undefined) continue;
			const lines = linesOf(file);
			if (lines === undefined) continue;
			if (allowedAt(lines, line, finding.rule)) return false;
		}
		return true;
	});
}
