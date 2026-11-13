import { Result, Schema } from 'effect';
import { ReadFailed } from '../decl/errors.ts';
import type { Json, Wired } from '@norbital-ai/store/wire';
import { read_wire, typed_aggregate_answer, typed_read_answer, type AggregateArguments, type ReadCatalog } from '../protocol/read-answer.ts';
import { HistoryRevisionSchema } from '../protocol/record-contracts.ts';
import type { Measures, ReadRequest, ReadRequestBase } from '../decl/ctx.ts';
import type { Is, ReadableName } from '../decl/names.ts';
import type { Query } from './page-bolt.ts';

type ReadSource = <A>(method: 'query' | 'aggregate' | 'history', args: readonly Wired[], schema: () => Schema.Decoder<A>) => Query<A>;

/** Browser reads and server-rendered reads share the same input-linked result types and actual decoders. */
export const page_reads = (catalog: ReadCatalog | undefined, source: ReadSource) => {
	const metadata = () => {
		if (catalog === undefined) throw new ReadFailed({ code: 'protocol', message: 'This client has no read answer catalog.' });
		return catalog;
	};
	return {
		query: <const R extends ReadRequestBase>(request: ReadRequest<R>) =>
			source('query', [read_wire(request)], () => typed_read_answer(metadata(), request)),
		aggregate: <const C extends string, const A extends AggregateArguments & Measures<C>>(model: Is<C, ReadableName>, options: A) =>
			source('aggregate', [model, read_wire(options)], () => typed_aggregate_answer(metadata(), model, options)),
		history: (model: string, id: string, options: { at?: Json; output?: string } = {}) =>
			source('history', [model, id, options], () => Schema.Array(HistoryRevisionSchema))
	};
};

/** Reads cross only through their request-linked or native answer decoder, including initial and patched images. */
export function readValue<A>(schema: () => Schema.Decoder<A>, value: unknown): Result.Result<A, ReadFailed> {
	try {
		return Result.mapError(
			Schema.decodeUnknownResult(schema(), { onExcessProperty: 'error' })(value),
			(error) => new ReadFailed({ code: 'protocol', message: `The host returned an invalid read answer: ${error.message}` })
		);
	} catch (error) {
		return Result.fail(error instanceof ReadFailed ? error : new ReadFailed({ code: 'protocol', message: 'The read answer schema is invalid.' }));
	}
}
