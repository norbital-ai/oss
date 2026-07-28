import { Dialog as SheetPrimitive } from 'bits-ui';
import SheetContentFullScreenHandler from './sheet-content-full-screen-handler.svelte';
import SheetContentResize from './sheet-content-resize.svelte';
import Content from './sheet-content.svelte';
import Description from './sheet-description.svelte';
import Footer from './sheet-footer.svelte';
import Header from './sheet-header.svelte';
import Overlay from './sheet-overlay.svelte';
import Title from './sheet-title.svelte';
export { sheetVariants, type Side } from './sheet-variants.js';

const Root = SheetPrimitive.Root;
const Close = SheetPrimitive.Close;
const Trigger = SheetPrimitive.Trigger;
const Portal = SheetPrimitive.Portal;

export {
	Close,
	Content,
	Description,
	Footer,
	Header,
	Overlay,
	Portal,
	Root,
	//
	Root as Sheet,
	Close as SheetClose,
	Content as SheetContent,
	SheetContentFullScreenHandler,
	SheetContentResize,
	Description as SheetDescription,
	Footer as SheetFooter,
	Header as SheetHeader,
	Overlay as SheetOverlay,
	Portal as SheetPortal,
	Title as SheetTitle,
	Trigger as SheetTrigger,
	Title,
	Trigger
};
