// @ts-nocheck -- DOM harness compiled by the existing test loader.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { mount, flushSync, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./json-schema-harness.svelte');
const settle = async () => { for (let i = 0; i < 3; i++) { flushSync(); await tick(); } };
const mounted = [];
test.afterEach(() => { for (const [app, target] of mounted.splice(0)) { unmount(app); target.remove(); } localStorage.clear(); });
async function show(props) {
	const target = document.createElement('div'); document.body.append(target);
	const changes = []; const app = mount(Harness, { target, props: { ...props, changed: (v) => changes.push(v) } });
	mounted.push([app, target]); await settle(); return { target, changes };
}
test('Editor JSON schema entry point edits nested inputs without deleting unknown properties', async () => {
	const { target, changes } = await show({ editor: true, schema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string' }, notes: { type: 'string' } } }, initial: { name: 'A', legacy: 9 }, errors: new Map([['input.notes', 'Required by payroll']]) });
	const input = target.querySelector('[data-schema-field="input.name"] input'); input.value = 'B'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
	assert.deepEqual(changes.at(-1), { name: 'B', legacy: 9 });
	assert.ok(target.textContent.includes('Required by payroll'));
	const optional = target.querySelector('[data-section$="Additional details"]'); assert.equal(optional.getAttribute('data-open'), 'true');
});
const pick = async (trigger: HTMLElement, value: string) => { trigger.click(); flushSync(); await tick(); document.querySelector(`[role=option][data-value="${value}"] button`)!.click(); flushSync(); };
test('numeric and boolean enum options retain JSON types', async () => {
	for (const [type, values] of [['integer', [1, 2]], ['boolean', [false, true]]]) {
		const { target, changes } = await show({ schema: { type, enum: values }, initial: values[0] });
		await pick(target.querySelector('[role=combobox]')!, '1'); await settle(); assert.equal(changes.at(-1), values[1]);
	}
});
test('array add/remove limits and readonly controls work', async () => {
	const schema = { type: 'array', items: { type: 'string', default: 'new' }, minItems: 1, maxItems: 2 };
	const { target, changes } = await show({ schema, initial: ['existing'] });
	assert.equal([...target.querySelectorAll('button')].find((b) => b.textContent.includes('Remove')).disabled, true);
	[...target.querySelectorAll('button')].find((b) => b.textContent.includes('Add')).click(); await settle(); assert.deepEqual(changes.at(-1), ['existing', 'new']);
	assert.equal([...target.querySelectorAll('button')].find((b) => b.textContent.includes('Add')).disabled, true);
	const read = await show({ schema, initial: ['existing'], readonly: true }); assert.equal(read.target.querySelectorAll('input,textarea,select').length, 0); assert.equal([...read.target.querySelectorAll('button')].some((b) => /Add|Remove/.test(b.textContent)), false);
});
test('tenant custom shapes and built-in phone resolve through the host registry', async () => {
	const tenant = await show({ schema: { type: 'string', 'x-norbital': { datatype: 'reference' } }, initial: 'A', host: { customFields: { reference: { shape: { kind: 'text' } } } } });
	assert.ok(tenant.target.querySelector('input'));
	const phone = await show({ schema: { type: 'string', 'x-norbital': { datatype: 'phone' } }, initial: '+6591234567' }); assert.ok(phone.target.querySelector('input'));
});

test('dynamic-property errors open their section and array scalar controls have associated labels', async () => {
 const extra = await show({schema:{type:'object',properties:{name:{type:'string'}}}, initial:{extra:4}, errors:new Map([['input.extra','Use a positive amount']])});
 const section=extra.target.querySelector('[data-section$=":properties"]'); assert.equal(section.getAttribute('data-open'),'true'); assert.ok(section.textContent.includes('Use a positive amount'));
 const array=await show({schema:{type:'array',items:{type:'string'}},initial:['one']}); const input=array.target.querySelector('input'); assert.ok(array.target.querySelector(`label[for="${input.id}"]`));
});
test('unknown custom datatypes preserve their initial JSON in the raw editor', async () => {
 const {target}=await show({schema:{type:'object','x-norbital':{datatype:'missing'}},initial:{reference:'kept'}}); assert.ok(target.textContent.includes('kept'));
});
