// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const mounted = [];
const settle = async () => { for (let i = 0; i < 3; i++) { flushSync(); await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };
test.afterEach(() => { while (mounted.length) mounted.pop()(); document.body.replaceChildren(); localStorage.clear(); });
async function show(rows) {
 const calls = [];
 const bolt = { locale: 'en', actor: null, t: () => '', approvals: {}, read: () => Promise.resolve({ rows: [], next: null }), fileUrl: () => '' };
 const target = document.createElement('div'); document.body.append(target);
 const app = mount(Harness, { target, props: { bolt, catalog: {}, part: 'table', props: {
  of: rows, columns: ['name'], toolbar: { title: false, search: false, filter: false, export: false, new: false,
   actions: [{ icon: 'lucide:download', name: 'Export selected', requiresSelection: true, run: (ids) => void calls.push(ids) }] }
 } } });
 mounted.push(() => { unmount(app); target.remove(); }); await settle();
 return { target, calls };
}
const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text) || b.getAttribute('aria-label') === text);
async function menu() { document.querySelector('[data-view-actions]').click(); await settle(); }

test('local record projections select stable IDs and pass only the selection to a callback', async () => {
 const { target, calls } = await show([{ id: 'run-a', name: 'January' }, { id: 'run-b', name: 'February' }]);
 assert.equal(target.querySelectorAll('tbody input[type=checkbox]').length, 2);
 await menu(); assert.equal(button('Export selected').disabled, true);
 document.querySelector('[data-view-actions]').click(); await settle();
 const box = target.querySelectorAll('tbody input[type=checkbox]')[1]; box.click(); await settle();
 await menu(); assert.equal(button('Export selected').disabled, false); button('Export selected').click(); await settle();
 assert.deepEqual(calls, [['run-b']]);
});

test('select all uses record IDs rather than local row positions', async () => {
 const { target, calls } = await show([{ id: 'run-a', name: 'January' }, { id: 'run-b', name: 'February' }]);
 target.querySelector('thead input[type=checkbox]').click(); await settle();
 await menu(); button('Export selected').click(); await settle();
 assert.deepEqual(calls, [['run-a', 'run-b']]);
});

for (const [label, rows] of [
 ['missing IDs', [{ name: 'January' }]],
 ['blank IDs', [{ id: ' ', name: 'January' }]],
]) test(`local rows with ${label} cannot manufacture an action selection`, async () => {
 const { target, calls } = await show(rows);
 assert.equal(target.querySelectorAll('tbody input[type=checkbox]').length, 0);
 await menu(); assert.equal(button('Export selected').disabled, true); assert.deepEqual(calls, []);
});
