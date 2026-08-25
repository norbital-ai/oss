/**
 * The suppression census: each tag counted, multiples accumulated, variants kept distinct,
 * and near-misses left alone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { countSuppressions } from '../../build/metrics/index.js';

test('every dialect tallies under its own name', () => {
	const source = [
		'// repository-health:allow EXP1 -- reviewed',
		'/* eslint-disable */',
		'// eslint-disable-next-line no-console',
		'console.log(1); // eslint-disable-line no-console',
		'// @ts-ignore',
		'// @ts-expect-error',
		'# noqa: E501',
		'/* nosonar */'
	].join('\n');
	const census = countSuppressions(source);
	assert.equal(census.total, 8);
	assert.equal(census.tags['repository-health:allow'], 1);
	assert.equal(census.tags['eslint-disable'], 1);
	assert.equal(census.tags['eslint-disable-next-line'], 1);
	assert.equal(census.tags['eslint-disable-line'], 1);
	assert.equal(census.tags['@ts-ignore'], 1);
	assert.equal(census.tags['@ts-expect-error'], 1);
	assert.equal(census.tags.noqa, 1);
	assert.equal(census.tags.nosonar, 1);
});

test('multiples accumulate and variants do not bleed into the plain tag', () => {
	const source = `// @ts-ignore
// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const a = 1 as any;
// eslint-disable-next-line
const b = 2;
// eslint-disabled and @ts-ignored match nothing`;
	const census = countSuppressions(source);
	assert.equal(census.total, 4);
	assert.equal(census.tags['@ts-ignore'], 2);
	assert.equal(census.tags['eslint-disable-next-line'], 2);
	assert.equal(census.tags['eslint-disable'], undefined);
});

test('an empty file suppresses nothing', () => {
	const census = countSuppressions('export const clean = true;\n');
	assert.deepEqual(census, { total: 0, tags: {} });
});
