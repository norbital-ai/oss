// libheif-js ships no declarations for its bundled wasm build: the part image-worker.ts uses.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
	type HeifImage = {
		get_width(): number;
		get_height(): number;
		free(): void;
		display(
			target: { data: Uint8ClampedArray; width: number; height: number },
			done: (result: { data: Uint8ClampedArray } | null) => void
		): void;
	};
	type Libheif = {
		ready?: Promise<void>;
		heif_context_free(pointer: number): void;
		HeifDecoder: new () => {
			decode(bytes: Uint8Array): HeifImage[];
			decoder: number | null;
		};
	};
	const createLibheif: () => Libheif | Promise<Libheif>;
	export default createLibheif;
}
