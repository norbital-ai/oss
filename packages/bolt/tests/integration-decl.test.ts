import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { check } from '../src/compiler/check/index.ts';

// `bolt check` evaluates definitions in the isolate: the attached bodies reach the load checks only as markers, so a
// declared feed without its body is refused there exactly as `load` refuses it.
it.effect(
	'bolt check reads integration definitions, their attached bodies, envoys and connections from the isolate',
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
const books = integration('books', { description: 'Books', driver: 'sqlserver',
	feeds: { lines: { into: 'lines', key: ['code'], cron: '@hourly' } }, outbound: { push: { from: 'orders', via: 'ledger' } } });
books.outbound('push', { build: (order) => ({ number: order.number }), run: function* (_, ctx) { return { id: ctx.key }; } });
export default books;`
			);
			writeFileSync(
				join(root, 'src/data/model/+lines.model.ts'),
				`import { model } from '../../../../../../src/index.ts';
export default model({ description: 'Ledger lines', label: 'code', key: ['source', 'code'], fields: { code: { kind: 'text' } } });`
			);
			mkdirSync(join(root, 'src/data/collection/lines'), { recursive: true });
			writeFileSync(
				join(root, 'src/data/collection/lines/+collection.ts'),
				`import { collection } from '../../../../../../../src/index.ts';
export default collection('lines', { read: { fields: 'all' } });`
			);
			const relationships = join(root, 'src/data/+relationship.ts');
			writeFileSync(
				relationships,
				readFileSync(relationships, 'utf8').replace(
					/,?\s*}\);\s*$/,
					`,
	'lines.source': { to: 'sys_integration', where: { integration: { eq: 'books' } } },
	'orders.ledger': { to: 'sys_integration', optional: true, where: { integration: { eq: 'books' } } },
});`
				)
			);
			const result = yield* check(root, { bolt: '../../../../src/index.ts' });
			expect(result.errors.map((e) => `${e.code} ${e.message}`)).toEqual([
				"load/missing-body src/integration/books/+integration.ts: feed 'lines' has no body: attach books.feed('lines', { read })"
			]);
			const m = result.manifest;
			expect(m).toBeDefined();
			if (m === undefined) throw new Error('Expected checked integration manifest');
			expect(Object.keys(m.integrations).sort()).toEqual(['books', 'erp', 'mail']);
			expect(m.integrations['mail']).toEqual({
				description: 'The notices mailbox',
				driver: 'email',
				feeds: { notices: { into: 'notices', from: 'messages', key: ['message_id'] } }
			});
			expect(m.integrations['books']?.outbound).toEqual({
				push: { from: 'orders', via: 'ledger' }
			});
			expect(m.connections).toEqual({
				erp: { integration: 'erp' },
				support: { integration: 'mail', envoy: 'desk' }
			});
			expect(m.envoys['desk']).toEqual({
				name: 'Norbius',
				audience: 'private',
				policies: ['sales_rep'],
				delegation: 'disabled',
				task: 'Answer order questions.'
			});
			const names = readFileSync(join(root, '.norbital/names.ts'), 'utf8');
			expect(names).toContain('fed: { "lines": "books.lines"; "notices": "mail.notices" };');
		}).pipe(Effect.provide(NodeServices.layer)),
	30_000
);
