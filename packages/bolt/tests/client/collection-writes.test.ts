import { describe, expect, it } from 'vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import { createWorkspaceApiProxy } from '../../src/client/runtime.js';

/**
 * What the browser sends, and what it is entitled to hand back.
 *
 * Two faults lived in the same four lines. The client minted the primary key with
 * `crypto.randomUUID()` and posted it, which made the browser the authority on the identity of a row
 * that did not exist yet — and made a nested write inexpressible, because a child's foreign key
 * names a parent the client has not created. And it returned the caller's own argument with that id
 * stapled on, which is not the record: once a column default, a generated column and a
 * `create.before` hook have run, the row in the database has fields the submission never had and
 * different values in the ones it did.
 *
 * The transport is a stub here on purpose. What is under test is the half of the contract the
 * browser owns — what goes on the wire and what comes off it — and a real database would only make
 * the same two assertions slower and less specific. `wire-create.test.ts` is the other half.
 */
const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

type Sent = { readonly command: string; readonly input: unknown };

type CollectionWriter = {
	readonly create: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly update: (id: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** A client whose transport records what it was asked to post and answers with `answer`. */
const clientAnswering = (answer: unknown) => {
	const sent: Array<Sent> = [];
	const bolt = createBoltClient(scope, {
		command: (command, input) => {
			sent.push({ command, input });
			return Promise.resolve(answer as never);
		}
	});
	const proxy = createWorkspaceApiProxy({ bolt, db: {} });
	const orders = Reflect.get(proxy.db, 'orders') as CollectionWriter;
	return { sent, orders };
};

/** One row as the database holds it: the columns that were posted, plus the ones only it can fill. */
const storedOrder = {
	id: '0f5f0f6e-2c2e-4f3f-9b3a-9b9c9d9e9f00',
	reference: 'ORD-1-normalised',
	status: 'draft',
	row_version: 1,
	created_at: '2026-08-20T00:00:00.000Z'
};

describe('a create from the browser', () => {
	it('posts the values alone, with no id of its own', async () => {
		const { sent, orders } = clientAnswering({ created: true, records: [storedOrder] });

		await orders.create({ reference: 'ORD-1' });

		expect(sent).toHaveLength(1);
		expect(sent[0]?.command).toBe('collections.create');
		expect(sent[0]?.input).toEqual({ collection: 'orders', values: { reference: 'ORD-1' } });
		// Stated separately from the equality above so a future field added to the body cannot make
		// this pass by accident: the point is the absence of `id`, not the exact shape around it.
		expect(Object.keys(sent[0]?.input as object)).not.toContain('id');
	});

	it('returns the stored row rather than the values that were submitted', async () => {
		const { orders } = clientAnswering({ created: true, records: [storedOrder] });

		const record = await orders.create({ reference: 'ORD-1' });

		expect(record).toEqual(storedOrder);
		// The three ways the stored row differs from the submission, named one at a time because each
		// is a separate reason the old return value was wrong.
		expect(record['reference']).toBe('ORD-1-normalised');
		expect(record['status']).toBe('draft');
		expect(record['row_version']).toBe(1);
	});

	it('carries a nested graph to the server untouched', async () => {
		const { sent, orders } = clientAnswering({ created: true, records: [storedOrder] });

		await orders.create({
			reference: 'ORD-1',
			order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
		});

		// The client does not know which keys are relations — only the workspace's declared relations
		// can say that, and they are the server's. So its job is to not lose them.
		expect(sent[0]?.input).toEqual({
			collection: 'orders',
			values: { reference: 'ORD-1', order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }] }
		});
	});

	it('throws rather than inventing a record when the answer carries none', async () => {
		const { orders } = clientAnswering({ created: true });

		// There is no honest fallback here. "The write succeeded and I do not know what it stored" is
		// not a record, and returning the submission in its place is the failure this replaced —
		// silently, into a cache, where it looks exactly like a successful write.
		await expect(orders.create({ reference: 'ORD-1' })).rejects.toThrow(/stored row/);
	});

	it('does not treat a non-record answer as an empty result', async () => {
		const { orders } = clientAnswering({ created: true, records: ['not-a-row'] });

		await expect(orders.create({ reference: 'ORD-1' })).rejects.toThrow(/stored row/);
	});
});

describe('an update from the browser', () => {
	it('answers with the stored row, because an update runs hooks too', async () => {
		const updated = { ...storedOrder, reference: 'ORD-2-normalised', row_version: 2 };
		const { sent, orders } = clientAnswering({ updated: true, records: [updated] });

		const record = await orders.update(storedOrder.id, { reference: 'ORD-2' });

		expect(sent[0]?.input).toEqual({
			collection: 'orders',
			id: storedOrder.id,
			values: { reference: 'ORD-2' }
		});
		expect(record).toEqual(updated);
		// The version the database bumped, which no submission has ever been able to report.
		expect(record['row_version']).toBe(2);
	});

	it('throws when the answer carries no row', async () => {
		const { orders } = clientAnswering({ updated: true, records: [] });

		await expect(orders.update(storedOrder.id, { reference: 'ORD-2' })).rejects.toThrow(
			/stored row/
		);
	});
});
