declare module 'https://esm.sh/@thatopen/components@3.4.6?deps=three@0.185.1,@thatopen/fragments@3.4.6,web-ifc@0.0.77,camera-controls@3.1.2' {
	export const Components: import('./ifc_viewer.types.js').ViewerComponentsModule['Components'];
	export const Worlds: import('./ifc_viewer.types.js').ViewerComponentsModule['Worlds'];
	export const SimpleScene: import('./ifc_viewer.types.js').ViewerComponentsModule['SimpleScene'];
	export const SimpleRenderer: import('./ifc_viewer.types.js').ViewerComponentsModule['SimpleRenderer'];
	export const SimpleCamera: import('./ifc_viewer.types.js').ViewerComponentsModule['SimpleCamera'];
	export const Grids: import('./ifc_viewer.types.js').ViewerComponentsModule['Grids'];
	export const FragmentsManager: import('./ifc_viewer.types.js').ViewerComponentsModule['FragmentsManager'];
	export const Raycasters: import('./ifc_viewer.types.js').ViewerComponentsModule['Raycasters'];
}

declare module 'https://esm.sh/@thatopen/components-front@3.4.3?deps=@thatopen/components@3.4.6,@thatopen/fragments@3.4.6,three@0.185.1,web-ifc@0.0.77,camera-controls@3.1.2' {
	export const Highlighter: import('./ifc_viewer.types.js').ViewerFrontendModule['Highlighter'];
}

declare module 'https://esm.sh/@thatopen/fragments@3.4.6?deps=three@0.185.1,web-ifc@0.0.77' {
	export const RenderedFaces: import('./ifc_viewer.types.js').ViewerFragmentsModule['RenderedFaces'];
	export const IfcImporter: import('./ifc_viewer.types.js').ViewerFragmentsModule['IfcImporter'];
}

declare module 'https://esm.sh/three@0.185.1' {
	export const Color: import('./ifc_viewer.types.js').ViewerThreeModule['Color'];
}

declare module 'https://esm.sh/web-ifc@0.0.77' {
	export const IfcAPI: import('./ifc_viewer.types.js').ViewerIfcApiConstructor;
}
