/// <reference types="node" />
// `bolt check`'s declaration evaluation (rule 2) on a worker thread: its own V8 isolate, stripped to the ECMAScript
// globals a guest starts from, then the guest prelude, the frozen clock and the module. It answers the serialized
// declarations and the evaluation's CPU. Compile-time only: guests at run time take the host's `guests` facility.
import { parentPort, workerData } from 'node:worker_threads';
import { Schema } from 'effect';
// the hooks alone: this worker starts per evaluation
import { assetHook, digest, randomStream } from '@norbital-ai/bolt/guest-hooks';
import type { EvaluateOutput } from './index.ts';

const Input = Schema.Struct({
	prelude: Schema.String,
	freeze: Schema.String,
	script: Schema.String,
	serialize: Schema.String,
	assets: Schema.optionalKey(Schema.Record(Schema.String, Schema.Uint8Array))
});
/** What `bolt check` hands the worker: the texts it evaluates in order, and the guest's `?bytes` assets. */
export type EvaluateInput = typeof Input.Type;

const port = parentPort;
if (port === null) throw new Error('evaluate-worker runs on a worker thread');
const input = Schema.decodeUnknownSync(Input)(workerData);
const answer = (output: typeof EvaluateOutput.Type) => port.postMessage(output);
const cpu = process.threadCpuUsage.bind(process),
	turn = setImmediate;
// a fresh guest context holds only these: what Node adds would let a declaration pass here and fail in the guest
const ECMASCRIPT = new Set([
	'Object',
	'Function',
	'Array',
	'Number',
	'parseFloat',
	'parseInt',
	'Infinity',
	'NaN',
	'undefined',
	'Boolean',
	'String',
	'Symbol',
	'Date',
	'Promise',
	'RegExp',
	'Error',
	'AggregateError',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'globalThis',
	'JSON',
	'Math',
	'Intl',
	'ArrayBuffer',
	'Atomics',
	'Uint8Array',
	'Int8Array',
	'Uint16Array',
	'Int16Array',
	'Uint32Array',
	'Int32Array',
	'BigUint64Array',
	'BigInt64Array',
	'Uint8ClampedArray',
	'Float32Array',
	'Float64Array',
	'DataView',
	'Map',
	'BigInt',
	'Set',
	'Iterator',
	'WeakMap',
	'WeakSet',
	'Proxy',
	'Reflect',
	'FinalizationRegistry',
	'WeakRef',
	'decodeURI',
	'decodeURIComponent',
	'encodeURI',
	'encodeURIComponent',
	'escape',
	'unescape',
	'eval',
	'isFinite',
	'isNaN',
	'console',
	'SuppressedError',
	'DisposableStack',
	'AsyncDisposableStack',
	'Float16Array',
	'SharedArrayBuffer',
	'WebAssembly'
]);
for (const name of Reflect.ownKeys(globalThis))
	if (typeof name === 'string' && !ECMASCRIPT.has(name)) Reflect.deleteProperty(globalThis, name);

const evaluate = (text: string): unknown => (0, eval)(text);
const ms = (used: NodeJS.CpuUsage) => (used.user + used.system) / 1000;
// A fixed workload beside the module, on the same thread: its CPU shows how fast this thread ran (a busy machine's
// slower core or contended cache inflates both alike), so `bolt check` can grade the module at reference speed.
const reference = () => {
	const from = cpu();
	let n = 0;
	for (let i = 0; i < 10_000; i++)
		n += JSON.parse(JSON.stringify({ i, name: `row${i}`, tags: [i, i + 1], nested: { at: i } }))
			.name.length;
	return n > 0 ? ms(cpu(from)) : 0;
};
try {
	const prelude = evaluate(`(function ($0, $1, $2, $3) {\n${input.prelude}\n})`);
	if (typeof prelude !== 'function') throw new Error('the guest prelude is not a function');
	prelude(() => {}, randomStream('bolt:check'), digest, assetHook(input.assets));
	evaluate(input.freeze);
	const before = reference();
	const from = cpu();
	Reflect.set(globalThis, '__ns', evaluate(input.script));
	// the module's microtasks drain before its CPU is read, as a guest turn drains them
	await new Promise((resolve) => turn(resolve));
	const cpuMs = ms(cpu(from));
	answer({
		json: String(evaluate(input.serialize)),
		cpuMs,
		referenceMs: Math.min(before, reference())
	});
} catch (error) {
	answer({
		error:
			error instanceof Error
				? error.message
				: typeof error === 'object' && error !== null && 'message' in error
					? String(error.message)
					: String(error)
	});
}
