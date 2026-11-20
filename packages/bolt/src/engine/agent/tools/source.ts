import { Effect } from 'effect';
import { Port, type WorkspacePort } from '@norbital-ai/host-api';
import { BoltError } from '../../../protocol/errors.ts';
import { readsAny } from '../../access/authority.ts';
import { sourceLines } from '../ingest.ts';
import { globSource, grepSource, listSource, readSource } from './definitions.ts';
import {
	directoryPage,
	err,
	filePage,
	globRegExp,
	grepAnswer,
	ok,
	outsideSource,
	sourcePath,
	sourceTree,
	textAnswer,
	truncatedNote
} from './helpers.ts';
import { GENERATED, HIT_CHARS, type AddTool, type ToolContext } from './types.ts';

export function visibleSource(x: ToolContext): WorkspacePort | undefined {
	const a = x.authority;
	const ws = x.draft ?? x.workspace;
	if (ws === undefined) return undefined;
	const unseen = (path: string) => {
		const model = /^src\/data\/model\/([^/]+)\//.exec(path)?.[1];
		return model !== undefined && !readsAny(a, model);
	};
	return {
		files: () => ws.files().then((files) => files.filter((f) => !unseen(f))),
		read: (path) => (unseen(path) ? Promise.resolve(null) : ws.read(path))
	};
}

export function bindSourceTools(
	x: ToolContext,
	source: WorkspacePort | undefined,
	add: AddTool
): void {
	const a = x.authority;
	if (source === undefined || (a.actor.kind === 'member' && a.actor.external)) return;

	add(readSource, function* (i) {
		if (i.limit !== undefined && i.limit < 1) return err('Limit must be a positive integer');
		const path = sourcePath(i.path),
			files = yield* Port.attempt('workspace.files', () => source.files());
		if (!files.includes(path))
			return path !== '' && !files.some((file) => file.startsWith(`${path}/`))
				? err(`File not found: ${i.path}`)
				: textAnswer(directoryPage(path, files, i.offset, i.limit));
		const text = yield* Port.attempt('workspace.read', () => source.read(path));
		return text === null
			? err(`File not found: ${i.path}`)
			: textAnswer(filePage(path, text, i.offset, i.limit));
	});

	const sourceUnder = (within: string) =>
		Port.attempt('workspace.files', () => source.files()).pipe(
			Effect.map((files) =>
				files.filter(
					(file) =>
						(within === '' || file === within || file.startsWith(`${within}/`)) &&
						!GENERATED.test(file) &&
						file !== 'bun.lock'
				)
			)
		);

	add(grepSource, function* (i) {
		const within = sourcePath(i.path ?? '');
		const outside = outsideSource(i.path ?? '', within);
		if (outside !== undefined) return err(outside);
		const search = x.search?.bind(x);
		const found =
			a.admin && search !== undefined
				? yield* Port.attempt('workspace.search', () =>
						search({
							pattern: i.pattern,
							...(i.path === undefined ? {} : { path: i.path }),
							...(i.include === undefined ? {} : { include: i.include }),
							...(i.literal === undefined ? {} : { literal: i.literal }),
							...(i.count ? { count: true } : {}),
							...(i.caseSensitive === undefined ? {} : { case_sensitive: i.caseSensitive }),
							...(i.limit === undefined ? {} : { limit: i.limit })
						})
					)
				: undefined;
		if (found !== undefined && 'error' in found) return err(found.error);
		if (i.count && found?.counts)
			return ok({ matchingLines: found.counts.lines, matchingFiles: found.counts.files });
		if (found !== undefined && !i.count)
			return textAnswer(
				grepAnswer(
					found.hits.filter((hit) => !GENERATED.test(hit.path)),
					found.truncated
				)
			);
		const regex =
			i.literal === true
				? null
				: yield* Effect.try({
						try: () => new RegExp(i.pattern, i.caseSensitive === false ? 'i' : ''),
						catch: (cause) =>
							BoltError.make(
								'invalid_input',
								'decode',
								`Invalid regex pattern: ${cause instanceof Error ? cause.message : String(cause)}`
							)
					});
		const wanted = i.caseSensitive === false ? i.pattern.toLowerCase() : i.pattern;
		const included = i.include === undefined ? undefined : globRegExp(i.include);
		const eligible = yield* sourceUnder(within);
		const files = eligible.filter((file) => included === undefined || included.test(file));
		if (within !== '' && eligible.length === 0) return err(`Search path does not exist: ${i.path}`);
		let matchingLines = 0,
			matchingFiles = 0;
		const limit = i.limit ?? 100,
			hits: { path: string; line: number; text: string }[] = [];
		for (const path of files) {
			const text = (yield* Port.attempt('workspace.read', () => source.read(path))) ?? '';
			let matched = false;
			for (const [line, value] of sourceLines(text).entries()) {
				if (
					regex === null
						? (i.caseSensitive === false ? value.toLowerCase() : value).includes(wanted)
						: regex.test(value)
				) {
					if (i.count) {
						matchingLines++;
						if (!matched) matchingFiles++;
						matched = true;
						continue;
					}
					if (hits.length === limit) return textAnswer(grepAnswer(hits, true));
					hits.push({ path, line: line + 1, text: value.slice(0, HIT_CHARS) });
				}
			}
		}
		return i.count ? ok({ matchingLines, matchingFiles }) : textAnswer(grepAnswer(hits, false));
	});

	add(globSource, function* (i) {
		const within = sourcePath(i.path ?? '');
		const outside = outsideSource(i.path ?? '', within) ?? outsideSource(i.pattern, i.pattern);
		if (outside !== undefined) return err(outside);
		const files = yield* sourceUnder(within);
		if (within !== '' && files.length === 0) return err(`Search path does not exist: ${i.path}`);
		if (files.includes(within)) return err(`Search path is not a directory: ${i.path}`);
		const pattern = globRegExp(i.pattern),
			limit = i.limit ?? 100,
			found = files.filter((file) => {
				const rest = within === '' ? file : file.slice(within.length + 1);
				return (
					pattern.test(rest) &&
					(i.hidden === true || !rest.split('/').some((part) => part.startsWith('.')))
				);
			});
		return textAnswer(
			[
				...(found.length === 0 ? ['No files found'] : found.slice(0, limit)),
				...(found.length > limit ? ['', truncatedNote(limit)] : [])
			].join('\n')
		);
	});

	add(listSource, function* (i) {
		const under = sourcePath(i.path ?? ''),
			outside = outsideSource(i.path ?? '', under);
		if (outside !== undefined) return err(outside);
		const shown = (yield* Port.attempt('workspace.files', () => source.files())).filter(
			(file) => under === '' || file.startsWith(`${under}/`)
		);
		return shown.length === 0
			? err(`${i.path}: no such directory: workspace_list_dir with no path shows the source.`)
			: textAnswer(sourceTree(shown));
	});
}
