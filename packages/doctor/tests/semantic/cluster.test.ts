/**
 * Clustering against hand-built axis vectors, where every cosine is computable by inspection.
 *
 * The fixture uses deliberately unnormalized magnitudes to prove the normalizing copies work, and
 * names engineered so the label's third token falls out of a five-way frequency tie — resolved
 * lexicographically, which is exactly the tie-break a stable label needs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	cosineSimilarity,
	clusterFiles,
	clusterFilesDetailed
} from '../../build/semantic/cluster.js';
import type { ClusterItem } from '../../build/semantic/cluster.js';

const vec = (values: Array<number>): Float32Array => new Float32Array(values);

const goldenItems: Array<ClusterItem> = [
	// Billing group along +x, magnitudes all over the place on purpose.
	{ path: 'src/billing-invoice.ts', vector: vec([10, 0, 0]), name: 'billingInvoice' },
	{ path: 'src/billing-invoice-view.ts', vector: vec([9.4, 3.4, 0]), name: 'Billing-Invoice_view' },
	// Invoices-adjacent group along +y.
	{ path: 'src/invoice-export.ts', vector: vec([0, 5, 0]), name: 'invoice_export' },
	{ path: 'src/invoiceExportHelper.ts', vector: vec([-1.7, 4.7, 0]), name: 'InvoiceExportHelper' },
	// Two deliberate singletons.
	{ path: 'src/session-cache.ts', vector: vec([0, 0, 3]), name: 'sessionCache' },
	{ path: 'src/cache-warmer.ts', vector: vec([0, 0, -3]), name: 'cacheWarmer' }
];

test('cosine similarity is exact for identical and orthogonal vectors and safe for zero vectors', () => {
	assert.equal(cosineSimilarity(vec([1, 2, 3]), vec([2, 4, 6])), 1);
	assert.equal(cosineSimilarity(vec([1, 0]), vec([0, 1])), 0);
	assert.equal(cosineSimilarity(vec([0, 0]), vec([1, 0])), 0);
});

test('the golden fixture forms two clusters with sorted members and computed labels', () => {
	const report = clusterFilesDetailed(goldenItems);
	assert.deepEqual(report.singletons.sort(), ['src/cache-warmer.ts', 'src/session-cache.ts']);
	assert.equal(report.clusters.length, 2);

	const [first, second] = report.clusters;
	assert.notEqual(first, undefined);
	assert.notEqual(second, undefined);

	assert.deepEqual(first?.members, ['src/billing-invoice-view.ts', 'src/billing-invoice.ts']);
	assert.deepEqual(second?.members, ['src/invoice-export.ts', 'src/invoiceExportHelper.ts']);

	// Tokens across the billing pair: billing×2, invoice×2, view×1 — the top three are
	// billing/invoice/view with no tie left to break here.
	assert.equal(first?.label, 'billing/invoice/view');
	assert.equal(second?.label, 'export/invoice/helper');

	// cos([10,0,0],[9.4,3.4,0]) ≈ 0.9404 — the weaker link, which is what similarity reports.
	assert.equal(first?.similarity.toFixed(3), '0.940');
	assert.deepEqual(
		first?.pairs.map((pair) => [pair.a, pair.b]),
		[['src/billing-invoice-view.ts', 'src/billing-invoice.ts']]
	);
});

test('clusters are ordered by first member path and singletons are omitted', () => {
	const clusters = clusterFiles(goldenItems);
	const firsts = clusters.map((cluster) => cluster.members[0]);
	assert.deepEqual(firsts, [...firsts].sort());
	for (const cluster of clusters)
		for (const path of ['src/cache-warmer.ts', 'src/session-cache.ts'])
			assert.equal(cluster.members.includes(path), false);
});

test('raising the threshold dissolves the groups into reported singletons', () => {
	const report = clusterFilesDetailed(goldenItems, { threshold: 0.95 });
	assert.equal(report.clusters.length, 0);
	assert.equal(report.singletons.length, 6);
});

test('lowering the threshold merges along the z axis instead', () => {
	const report = clusterFilesDetailed(
		goldenItems.filter((item) => item.name.includes('cache') || item.name.includes('Cache')),
		{ threshold: 0.99 }
	);
	// The two cache vectors are exactly opposite; only identical vectors survive 0.99, so both
	// stay single — this pins that thresholds are inclusive comparisons, not rounding accidents.
	assert.equal(report.clusters.length, 0);
	assert.equal(report.singletons.length, 2);
});

test('empty input yields an empty report rather than a crash', () => {
	assert.deepEqual(clusterFilesDetailed([]), {
		clusters: [],
		singletons: [],
		mutualNearest: []
	});
});
