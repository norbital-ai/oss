// Bank JSON is untrusted until the seed author decodes the fields it reads.
import { expectTypeOf } from '@effect/vitest';
import { Schema } from 'effect';
import type { BankReader } from '../../src/index.ts';

declare const bank: BankReader;
expectTypeOf<ReturnType<BankReader['json']>>().toBeUnknown();
const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
	bank.json('rows.json')
);
expectTypeOf(rows).toEqualTypeOf<ReadonlyArray<{ readonly id: string }>>();
// @ts-expect-error a caller cannot declare the shape of undecoded bank data
bank.json<readonly { id: string }[]>('rows.json');
// @ts-expect-error undecoded JSON does not expose array operations
bank.json('rows.json').map;
