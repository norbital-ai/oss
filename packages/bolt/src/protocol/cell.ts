// The cell (compute model §14), `@norbital-ai/bolt/cell`: this release's HOST_API run inside an isolate. `pnpm build`
// bundles this module into `build/cell.js`, one classic script that, evaluated, defines `globalThis.__bolt_cell`. The
// kernel calls `open` with its system calls; from then on it reaches HOST_API only through membrane messages, and
// every execution here — a call, a system call's answer, a timer, a stream's chunk — is an entry it starts and meters.
// The globals come first: they are installed before any engine module evaluates.
import { cellGlobals } from './cell-globals.ts';
import { HOST_API } from './host-api.ts';
import { CELL_ABI_VERSION, membrane, type Answer, type Message } from './membrane.ts';

export { CELL_ABI_VERSION };

/** The kernel's system calls, each a synchronous host function (`log` is fire and forget). */
export type Kernel = {
	/** A membrane message to the kernel; a call's answer when the kernel answered it at once. */
	readonly send: (message: Message) => Answer;
	/** Arms timer `id`: in `ms` the kernel enters `fire(id)`, billed to the unit that armed it. */
	readonly timer: (id: number, ms: number) => void;
	readonly clear: (id: number) => void;
	/** Fresh random bytes from the host's CSPRNG. */
	readonly random: (bytes: number) => Uint8Array<ArrayBuffer>;
	readonly log: (level: string, line: string) => void;
};
/** What `open` answers: the marshalled HOST_API, and the cell's two entries. */
export type CellEnd = {
	/** HOST_API in its wire form; `cookieSite` is its two answers, `[insecure, secure]`. */
	readonly api: unknown;
	/** One membrane message from the kernel. */
	readonly receive: (message: unknown) => Answer;
	/** A timer the kernel fired. */
	readonly fire: (timer: number) => void;
};

const open = (kernel: Kernel): CellEnd => {
	if (cellGlobals === undefined)
		throw new Error('A cell opens only in a bare isolate, over the cell globals');
	cellGlobals.attach(kernel);
	const side = membrane((message) => kernel.send(message));
	return {
		api: side.encode({
			...HOST_API,
			cookieSite: [HOST_API.cookieSite(false), HOST_API.cookieSite(true)]
		}),
		receive: side.receive,
		fire: cellGlobals.fire
	};
};
Object.defineProperty(globalThis, '__bolt_cell', {
	value: Object.freeze({ abi: CELL_ABI_VERSION, contract: HOST_API.contract, open }),
	configurable: true
});
