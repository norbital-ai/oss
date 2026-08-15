import assert from 'node:assert/strict';
import test from 'node:test';

test('the published runtime binding includes its executable schema exports', async () => {
	const binding = await import('../build/runtime/binding.js');
	for (const name of ['AiMessageSchema', 'AiToolSpecSchema', 'AiChatResultSchema'] as const) {
		assert.equal(typeof binding[name]?.parse, 'function', `${name} was omitted from the build`);
	}
});
