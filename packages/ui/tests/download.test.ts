import { browser } from './view-fixture.ts';
import { Effect } from 'effect';
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach, vi } from '@effect/vitest';
import { strFromU8, unzipSync } from 'fflate';
import { downloadTextFiles } from '../src/utilities/download.ts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function capture() {
	const blobs: Blob[] = [],
		clicks: string[] = [],
		revoked: string[] = [];
	vi.spyOn(URL, 'createObjectURL').mockImplementation(
		(blob: Parameters<typeof URL.createObjectURL>[0]) => {
			assert.ok(blob instanceof Blob);
			blobs.push(blob);
			return 'blob:download-probe';
		}
	);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((href: string) => revoked.push(href));
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		assert.ok(this.isConnected);
		clicks.push(this.download);
	});
	vi.useFakeTimers({ toFake: ['setTimeout'] });
	return { blobs, clicks, revoked };
}

it.live('a 91-document export uses one download and retains every UTF-8 file in its ZIP', () =>
	Effect.gen(function* () {
		const probe = capture();
		const documents = Array.from({ length: 91 }, (_, index) => ({
			name: `payslip-${index}.csv`,
			content: `\uFEFFname,amount\n员工 ${index},${index}.00`
		}));
		downloadTextFiles(documents, 'payroll.zip');
		assert.deepEqual(probe.clicks, ['payroll.zip']);
		const blob = probe.blobs[0];
		assert.ok(blob);
		assert.equal(blob.type, 'application/zip');
		const files = unzipSync(new Uint8Array(yield* browser(() => blob.arrayBuffer())));
		assert.equal(Object.keys(files).length, 91);
		for (const document of documents) {
			const bytes = files[document.name];
			assert.ok(bytes);
			assert.deepEqual(bytes, new TextEncoder().encode(document.content));
		}
		assert.deepEqual(probe.revoked, []);
		yield* browser(() => vi.advanceTimersByTimeAsync(1000));
		assert.deepEqual(probe.revoked, ['blob:download-probe']);
	})
);

it.live('batch exports preserve duplicate filenames and flatten paths safely', () =>
	Effect.gen(function* () {
		const probe = capture();
		downloadTextFiles(
			[
				{ name: '../report.csv', content: 'one' },
				{ name: 'C:\\folder\\report.csv', content: 'two' },
				{ name: 'report (2).csv', content: 'three' },
				{ name: '..', content: 'four' }
			],
			'../../exports.zip'
		);
		assert.deepEqual(probe.clicks, ['exports.zip']);
		const blob = probe.blobs[0];
		assert.ok(blob);
		const files = unzipSync(new Uint8Array(yield* browser(() => blob.arrayBuffer())));
		assert.deepEqual(
			Object.values(files).map((bytes) => strFromU8(bytes)),
			['one', 'two', 'three', 'four']
		);
		assert.equal(Object.keys(files).length, 4);
		assert.ok(
			Object.keys(files).every(
				(name) => !name.includes('/') && !name.includes('\\') && name !== '..'
			)
		);
	})
);

it.live('one CSV remains a direct download with its BOM and releases its URL after the click', () =>
	Effect.gen(function* () {
		const probe = capture();
		downloadTextFiles([{ name: 'rows.csv', content: '\uFEFFname\r\n中文' }]);
		assert.deepEqual(probe.clicks, ['rows.csv']);
		const blob = probe.blobs[0];
		assert.ok(blob);
		assert.equal(blob.type, 'text/csv;charset=utf-8');
		assert.deepEqual(
			new Uint8Array(yield* browser(() => blob.arrayBuffer())),
			new TextEncoder().encode('\uFEFFname\r\n中文')
		);
		assert.equal(document.querySelector('a[download="rows.csv"]'), null);
		yield* browser(() => vi.advanceTimersByTimeAsync(999));
		assert.deepEqual(probe.revoked, []);
		yield* browser(() => vi.advanceTimersByTimeAsync(1));
		assert.deepEqual(probe.revoked, ['blob:download-probe']);
	})
);

it.live('a refused click preserves its error and still removes the link and releases its URL', () =>
	Effect.gen(function* () {
		const probe = capture();
		const failure = new Error('download refused');
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
			throw failure;
		});
		assert.throws(
			() => downloadTextFiles([{ name: 'rows.csv', content: 'name' }]),
			(error) => error === failure
		);
		assert.equal(document.querySelector('a[download="rows.csv"]'), null);
		assert.deepEqual(probe.revoked, []);
		yield* browser(() => vi.advanceTimersByTimeAsync(1000));
		assert.deepEqual(probe.revoked, ['blob:download-probe']);
	})
);
