import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { compile_sql_server, SqlServerRequest, type SqlServerProjection } from '../src/sqlserver.ts';

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

it('refuses retired limits and operation names at the strict external request boundary', () => {
	const decode = Schema.decodeUnknownResult(SqlServerRequest, { onExcessProperty: 'error' });
	const request = { op: 'read', table: { schema: 'ledger', name: 'entries' }, columns: ['code'] };
	expect(decode({ ...request, max_rows: 10 })._tag).toBe('Success');
	for (const input of [
		{ ...request, maxRows: 10 },
		{ ...request, max_rows: 10, maxRows: 20 },
		{ ...request, max_rows: 0 },
		{ ...request, max_rows: 1001 },
		{ op: 'cdcPage', source, after: 'A' },
		{ op: 'cdc_page', source, after: 'A', changes: { from: 'bad-lsn', to, seq: from, operation: 4 } }
	]) expect(decode(input)._tag).toBe('Failure');
});

it('binds snapshot/CDC positions and keeps current rows, tombstones and delete policy in the native page', () => {
	const snapshot = compile_sql_server({ op: 'cdc_page', source, after: "A'; --" });
	expect(snapshot.parameters).toEqual({ p0: "A'; --", p1: 'outbound' });
	expect(snapshot.statement).toContain('CONVERT(varchar(100),[amount])');
	expect(snapshot.statement).toContain('__key COLLATE Latin1_General_BIN2 > @p0');
	const changes = { from, to, seq: from, operation: 4 };
	const page = compile_sql_server({ op: 'cdc_page', source, after: 'A', changes });
	expect(page.statement).toContain('LEFT JOIN [ledger].[entries] current_row');
	expect(page.statement).toContain('FROM cdc.[ledger_entries_CT] retained');
	expect(page.statement).toContain('__$operation>@after_op');
	expect(page.statement).toContain(
		'ORDER BY __$start_lsn,__$seqval,__$operation,__event_key COLLATE Latin1_General_BIN2'
	);
	expect(Object.values(page.parameters)).toEqual(['A', false, 'outbound', from, to, from, 4]);
	expect(
		compile_sql_server({ op: 'cdc_page', source, after: 'B', changes: { ...changes, to: from } })
			.statement
	).toBe(page.statement);
});

it('compiles immutable header, XML children, approval and exact receipt as one serializable native program', () => {
	const operation = Schema.decodeUnknownSync(SqlServerRequest)({
		op: 'insert_once',
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
	const program = compile_sql_server(operation);
	expect(program.transaction).toBe('serializable');
	expect(program.max_rows).toBe(1);
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
	const program = compile_sql_server({
		op: 'call',
		procedure: { schema: 'remote', name: 'a]b' },
		arguments: { reference: "'; DROP TABLE ledger; --" }
	});
	expect(program.procedure).toBe('[remote].[a]]b]');
	expect(program.parameters).toEqual({ reference: "'; DROP TABLE ledger; --" });
});
