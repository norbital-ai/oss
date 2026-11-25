// Accent- and case-insensitive fuzzy/subsequence text matching and highlight span helpers
// for comboboxes, command palettes, finder search and filterable lists.

/** Half-open character range `[start, end)` inside the original text string. */
export type MatchRange = {
	readonly start: number;
	readonly end: number;
};

/** One contiguous highlighted or plain text segment produced by `match_segments`. */
export type MatchSegment = {
	readonly text: string;
	readonly matched: boolean;
};

type NormalizedText = {
	readonly lower: string;
	readonly map: readonly number[];
};

/**
 * Strips combining diacritics while tracking each normalized character's original index so
 * highlight ranges stay aligned with accented Unicode text (e.g. `"café"` matched by `"cafe"`).
 */
function normalizeWithMap(raw: string): NormalizedText {
	let lower = '';
	const map: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charAt(i);
		const folded = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
		for (let j = 0; j < folded.length; j++) {
			lower += folded.charAt(j);
			map.push(i);
		}
	}
	return { lower, map };
}

function isBoundary(text: string, index: number): boolean {
	if (index <= 0) return true;
	const prev = text.charAt(index - 1);
	const cur = text.charAt(index);
	if (/[\s\-_./:@]/.test(prev)) return true;
	return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}

function mergeRanges(indices: readonly number[]): MatchRange[] {
	const out: MatchRange[] = [];
	for (const idx of indices) {
		const last = out.at(-1);
		if (last !== undefined && idx === last.end) {
			out[out.length - 1] = { start: last.start, end: idx + 1 };
		} else {
			out.push({ start: idx, end: idx + 1 });
		}
	}
	return out;
}

function findBestMatch(
	rawQuery: string,
	rawText: string
): { readonly score: number; readonly ranges: readonly MatchRange[] } | null {
	const qNorm = normalizeWithMap(rawQuery.trim());
	if (qNorm.lower.length === 0) return { score: 1, ranges: [] };
	const tNorm = normalizeWithMap(rawText);
	const q = qNorm.lower;
	const t = tNorm.lower;
	if (q.length > t.length) return null;

	// Fast path: exact contiguous substring gets the highest base score.
	const exactIdx = t.indexOf(q);
	if (exactIdx >= 0) {
		const origStart = tNorm.map[exactIdx] ?? 0;
		const origEnd = (tNorm.map[exactIdx + q.length - 1] ?? origStart) + 1;
		let score = 100 + q.length * 4;
		if (exactIdx === 0) score += 40;
		else if (isBoundary(rawText, origStart)) score += 20;
		if (q.length === t.length) score += 50;
		score -= exactIdx * 0.5;
		return { score, ranges: [{ start: origStart, end: origEnd }] };
	}

	// Subsequence match preferring word boundaries and consecutive runs.
	const matched: number[] = [];
	let score = 0;
	let cursor = 0;
	let prevMatch = -2;

	for (let qi = 0; qi < q.length; qi++) {
		const want = q.charAt(qi);
		let chosen = -1;
		let chosenScore = Number.NEGATIVE_INFINITY;

		for (let ti = cursor; ti < t.length; ti++) {
			if (t.charAt(ti) !== want) continue;
			const orig = tNorm.map[ti] ?? ti;
			let pts = 10;
			if (ti === prevMatch + 1) pts += 18;
			if (ti === 0) pts += 16;
			else if (isBoundary(rawText, orig)) pts += 14;
			pts -= (ti - cursor) * 0.4;
			if (pts > chosenScore) {
				chosenScore = pts;
				chosen = ti;
				if (ti === prevMatch + 1 || isBoundary(rawText, orig)) break;
			}
		}

		if (chosen < 0) return null;
		matched.push(tNorm.map[chosen] ?? chosen);
		score += chosenScore;
		prevMatch = chosen;
		cursor = chosen + 1;
	}

	score -= (t.length - q.length) * 0.1;
	return { score: Math.max(1, score), ranges: mergeRanges(matched) };
}

/**
 * Accent- and case-insensitive fuzzy match score for `query` against `text`.
 * Returns `0` when `query` does not match, or a positive relevance score (higher is better).
 */
export function fuzzy_score(query: string, text: string): number {
	return findBestMatch(query, text)?.score ?? 0;
}

/**
 * Returns sorted, non-overlapping `[start, end)` highlight spans where `query` matches `text`,
 * or an empty array when `query` is blank or does not match.
 */
export function match_ranges(query: string, text: string): readonly MatchRange[] {
	return findBestMatch(query, text)?.ranges ?? [];
}

/**
 * Splits `text` into alternating plain and matched segments for rendering search highlights
 * without injecting raw HTML.
 */
export function match_segments(query: string, text: string): readonly MatchSegment[] {
	if (text === '') return [];
	const ranges = match_ranges(query, text);
	if (ranges.length === 0) return [{ text, matched: false }];

	const segments: MatchSegment[] = [];
	let pos = 0;
	for (const range of ranges) {
		if (range.start > pos) {
			segments.push({ text: text.slice(pos, range.start), matched: false });
		}
		if (range.end > range.start) {
			segments.push({ text: text.slice(range.start, range.end), matched: true });
		}
		pos = range.end;
	}
	if (pos < text.length) {
		segments.push({ text: text.slice(pos), matched: false });
	}
	return segments;
}
