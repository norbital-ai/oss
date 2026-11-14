// `query_all` reads every page of a typed read: a root with a `next` cursor is read again from it, a finished root is
// not read again, and the rows arrive in page order.
import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import { CursorValue } from '@norbital-ai/store';
import { id_of, query_all, type ReadAnswer, type ReadRequest } from '../src/index.ts';

const offsets = new Map<string, number>();
const cursor = (offset: number) => {
	const next = Schema.decodeUnknownSync(CursorValue)(Base64Url.encode(JSON.stringify({ h: 'test', k: [String(offset)] })));
	offsets.set(next, offset);
	return next;
};
const at = (node: object) => ('after' in node && typeof node.after === 'string' ? (offsets.get(node.after) ?? -1) : 0);
const customers = ['a', 'b', 'c', 'd', 'e'].map((name, n) => ({
	id: Schema.decodeUnknownSync(id_of('customers'))(`019a0000-0000-7000-8000-00000000000${n}`),
	name
}));
const request = { customers: { fields: ['name'], limit: 2 }, orders: { fields: ['number'], limit: 2 } } as const;
type Request = typeof request;

it.effect('query_all follows each root’s cursor until every root is read', () =>
	Effect.gen(function* () {
		const asked: string[] = [];
		const query = (read: ReadRequest<Request>) =>
			Effect.sync((): ReadAnswer<Request> => {
				asked.push(Object.keys(read).join());
				const from = at(read.customers);
				const rows = customers.slice(from, from + 2);
				return {
					customers: { rows, next: from + 2 < customers.length ? cursor(from + 2) : null, total: customers.length },
					orders: { rows: [], next: null, total: 0 }
				};
			});
		const all = yield* query_all(query, request);
		expect(all.customers.map((row) => row.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(all.orders).toEqual([]);
		// the first read names both roots, every later one only the root that still pages
		expect(asked).toEqual(['customers,orders', 'customers', 'customers']);
	})
);
