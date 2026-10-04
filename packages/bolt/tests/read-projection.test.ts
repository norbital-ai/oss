import { describe, expect, it } from 'vitest';
import { applyReadProjection, assertReadSubset } from '../src/engine/query/projection.ts';

describe('native JSON read projection', () => {
 it('withholds fields and rows while preserving actual identities and order', () => {
  const original = [{ id: 'a', public: 0, private: 100 }, { id: 'b', public: false }, { id: 'c', public: '' }];
  expect(() => assertReadSubset(original, [{ id: 'a', public: 0 }, { id: 'c', public: '' }])).not.toThrow();
  expect(() => assertReadSubset(original, [])).not.toThrow();
 });
 it('rejects additions, changed values, removed identities, duplication and reordering', () => {
  const original = [{ id: 'a', amount: 0 }, { id: 'b', amount: 2 }];
  for (const output of [
   [{ id: 'a', amount: 1 }], [{ amount: 0 }], [{ id: 'a', extra: true }],
   [{ id: 'b' }, { id: 'a' }], [{ id: 'a' }, { id: 'a' }], [{ id: 'unknown' }]
  ]) expect(() => assertReadSubset(original, output)).toThrow();
 });
 it('protects nonprojected columns and supports complete withholding of selected JSON', () => {
  const original = { id: 'native', revision: 3, facts: { salary: 0, private: false }, label: 'original' };
  expect(applyReadProjection(original, { facts: { salary: 0 } }, ['facts'])).toEqual({ ...original, facts: { salary: 0 } });
  expect(applyReadProjection(original, {}, ['facts'])).toEqual({ id: 'native', revision: 3, label: 'original' });
  for (const output of [{ id: 'replacement' }, { revision: 4 }, { extra: true }])
   expect(() => applyReadProjection(original, output, ['facts'])).toThrow();
  expect(original.facts).toEqual({ salary: 0, private: false });
 });
 it('preserves null, false, zero and empty text distinctly', () => {
  for (const value of [null, false, 0, '']) {
   expect(() => assertReadSubset(value, value)).not.toThrow();
   for (const other of [null, false, 0, ''].filter(other => other !== value))
    expect(() => assertReadSubset(value, other)).toThrow();
  }
 });
});
