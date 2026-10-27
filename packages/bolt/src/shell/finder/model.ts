// The shell finder (L-BOLT-497, 512): apps and pages the viewer may open, matched by title, and records of every
// model the viewer may search (the model's `search.text`), each labelled by its declared `label` fields. A record
// search is one `read` with `search` per model; an answer to an older query is dropped when a newer one was asked.
import { Effect, Fiber, FiberHandle } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { ReadFailed, TransportFailed } from '../../decl/errors.ts';
import type { ModelExposure } from '@norbital-ai/ui';
import type { NavNode } from '../nav.ts';

export type FinderHit =
	| { kind: 'page'; key: string; label: string; context: string | null; href: string }
	| { kind: 'record'; key: string; label: string; context: string; model: string; id: string };
type Row = { readonly [field: string]: Json };
export type FinderAnswer = { readonly [root: string]: { readonly rows: readonly Row[] } };
/** One read request (`{ <model>: { search, limit } }`), answered per root. */
export type FinderRead = (request: {
	readonly [root: string]: { readonly [key: string]: Json };
}) => Effect.Effect<FinderAnswer, ReadFailed | TransportFailed>;

const RECORDS_PER_MODEL = 5;
const has = (text: string, query: string) =>
	text.toLowerCase().includes(query.trim().toLowerCase());

/** The app pages whose title (or app title) holds `query`; every page when it is empty. */
export function pageHits(
	nav: readonly NavNode[],
	query: string,
	t: (key: string) => string
): FinderHit[] {
	const out: FinderHit[] = [];
	const walk = (n: NavNode, trail: string | null) => {
		if (n.kind === 'group') {
			for (const c of n.children) walk(c, t(n.title));
			return;
		}
		const app = t(n.title);
		for (const p of n.pages) {
			const label = n.pages.length === 1 ? app : t(p.title);
			const context = n.pages.length === 1 ? trail : app;
			if (has(label, query) || has(app, query))
				out.push({ kind: 'page', key: p.href, label, context, href: p.href });
		}
	};
	for (const n of nav) walk(n, null);
	return out;
}

/** A row's label: its declared `label` fields joined, else its id. */
export const labelOf = (row: Row, label: readonly string[]) =>
	label
		.map((f) => row[f])
		.filter((v) => v !== null && v !== undefined && v !== '')
		.map(String)
		.join(' · ') || String(row['id'] ?? '');

/**
 * Record search over every searchable model in `catalog`. `search(query)` resolves with the hits, or `null` when a
 * newer query was asked meanwhile (its answer is stale and must not paint). A model whose read fails is left out.
 */
export const recordFinder = (
	catalog: { readonly [model: string]: ModelExposure },
	read: FinderRead,
	t: (key: string) => string
) =>
	Effect.gen(function* () {
		const handle = yield* FiberHandle.make<FinderHit[], never>();
		const searchable = Object.entries(catalog).filter(
			([, exposure]) => (exposure.search?.length ?? 0) > 0
		);
		const title = (model: string) => {
			const key = `models.${model}.label`,
				text = t(key);
			return text !== key ? text : model.replace(/_/g, ' ');
		};
		return {
			models: searchable.map(([model]) => model),
			search: (query: string): Effect.Effect<FinderHit[] | null> =>
				Effect.gen(function* () {
					const slash = /^\/(\S+)\s+(\S.*)$/.exec(query.trim());
					const scope =
						slash === null
							? searchable
							: searchable.filter(([model, exposure]) =>
									slash[1] === 'semantic' ? exposure.semantic === true : model === slash[1]
								);
					const text = slash === null || slash[1] === 'semantic' ? query.trim() : (slash[2] ?? '');
					const search =
						text === ''
							? Effect.succeed<FinderHit[]>([])
							: Effect.forEach(
									scope,
									([model, exposure]) =>
										read({ [model]: { search: text, limit: RECORDS_PER_MODEL } }).pipe(
											Effect.map((answer) =>
												(answer[model]?.rows ?? []).flatMap((row): FinderHit[] =>
													typeof row['id'] === 'string'
														? [
																{
																	kind: 'record',
																	key: `${model}/${row['id']}`,
																	label: labelOf(row, exposure.label),
																	context: title(model),
																	model,
																	id: row['id']
																}
															]
														: []
												)
											),
											Effect.catch(() => Effect.succeed<FinderHit[]>([]))
										),
									{ concurrency: 'unbounded' }
								).pipe(Effect.map((pages) => pages.flat()));
					const fiber = yield* FiberHandle.run(handle, search);
					const result = yield* Fiber.await(fiber);
					return result._tag === 'Success' ? result.value : null;
				})
		};
	});
