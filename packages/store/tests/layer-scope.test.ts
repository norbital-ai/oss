// Read layers in one statement (decision 3): every level is scoped and masked by its PATH under the root
// (`Scope.rows(path)`, `Scope.mask(path, field)`), never by the layer model's own name; a model without `read` is only
// a layer; a relation the root does not declare is refused, and a layer exposes only its declared fields.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { catalogOf, compile, read, type Scope } from '../src/index.ts';
import { shop } from './fixture.ts';

const cat = catalogOf(shop, {
	order: {
		read: {
			order: { fields: 'all' },
			'order.customer': { fields: ['name'] },
			'order.lines': { fields: 'all' }
		}
	}
});

describe('read layers by path', () => {
	it.effect('scopes and masks each level by its path under the root, never by its model', () =>
		Effect.gen(function* () {
			const rows: string[] = [],
				masks: string[] = [];
			const scope: Scope = {
				rows: (path) => {
					rows.push(path);
					return path === 'order.lines' ? [{ t: 'const', value: false }] : undefined;
				},
				mask: (path, field) => {
					masks.push(`${path}.${field}`);
					return path === 'order.customer' && field === 'name'
						? { t: 'const', value: false }
						: undefined;
				}
			};
			const ir = yield* read(cat, 'order', { with: { customer: true, lines: true }, limit: 10 });
			const { sql } = yield* compile(cat, ir, { scope });
			expect(new Set(rows)).toEqual(new Set(['order', 'order.customer', 'order.lines']));
			expect(masks.some((m) => m.startsWith('order.customer.'))).toBe(true);
			expect(
				[...rows, ...masks].some((p) => p.startsWith('customer') || p.startsWith('line'))
			).toBe(false);
			// the layer's own arm (false) filters its rows, inside the root's statement
			expect(sql.text).toContain('false');
		})
	);

	it.effect(
		'refuses a layer model as a root, an undeclared relation and a field the layer does not expose',
		() =>
			Effect.gen(function* () {
				expect((yield* Effect.flip(read(cat, 'customer', {}))).code).toBe('invalid');
				const undeclared = yield* read(cat, 'order', { with: { notes: true } }).pipe(
					Effect.flatMap((ir) =>
						compile(cat, ir, { scope: { rows: () => undefined, mask: () => undefined } })
					),
					Effect.flip
				);
				expect(undeclared.code).toBe('invalid');
				const hidden = yield* read(cat, 'order', {
					with: { customer: { select: { credit: true } } }
				}).pipe(
					Effect.flatMap((ir) =>
						compile(cat, ir, { scope: { rows: () => undefined, mask: () => undefined } })
					),
					Effect.flip
				);
				expect(hidden.code).toBe('invalid');
			})
	);
});
