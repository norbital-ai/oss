import { describe, expect, it, vi } from 'vitest';

/**
 * What a referenced record becomes in the model's window.
 *
 * The end-to-end agent suites prove a turn runs; this file pins the fallback contract, which is
 * the whole point of a mention: a reference that no longer resolves must degrade to prose, never
 * to a failed turn.
 */

const manifest = {
	collections: {
		companies: { collection_name: 'companies', system: null },
		chat_session: { collection_name: 'chat_session', system: true }
	}
};

const rowsByCollection: Record<string, Record<string, unknown>[]> = {
	companies: [
		{
			norbital_id: '0197f2a4-0000-7000-8000-000000000001',
			name: 'Acme Corp',
			status: 'active'
		}
	]
};

let findManyShouldThrow = false;

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantManifest: () => manifest
}));

vi.mock('$lib/server/collection/collection_ops.server.js', () => ({
	findMany: async (
		_ctx: unknown,
		collection: string,
		query: { where?: { norbital_id?: string }; limit?: number }
	) => {
		if (findManyShouldThrow) throw new Error('tenant db unreachable');
		const wanted = query.where?.norbital_id;
		return (rowsByCollection[collection] ?? []).filter(
			(row) => wanted === undefined || row.norbital_id === wanted
		);
	}
}));

const { composeMentionContext } = await import('../../src/server/agent/agent-mentions.server.js');

const ctx = {} as never;
const acme = {
	collection: 'companies',
	recordId: '0197f2a4-0000-7000-8000-000000000001',
	label: 'Acme Corp'
};

describe('mention context for the model window', () => {
	it('returns nothing when nothing was referenced', async () => {
		expect(await composeMentionContext(ctx, [])).toBeNull();
	});

	it('injects the record snapshot the requestor can see', async () => {
		const block = await composeMentionContext(ctx, [acme]);
		expect(block).toContain('<attached-records>');
		expect(block).toContain('collection="companies"');
		expect(block).toContain('label="Acme Corp"');
		expect(block).toContain('"name":"Acme Corp"');
	});

	it('marks a record that is gone or invisible as not-found, and keeps going', async () => {
		const block = await composeMentionContext(ctx, [
			{ ...acme, recordId: '0197f2a4-0000-7000-8000-000000000099', label: 'Vanished Ltd' },
			acme
		]);
		// One dangling reference must not cost the turn the one that did resolve.
		expect(block).toContain('status="not-found"');
		expect(block).toContain('"name":"Acme Corp"');
	});

	it('declines system collections even where the read might be allowed', async () => {
		const block = await composeMentionContext(ctx, [
			{
				collection: 'chat_session',
				recordId: '0197f2a4-0000-7000-8000-000000000002',
				label: 'Some session'
			}
		]);
		expect(block).toContain('status="unavailable"');
		expect(block).not.toContain('user_id');
	});

	it('declines a collection the manifest does not name', async () => {
		const block = await composeMentionContext(ctx, [
			{ collection: 'ghost', recordId: acme.recordId, label: 'Ghost' }
		]);
		expect(block).toContain('status="unavailable"');
	});

	it('a failed read degrades to unavailable rather than failing the turn', async () => {
		findManyShouldThrow = true;
		try {
			const block = await composeMentionContext(ctx, [acme]);
			expect(block).toContain('status="unavailable"');
		} finally {
			findManyShouldThrow = false;
		}
	});

	it('escapes attribute values so a label cannot break out of the block', async () => {
		const block = await composeMentionContext(ctx, [{ ...acme, label: 'Acme "Corp" <Ltd> & Co' }]);
		expect(block).toContain('label="Acme &quot;Corp&quot; &lt;Ltd&gt; &amp; Co"');
		expect(block).not.toContain('"<Ltd>"');
	});
});
