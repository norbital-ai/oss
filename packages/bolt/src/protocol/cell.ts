// The cell, `@norbital-ai/bolt/cell`: this release's HOST_API run inside an isolate. `pnpm build`
// bundles this module into `build/cell.js`, one classic script that, evaluated, defines `globalThis.__bolt_cell`. The
// kernel calls `open` with its system calls; from then on it reaches HOST_API only through membrane messages, and
// every execution here — a call, a system call's answer, a timer, a stream's chunk — is an entry it starts and meters.
// The globals come first: they are installed before any engine module evaluates.
import { cellGlobals } from './cell-globals.ts';
import { HOST_API } from './host-api.ts';
import { CELL_ABI_VERSION, membrane, type CellEnd, type Kernel } from '@norbital-ai/host-api';

const open = (kernel: Kernel): CellEnd => {
	if (cellGlobals === undefined)
		throw new Error('A cell opens only in a bare isolate, over the cell globals');
	cellGlobals.attach(kernel);
	const side = membrane((message) => kernel.send(message));
	return {
		api: side.encode({
			...HOST_API,
			cookie_site: [HOST_API.cookie_site(false), HOST_API.cookie_site(true)]
		}),
		receive: side.receive,
		fire: cellGlobals.fire
	};
};
Object.defineProperty(globalThis, '__bolt_cell', {
	value: Object.freeze({ abi: CELL_ABI_VERSION, contract: HOST_API.contract, open }),
	configurable: true
});
