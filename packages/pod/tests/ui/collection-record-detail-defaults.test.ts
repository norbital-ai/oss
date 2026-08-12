import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL(
	'../../../ui/src/collection-table/collection-table.svelte',
	import.meta.url
);

describe('default record detail surface', () => {
	it('keeps business fields compact and separates system metadata', async () => {
		const source = await readFile(sourceUrl, 'utf8');

		expect(source).toMatch(/rawRecordFields.*!isSystemField/);
		expect(source).toMatch(/rawSystemFields.*isSystemField/);
		expect(source).toMatch(/<Grid as="dl" minimum="compact"/);
		expect(source).toMatch(/<details class="group rounded-lg border bg-muted\/15">/);
		expect(source).not.toMatch(/definition\.fields as field[\s\S]*rounded-lg border bg-card p-4/);
	});

	it('summarizes approval status and keeps actions in the same surface', async () => {
		const source = await readFile(sourceUrl, 'utf8');

		expect(source).toMatch(/approvalRequest\.status === 'ONGOING'/);
		expect(source).toMatch(/table\.approvalRequestId/);
		expect(source).toMatch(/processApproval\('APPROVED'\)/);
		expect(source).toMatch(/processApproval\('REJECTED'\)/);
		expect(source).toMatch(/onclick=\{openChangeRequest\}/);
	});
});
