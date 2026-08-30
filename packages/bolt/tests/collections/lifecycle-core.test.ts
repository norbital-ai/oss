import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { text } from '../../src/authoring/index.js';
import { describeModelColumns } from '../../src/authoring/model-introspection.js';
import { HookEffectIds } from '../../src/runtime/collections/hooks/boundary.js';
import {
	compileLexicalSearch,
	compileSemanticSearch,
	prepareSearchPlan,
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN
} from '../../src/runtime/collections/read/search.js';
import { statementPlanFor } from '../../src/runtime/collections/write/statements.js';
import {
	projectHistory,
	type HistoryPatch
} from '../../src/runtime/collections/services/history.js';

const render = (expression: SQL) =>
	expression.getSQL().toQuery({
		escapeName: (name) => `"${name}"`,
		escapeParam: (index) => `$${index + 1}`,
		escapeString: (value) => `'${value}'`
	});

/**
 * The searched collection's fields, described the way a compiled workspace describes them.
 *
 * The search opt-in lives on the model column builder — `text({ search: true })` is what writes the
 * marker `searchableColumns` reads back — so the portable `field.string(...)` factory cannot express
 * a searched field. Describing the columns is what a `+model.ts` compiles to, and it is what makes
 * the lexical document and ranking in these tests the same shapes a real collection renders.
 */
const searchedFields = describeModelColumns({ name: text({ search: true }) });

describe('collection lifecycle core', () => {
	it('keeps plain search lexical and reaches the embedder only for the typed semantic command', async () => {
		const context = {
			collection: 'people',
			fields: searchedFields,
			searchDocumentColumn: SEARCH_DOCUMENT_COLUMN,
			embeddingColumn: RECORD_EMBEDDING_COLUMN
		} as const;
		let embeddings = 0;
		const empty = await prepareSearchPlan(undefined, context, async () => {
			embeddings += 1;
			return [0.1, 0.2];
		});
		expect(Result.isSuccess(empty) && empty.success.mode).toBe('none');
		expect(embeddings).toBe(0);
		const lexical = await prepareSearchPlan(
			{ mode: 'lexical', term: '> literal text' },
			context,
			async () => {
				embeddings += 1;
				return [0.1, 0.2];
			}
		);
		expect(Result.isSuccess(lexical) && lexical.success.mode).toBe('lexical');
		expect(embeddings).toBe(0);
		const semantic = await prepareSearchPlan(
			{ mode: 'semantic', term: 'similar contract' },
			context,
			async () => {
				embeddings += 1;
				return [0.1, 0.2];
			}
		);
		expect(Result.isSuccess(semantic) && semantic.success.mode).toBe('semantic');
		expect(embeddings).toBe(1);
	});

	it('renders indexed lexical ranking and a bound vector distance', () => {
		const context = {
			collection: 'people',
			fields: searchedFields,
			searchDocumentColumn: SEARCH_DOCUMENT_COLUMN,
			embeddingColumn: RECORD_EMBEDDING_COLUMN
		} as const;
		const lexical = compileLexicalSearch('García', context);
		expect(Result.isSuccess(lexical)).toBe(true);
		if (Result.isSuccess(lexical)) {
			const query = render(lexical.success.predicate);
			expect(query.sql).toContain('"search_document" @@');
			expect(query.sql).toContain('websearch_to_tsquery');
			expect(render(lexical.success.rank).sql).toContain('ts_rank_cd');
		}
		const semantic = compileSemanticSearch('similar', [0.1, 0.2], context);
		expect(Result.isSuccess(semantic)).toBe(true);
		if (Result.isSuccess(semantic)) {
			const query = render(semantic.success.distance);
			expect(query.sql).toContain('<=>');
			expect(query.params).toEqual(['[0.1,0.2]']);
		}
	});

	it('orders an already-prepared commit without rebuilding its graph', () => {
		type Operation = Parameters<typeof statementPlanFor>[0][number];
		const operation = (
			action: Operation['action'],
			collection: string,
			id: string,
			depth: number
		): Operation => ({ action, collection, id, depth, values: {} }) as unknown as Operation;
		const plan = statementPlanFor([
			operation('delete', 'parents', 'p1', 0),
			operation('create', 'children', 'c1', 1),
			operation('delete', 'children', 'c2', 1),
			operation('update', 'parents', 'p2', 0)
		]);
		expect(plan.operations.map(({ action, id }) => `${action}:${id}`)).toEqual([
			'delete:c2',
			'delete:p1',
			'update:p2',
			'create:c1'
		]);
		const guarded = [...plan.before, ...plan.after].map(({ operation }) => operation.id);
		expect(guarded).toEqual(['c2', 'p1', 'p2', 'c1']);
		expect(plan.operations.map((operation) => operation.id)).toEqual(['c2', 'p1', 'p2', 'c1']);
	});

	it('issues fresh child effect ids and masks bounded history', () => {
		const effects = new HookEffectIds(EffectId.make('root'));
		const first = effects.next({ phase: 'after', collection: 'orders', recordId: 'o1' });
		const second = effects.next({ phase: 'after', collection: 'orders', recordId: 'o1' });
		expect(first).not.toBe(second);
		const patches: ReadonlyArray<HistoryPatch> = [
			{
				sequence: 1,
			operation: 'create',
			snapshot: { id: 'o1', public: 'a', secret: 'x' },
			createdAt: '2026-01-01'
			},
			{
				sequence: 2,
			operation: 'update',
			snapshot: { public: 'b' },
			createdAt: '2026-01-02'
			}
		];
		const projected = projectHistory({
			current: { id: 'o1' },
			patches,
			policy: {
				visible: () => true,
				mask: ({ secret: _secret, ...visible }) => visible
			},
			horizon: 1
		});
		expect(projected._tag).toBe('Visible');
		if (projected._tag === 'Visible') {
			expect(projected.revisions).toHaveLength(1);
			expect(projected.revisions[0]?.values).toEqual({ id: 'o1', public: 'b' });
		}
	});
});
