import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clientSource = fileURLToPath(new URL('../../src/ui/state/client.ts', import.meta.url));

describe('client bulk write', () => {
	it('createMany, updateMany, and import are one admit; export does not loop leftover', async () => {
		const source = await readFile(clientSource, 'utf8');
		expect(source).toMatch(/async function postBulkWriteOnce/);
		expect(source).not.toMatch(/async function composeBulkWriteRecords/);
		expect(source).not.toMatch(/remaining = remaining\.slice\(result\.records\.length\)/);
		expect(source).not.toMatch(/offset = result\.nextOffset/);
		expect(source).toMatch(/postBulkWriteOnce\('collections\/createMany'/);
		expect(source).toMatch(/postBulkWriteOnce\('collections\/updateMany'/);
		expect(source).toMatch(/importPipeline: \(input\) => postBulkWriteOnce\('collections\/import'/);
		expect(source).toMatch(/exportPipeline: async \(input\) => \{/);
		expect(source).toMatch(/post\('collections\/export'/);
		expect(source).not.toMatch(/for \(;;\)/);
		expect(source).not.toMatch(/priorSlice/);
		const remote = await readFile(
			fileURLToPath(new URL('../../src/remote/collection.remote.ts', import.meta.url)),
			'utf8'
		);
		expect(remote).toMatch(/This function could not finish the export/);
		expect(remote).toMatch(/if \(page\.nextCursor != null\)/);
	});
});
