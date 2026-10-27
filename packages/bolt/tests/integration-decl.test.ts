import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { check } from '../src/compiler/check/index.ts';

it.effect(
	'bolt check keeps integration tests and model sync bodies inline',
	() =>
		Effect.gen(function* () {
			const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
			const root = join(fixtures, `integration-${randomUUID()}`);
			cpSync(join(fixtures, 'good'), root, {
				recursive: true,
				filter: (path) => !path.includes('.norbital')
			});
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => rmSync(root, { recursive: true, force: true }))
			);
			mkdirSync(join(root, 'src/integration/books'), { recursive: true });
			writeFileSync(
				join(root, 'src/integration/books/+integration.ts'),
				`import { integration } from '../../../../../../src/index.ts';
export default integration('books', { description: 'Books', driver: 'sqlserver', credential: { connection: { kind: 'text' } },
 test: function* (ctx) { yield* ctx.request({ op: 'values', values: { n: 1 } }); } });`
			);
			mkdirSync(join(root, 'src/data/model/lines'), { recursive: true });
			writeFileSync(
				join(root, 'src/data/model/lines/+model.ts'),
				`import { model } from '../../../../../../../src/index.ts';
export default model('lines', { description: 'Ledger lines', label: 'code', key: ['source', 'code'],
 fields: { code: { kind: 'text' }, source: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'books' } } } },
 read: 'all', syncs: { ledger: { with: 'books', every: '1h',
  read: function* () { return { rows: [], more: false }; },
  write: function* ({ row }) { return { $id: row.code }; }
 } } });`
			);
			const result = yield* check(root, { bolt: '../../../../src/index.ts' });
			expect(result.errors.map((error) => `${error.code} ${error.message}`)).toEqual([]);
			const manifest = result.manifest;
			if (manifest === undefined) throw new Error('Expected checked integration manifest');
			expect(Object.keys(manifest.integrations).sort()).toEqual(['books', 'erp', 'mail']);
			expect(manifest.integrations['mail']).toEqual({
				description: 'The notices mailbox',
				driver: 'email'
			});
			expect(manifest.exposures['lines']?.syncs?.['ledger']).toEqual({
				with: 'books',
				every: '1h',
				read: true,
				write: true
			});
			expect(manifest.relationships['lines.source']).toEqual({
				to: 'sys_integration',
				where: { integration: { eq: 'books' } }
			});
			expect(manifest.connections).toEqual({
				erp: { integration: 'erp' },
				support: { integration: 'mail', envoy: 'desk' }
			});
			const names = readFileSync(join(root, '.norbital/names.ts'), 'utf8');
			expect(names).toContain('"ledger"');
			expect(names).toContain('"read": true');
			expect(names).toContain('"write": true');
			expect(names).not.toContain('typeof import');
		}).pipe(Effect.provide(NodeServices.layer)),
	30_000
);
