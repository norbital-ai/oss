// The cell ABI: a release's HOST_API evaluated in an isolate of the host's (`build/cell.js`, defining
// `globalThis.__bolt_cell`), reached only through membrane messages.
import type { Answer, Message } from './membrane.ts';

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
	/** HOST_API in its wire form; `cookie_site` is its two answers, `[insecure, secure]`. */
	readonly api: unknown;
	/** One membrane message from the kernel. */
	readonly receive: (message: unknown) => Answer;
	/** A timer the kernel fired. */
	readonly fire: (timer: number) => void;
};
