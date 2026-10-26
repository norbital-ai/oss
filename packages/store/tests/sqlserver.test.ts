import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { compileSqlServer, SqlServerRequest, type SqlServerProjection } from '../src/sqlserver.ts';

const source: SqlServerProjection = {
	table: { schema: 'ledger', name: 'entries' },
	key: 'code',
	columns: ['code', 'amount', 'active'],
	decimals: ['amount'],
	deleted: { field: 'active', value: false },
	where: { direction: 'outbound' }
};
const from = '0x00000000000000000001',
	to = '0x0000000000000000000a';

it('binds snapshot/CDC positions and keeps current rows, tombstones and delete policy in the native page', () => {
	const snapshot = compileSqlServer({ op: 'cdcPage', source, after: "A'; --" });
	expect(snapshot.parameters).toEqual({ p0: "A'; --", p1: 'outbound' });
	expect(snapshot.statement).toContain('CONVERT(varchar(100),[amount])');
	expect(snapshot.statement).toContain('__key COLLATE Latin1_General_BIN2 > @p0');
	const changes = { from, to, seq: from, operation: 4 };
	const page = compileSqlServer({ op: 'cdcPage', source, after: 'A', changes });
	expect(page.statement).toContain('LEFT JOIN [ledger].[entries] current_row');
	expect(page.statement).toContain('FROM cdc.[ledger_entries_CT] retained');
	expect(page.statement).toContain('__$operation>@after_op');
	expect(page.statement).toContain(
		'ORDER BY __$start_lsn,__$seqval,__$operation,__event_key COLLATE Latin1_General_BIN2'
	);
	expect(Object.values(page.parameters)).toEqual(['A', false, 'outbound', from, to, from, 4]);
	expect(
		compileSqlServer({ op: 'cdcPage', source, after: 'B', changes: { ...changes, to: from } })
			.statement
	).toBe(page.statement);
});

it('compiles immutable header, XML children, approval and exact receipt as one serializable native program', () => {
	const operation = Schema.decodeUnknownSync(SqlServerRequest)({
		op: 'insertOnce',
		table: { schema: 'ledger', name: 'document' },
		identity: { id: 'id', key: 'local_key', hash: 'fingerprint' },
		key: "key'; --",
		hash: 'sealed',
		resource: 'ledger:document:key',
		values: { status: 'draft', created_at: { generated: 'now' } },
		children: [
			{
				table: { schema: 'ledger', name: 'line' },
				parent: 'document',
				xml: '<items/>',
				path: '/items/item',
				columns: {
					quantity: { attribute: 'quantity', type: { kind: 'decimal', precision: 18, scale: 3 } }
				}
			}
		],
		after: { schema: 'ledger', name: 'approve' }
	});
	const program = compileSqlServer(operation);
	expect(program.transaction).toBe('serializable');
	expect(program.maxRows).toBe(1);
	expect(program.statement).toContain("@LockOwner='Transaction',@LockTimeout=5000");
	expect(program.statement).toContain('[fingerprint]<>@p1');
	expect(program.statement).toContain("item.value('(@quantity)[1]','decimal(18,3)')");
	expect(program.statement).toContain('EXEC [ledger].[approve] @remote');
	expect(program.statement).toContain('SELECT [id] AS remote,[fingerprint] AS hash');
	expect(Object.values(program.parameters)).toEqual([
		"key'; --",
		'sealed',
		'ledger:document:key',
		'<items/>',
		'draft'
	]);
});

it('quotes external identifiers and binds procedure arguments as data', () => {
	expect(
		Schema.is(SqlServerRequest)({
			op: 'call',
			procedure: { schema: 'remote', name: 'submit' },
			arguments: { 'reference; RETURN': 'value' }
		})
	).toBe(false);
	const program = compileSqlServer({
		op: 'call',
		procedure: { schema: 'remote', name: 'a]b' },
		arguments: { reference: "'; DROP TABLE ledger; --" }
	});
	expect(program.procedure).toBe('[remote].[a]]b]');
	expect(program.parameters).toEqual({ reference: "'; DROP TABLE ledger; --" });
});
