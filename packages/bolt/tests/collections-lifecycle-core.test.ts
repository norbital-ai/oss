import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { text } from '../src/authoring/index.js';
import { describeModelColumns } from '../src/authoring/model-introspection.js';
import {
	compileLexicalSearch,
	compileSemanticSearch,
	prepareSearchPlan,
	RECORD_EMBEDDING_COLUMN,
	SEARCH_DOCUMENT_COLUMN
} from '../src/runtime/collections/read/search.js';
import { statementPlanFor } from '../src/runtime/collections/write/statements.js';
import { projectHistory, type HistoryPatch } from '../src/runtime/collections/services/history.js';

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
	it('keeps plain search lexical and reaches the embedder only for /semantic', async () => {
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
		// A slash that names no command (`/2`, `a/b`) is text like any other.
		const lexical = await prepareSearchPlan('> literal /2 text', context, async () => {
			embeddings += 1;
			return [0.1, 0.2];
		});
		expect(Result.isSuccess(lexical) && lexical.success.mode).toBe('lexical');
		expect(embeddings).toBe(0);
		const semantic = await prepareSearchPlan('/semantic similar contract', context, async () => {
			embeddings += 1;
			return [0.1, 0.2];
		});
		expect(Result.isSuccess(semantic) && semantic.success.mode).toBe('semantic');
		expect(embeddings).toBe(1);
	});

	it('renders indexed lexical ranking and a fused hybrid ranking', () => {
		const context = {
			collection: 'people',
			fields: searchedFields,
			searchDocumentColumn: SEARCH_DOCUMENT_COLUMN,
			embeddingColumn: RECORD_EMBEDDING_COLUMN
		} as const;
		const lexical = compileLexicalSearch('García', context);
		expect(Result.isSuccess(lexical)).toBe(true);
		if (Result.isSuccess(lexical) && lexical.success.mode !== 'none') {
			const query = render(lexical.success.predicate);
			expect(query.sql).toContain('"search_document" @@');
			expect(query.sql).toContain('bolt_search_query(');
			expect(render(lexical.success.ordering).sql).toContain('ts_rank(');
		}
		const semantic = compileSemanticSearch('similar', [0.1, 0.2], context);
		expect(Result.isSuccess(semantic)).toBe(true);
		if (Result.isSuccess(semantic) && semantic.success.mode !== 'none') {
			// A candidate is a lexical match or an embedded row; the two ranks are fused.
			expect(render(semantic.success.predicate).sql).toContain('or "record_embedding" is not null');
			const ordering = render(semantic.success.ordering);
			expect(ordering.sql).toContain('<=>');
			expect(ordering.sql).toContain('1.0 / (60 + rank() over');
			expect(ordering.params).toContain('[0.1,0.2]');
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

	it('masks bounded history and skips the hold revisions in it', () => {
		const patches: ReadonlyArray<HistoryPatch> = [
			{
				sequence: 1,
				operation: 'create',
				snapshot: { id: 'o1', public: 'a', secret: 'x' },
				createdAt: '2026-01-01',
				approvalId: null
			},
			{
				sequence: 2,
				operation: 'hold',
				snapshot: { id: 'o1', public: 'a', secret: 'x' },
				createdAt: '2026-01-02',
				approvalId: 'req-1'
			},
			{
				sequence: 3,
				operation: 'update',
				snapshot: { public: 'b' },
				createdAt: '2026-01-02',
				approvalId: 'req-1'
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

describe('declared similarity search', () => {
	it('reaches the declared index only for its /<index> command and ranks by its own column', async () => {
		const context = {
			collection: 'formulations',
			fields: searchedFields,
			searchDocumentColumn: SEARCH_DOCUMENT_COLUMN
		} as const;
		let embedded = 0;
		let targets = 0;
		const embed = async () => {
			embedded += 1;
			return [0.1];
		};
		const nearest = async (index: string, target: Readonly<Record<string, unknown>>) => {
			targets += 1;
			expect(index).toBe('colour');
			return { column: 'lab_vector', operator: '<->' as const, probe: [Number(target['l']), 0, 0] };
		};
		const plan = await prepareSearchPlan('/colour {"l": 62.4}', context, embed, nearest);
		expect(Result.isSuccess(plan) && plan.success.mode).toBe('nearest');
		expect(targets).toBe(1);
		expect(embedded).toBe(0);
		if (Result.isSuccess(plan) && plan.success.mode === 'nearest') {
			const query = render(plan.success.ordering);
			expect(query.sql).toContain('"lab_vector" <-> ');
			expect(query.params).toContain('[62.4,0,0]');
		}
		const absent = await prepareSearchPlan('/colour {}', context, embed);
		expect(Result.isFailure(absent)).toBe(true);
		const malformed = await prepareSearchPlan('/colour sixty', context, embed, nearest);
		expect(Result.isFailure(malformed) && malformed.failure.message).toContain('JSON object');
		const rejected = await prepareSearchPlan('/colour {}', context, embed, async () => {
			throw new Error('L* is a lightness from 0 to 100.');
		});
		expect(Result.isFailure(rejected) && rejected.failure.message).toBe(
			'L* is a lightness from 0 to 100.'
		);
	});

	it('narrows by the equalities the target states, beside the ranking', async () => {
		const context = {
			collection: 'formulations',
			fields: searchedFields,
			searchDocumentColumn: SEARCH_DOCUMENT_COLUMN
		} as const;
		const plan = await prepareSearchPlan(
			'/colour {"l": 1, "base": "abs"}',
			context,
			async () => [0.1],
			async () => ({
				column: 'lab_vector',
				operator: '<->' as const,
				probe: [1, 0, 0],
				where: { base_material_id: 'abs', retired_at: null }
			})
		);
		expect(Result.isSuccess(plan) && plan.success.mode).toBe('nearest');
		if (Result.isSuccess(plan) && plan.success.mode === 'nearest') {
			const predicate = render(plan.success.predicate);
			expect(predicate.sql).toContain('"base_material_id" = ');
			expect(predicate.params).toContain('abs');
			expect(predicate.sql).toContain('"retired_at" is null');
		}
	});
});
