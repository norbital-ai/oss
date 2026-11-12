import { Dialog as DialogPrimitive } from 'bits-ui';

import Content from './dialog-content.svelte';
import Description from './dialog-description.svelte';
import Footer from './dialog-footer.svelte';
import Header from './dialog-header.svelte';
import Overlay from './dialog-overlay.svelte';
import Title from './dialog-title.svelte';
import Root from './dialog.svelte';
import ContentPrimitive from './dialog-primitive-content.svelte';
import OverlayPrimitive from './dialog-primitive-overlay.svelte';

const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;
const Portal = DialogPrimitive.Portal;

export {
	Close,
	Content,
	ContentPrimitive,
	Description,
	Footer,
	Header,
	Overlay,
	OverlayPrimitive,
	Portal,
	Root,
	Title,
	Trigger
};
