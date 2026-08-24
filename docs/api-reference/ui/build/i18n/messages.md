[**Norbital API Reference v0.0.1**](../../../README.md)

***

[Norbital API Reference](/docs/api-reference/README.md) / ui/build/i18n/messages

# ui/build/i18n/messages

## Type Aliases

<a id="uikeys"></a>

### UiKeys

```ts
type UiKeys = KeysOf<typeof uiMessages>;
```

Defined in: packages/ui/build/i18n/messages/index.d.ts:1312

The typed key union of the ui catalog, for `useI18n<UiKeys>()`.

## Variables

<a id="uimessages"></a>

### uiMessages

```ts
const uiMessages: object;
```

Defined in: packages/ui/build/i18n/messages/index.d.ts:9

The complete `@norbital-ai/ui` catalog: English source of truth plus the
Chinese pair, with compile-time key parity.

The spread merge keeps each namespace file a single owner, so parallel
migration passes can extend a namespace without touching this file.

#### Type Declaration

<a id="en"></a>

##### en

```ts
readonly en: object;
```

###### en.common.add

```ts
readonly common.add: "Add";
```

###### en.common.apply

```ts
readonly common.apply: "Apply";
```

###### en.common.back

```ts
readonly common.back: "Back";
```

###### en.common.buildItemsStepByStep

```ts
readonly common.buildItemsStepByStep: "Build items step by step…";
```

###### en.common.buildItemStepByStep

```ts
readonly common.buildItemStepByStep: "Build item step by step…";
```

###### en.common.cancel

```ts
readonly common.cancel: "Cancel";
```

###### en.common.clear

```ts
readonly common.clear: "Clear";
```

###### en.common.clearAllOptions

```ts
readonly common.clearAllOptions: "Clear all options";
```

###### en.common.clearSelection

```ts
readonly common.clearSelection: "Clear selection";
```

###### en.common.clickNewToStart

```ts
readonly common.clickNewToStart: "Click \"New\" to start.";
```

###### en.common.close

```ts
readonly common.close: "Close";
```

###### en.common.complete

```ts
readonly common.complete: "Complete";
```

###### en.common.confirm

```ts
readonly common.confirm: "Confirm";
```

###### en.common.continue

```ts
readonly common.continue: "Continue";
```

###### en.common.copy

```ts
readonly common.copy: "Copy";
```

###### en.common.create

```ts
readonly common.create: "Create";
```

###### en.common.createOption

```ts
readonly common.createOption: "Create \"{query}\"";
```

###### en.common.createToStart

```ts
readonly common.createToStart: "Create a selection to get started.";
```

###### en.common.customFallback

```ts
readonly common.customFallback: "[Custom]";
```

###### en.common.cut

```ts
readonly common.cut: "Cut";
```

###### en.common.delete

```ts
readonly common.delete: "Delete";
```

###### en.common.deselectAll

```ts
readonly common.deselectAll: "Deselect all";
```

###### en.common.dismiss

```ts
readonly common.dismiss: "Dismiss";
```

###### en.common.done

```ts
readonly common.done: "Done";
```

###### en.common.download

```ts
readonly common.download: "Download";
```

###### en.common.edit

```ts
readonly common.edit: "Edit";
```

###### en.common.emptyGetStarted

```ts
readonly common.emptyGetStarted: "Get started by creating your first item.";
```

###### en.common.enterFullScreen

```ts
readonly common.enterFullScreen: "Open full screen";
```

###### en.common.errorLabel

```ts
readonly common.errorLabel: "Error: {message}";
```

###### en.common.existingSelections

```ts
readonly common.existingSelections: "Existing selections";
```

###### en.common.exitFullScreen

```ts
readonly common.exitFullScreen: "Exit full screen";
```

###### en.common.filter

```ts
readonly common.filter: "Filter";
```

###### en.common.finish

```ts
readonly common.finish: "Finish";
```

###### en.common.itemSelected

```ts
readonly common.itemSelected: "Item selected";
```

###### en.common.itemsSelected

```ts
readonly common.itemsSelected: "{count} items selected";
```

###### en.common.less

```ts
readonly common.less: "Less";
```

###### en.common.loading

```ts
readonly common.loading: "Loading…";
```

###### en.common.loadingOptions

```ts
readonly common.loadingOptions: "Loading options…";
```

###### en.common.missingKeys

```ts
readonly common.missingKeys: "Missing: {keys}";
```

###### en.common.more

```ts
readonly common.more: "More";
```

###### en.common.new

```ts
readonly common.new: "New";
```

###### en.common.next

```ts
readonly common.next: "Next";
```

###### en.common.nextStep

```ts
readonly common.nextStep: "Go to next step";
```

###### en.common.no

```ts
readonly common.no: "No";
```

###### en.common.noItemsFound

```ts
readonly common.noItemsFound: "No items found";
```

###### en.common.noItemsSelected

```ts
readonly common.noItemsSelected: "No items selected";
```

###### en.common.noOptions

```ts
readonly common.noOptions: "No options available";
```

###### en.common.noResults

```ts
readonly common.noResults: "No results";
```

###### en.common.noResultsFor

```ts
readonly common.noResultsFor: "No results found for \"{query}\"";
```

###### en.common.noResultsFound

```ts
readonly common.noResultsFound: "No results found";
```

###### en.common.noSelection

```ts
readonly common.noSelection: "No selection";
```

###### en.common.noSelectionsYet

```ts
readonly common.noSelectionsYet: "No selections yet.";
```

###### en.common.notAvailable

```ts
readonly common.notAvailable: "Not available";
```

###### en.common.oneItemSelected

```ts
readonly common.oneItemSelected: "1 item selected";
```

###### en.common.open

```ts
readonly common.open: "Open";
```

###### en.common.optional

```ts
readonly common.optional: "Optional";
```

###### en.common.options

```ts
readonly common.options: "Options";
```

###### en.common.partial

```ts
readonly common.partial: "Partial";
```

###### en.common.partialSelection

```ts
readonly common.partialSelection: "Partial selection";
```

###### en.common.paste

```ts
readonly common.paste: "Paste";
```

###### en.common.previous

```ts
readonly common.previous: "Previous";
```

###### en.common.previousStep

```ts
readonly common.previousStep: "Go to previous step";
```

###### en.common.print

```ts
readonly common.print: "Print";
```

###### en.common.redo

```ts
readonly common.redo: "Redo";
```

###### en.common.refresh

```ts
readonly common.refresh: "Refresh";
```

###### en.common.remove

```ts
readonly common.remove: "Remove";
```

###### en.common.removeOption

```ts
readonly common.removeOption: "Remove {label}";
```

###### en.common.removeSelection

```ts
readonly common.removeSelection: "Remove selection";
```

###### en.common.required

```ts
readonly common.required: "Required";
```

###### en.common.reset

```ts
readonly common.reset: "Reset";
```

###### en.common.retry

```ts
readonly common.retry: "Retry";
```

###### en.common.save

```ts
readonly common.save: "Save";
```

###### en.common.search

```ts
readonly common.search: "Search";
```

###### en.common.searchOptions

```ts
readonly common.searchOptions: "Search options…";
```

###### en.common.searchTree

```ts
readonly common.searchTree: "Search tree";
```

###### en.common.select

```ts
readonly common.select: "Select";
```

###### en.common.selectAll

```ts
readonly common.selectAll: "Select all";
```

###### en.common.selectAllOptions

```ts
readonly common.selectAllOptions: "Select all options";
```

###### en.common.selected

```ts
readonly common.selected: "{count} selected";
```

###### en.common.selectedLabel

```ts
readonly common.selectedLabel: "Selected: {label}";
```

###### en.common.selectedOfTotal

```ts
readonly common.selectedOfTotal: "{selected} of {total} selected";
```

###### en.common.selection

```ts
readonly common.selection: "Selection";
```

###### en.common.selections

```ts
readonly common.selections: "Selections";
```

###### en.common.selectOption

```ts
readonly common.selectOption: "Select option";
```

###### en.common.selectOrCreateToStart

```ts
readonly common.selectOrCreateToStart: "Select or create a selection to get started.";
```

###### en.common.showingCount

```ts
readonly common.showingCount: "Showing {count} of {total}";
```

###### en.common.stepOf

```ts
readonly common.stepOf: "Step {current} of {total}";
```

###### en.common.submit

```ts
readonly common.submit: "Submit";
```

###### en.common.undo

```ts
readonly common.undo: "Undo";
```

###### en.common.unknown

```ts
readonly common.unknown: "Unknown";
```

###### en.common.unknownFallback

```ts
readonly common.unknownFallback: "[Unknown]";
```

###### en.common.upload

```ts
readonly common.upload: "Upload";
```

###### en.common.view

```ts
readonly common.view: "View";
```

###### en.common.viewDetails

```ts
readonly common.viewDetails: "View details";
```

###### en.common.yes

```ts
readonly common.yes: "Yes";
```

###### en.dataRenderer.absent

```ts
readonly dataRenderer.absent: "Not provided";
```

###### en.dataRenderer.accepts

```ts
readonly dataRenderer.accepts: "Accepts: {types}";
```

###### en.dataRenderer.addAmount

```ts
readonly dataRenderer.addAmount: "Add amount";
```

###### en.dataRenderer.addDateTime

```ts
readonly dataRenderer.addDateTime: "Add date and time";
```

###### en.dataRenderer.addFile

```ts
readonly dataRenderer.addFile: "Add file";
```

###### en.dataRenderer.addFirstFile

```ts
readonly dataRenderer.addFirstFile: "Add first file";
```

###### en.dataRenderer.addMonetaryValue

```ts
readonly dataRenderer.addMonetaryValue: "Add a monetary value to get started.";
```

###### en.dataRenderer.addPhoneNumber

```ts
readonly dataRenderer.addPhoneNumber: "Add phone number";
```

###### en.dataRenderer.addProgress

```ts
readonly dataRenderer.addProgress: "Add progress";
```

###### en.dataRenderer.addRange

```ts
readonly dataRenderer.addRange: "Add new range";
```

###### en.dataRenderer.addRating

```ts
readonly dataRenderer.addRating: "Add rating";
```

###### en.dataRenderer.addRow

```ts
readonly dataRenderer.addRow: "Add row";
```

###### en.dataRenderer.addTime

```ts
readonly dataRenderer.addTime: "Add time";
```

###### en.dataRenderer.addValue

```ts
readonly dataRenderer.addValue: "Add value";
```

###### en.dataRenderer.booleanValue

```ts
readonly dataRenderer.booleanValue: "Boolean value {index}";
```

###### en.dataRenderer.cancelUpload

```ts
readonly dataRenderer.cancelUpload: "Cancel upload";
```

###### en.dataRenderer.channelAdd

```ts
readonly dataRenderer.channelAdd: "Add channel";
```

###### en.dataRenderer.channelAddress

```ts
readonly dataRenderer.channelAddress: "Address";
```

###### en.dataRenderer.channelPrimary

```ts
readonly dataRenderer.channelPrimary: "Primary";
```

###### en.dataRenderer.channelRemove

```ts
readonly dataRenderer.channelRemove: "Remove channel";
```

###### en.dataRenderer.channelsEmpty

```ts
readonly dataRenderer.channelsEmpty: "No channels recorded yet.";
```

###### en.dataRenderer.channelType

```ts
readonly dataRenderer.channelType: "Channel type";
```

###### en.dataRenderer.channelVerified

```ts
readonly dataRenderer.channelVerified: "Verified";
```

###### en.dataRenderer.chooseYear

```ts
readonly dataRenderer.chooseYear: "Choose year";
```

###### en.dataRenderer.clearAll

```ts
readonly dataRenderer.clearAll: "Clear all";
```

###### en.dataRenderer.clearAllDates

```ts
readonly dataRenderer.clearAllDates: "Clear all selected dates";
```

###### en.dataRenderer.clearRating

```ts
readonly dataRenderer.clearRating: "Clear rating";
```

###### en.dataRenderer.clearSelection

```ts
readonly dataRenderer.clearSelection: "Clear selection";
```

###### en.dataRenderer.copied

```ts
readonly dataRenderer.copied: "Copied";
```

###### en.dataRenderer.copyValue

```ts
readonly dataRenderer.copyValue: "Copy value";
```

###### en.dataRenderer.countryCallingCode

```ts
readonly dataRenderer.countryCallingCode: "Country calling code";
```

###### en.dataRenderer.dateSummaryMany

```ts
readonly dataRenderer.dateSummaryMany: "{count} dates ({first} to {second})";
```

###### en.dataRenderer.dateSummaryTwo

```ts
readonly dataRenderer.dateSummaryTwo: "{first} and {second}";
```

###### en.dataRenderer.emailSend

```ts
readonly dataRenderer.emailSend: "Send email";
```

###### en.dataRenderer.endTime

```ts
readonly dataRenderer.endTime: "End Time";
```

###### en.dataRenderer.false

```ts
readonly dataRenderer.false: "No";
```

###### en.dataRenderer.fileCount

```ts
readonly dataRenderer.fileCount: "{count} files";
```

###### en.dataRenderer.filePreview

```ts
readonly dataRenderer.filePreview: "File Preview";
```

###### en.dataRenderer.fileProviderMissing

```ts
readonly dataRenderer.fileProviderMissing: "File editing is unavailable because no workspace upload provider is configured.";
```

###### en.dataRenderer.filesSelected

```ts
readonly dataRenderer.filesSelected: "{count} files selected";
```

###### en.dataRenderer.fileTooLarge

```ts
readonly dataRenderer.fileTooLarge: "File \"{name}\" ({size}) exceeds the {maxSize} limit";
```

###### en.dataRenderer.fileTypeNotAllowed

```ts
readonly dataRenderer.fileTypeNotAllowed: "File type \"{type}\" is not allowed for \"{name}\"";
```

###### en.dataRenderer.fileUploadInput

```ts
readonly dataRenderer.fileUploadInput: "File upload input";
```

###### en.dataRenderer.geocoded

```ts
readonly dataRenderer.geocoded: "Geocoded";
```

###### en.dataRenderer.geoProviderMissing

```ts
readonly dataRenderer.geoProviderMissing: "Geolocation editing is unavailable because no geolocation provider is configured.";
```

###### en.dataRenderer.gpsCompatible

```ts
readonly dataRenderer.gpsCompatible: "GPS Compatible";
```

###### en.dataRenderer.invalidJson

```ts
readonly dataRenderer.invalidJson: "Enter valid JSON before saving.";
```

###### en.dataRenderer.invalidPhone

```ts
readonly dataRenderer.invalidPhone: "Enter a valid phone number.";
```

###### en.dataRenderer.latitude

```ts
readonly dataRenderer.latitude: "Lat";
```

###### en.dataRenderer.locationDetails

```ts
readonly dataRenderer.locationDetails: "Location Details";
```

###### en.dataRenderer.locationMap

```ts
readonly dataRenderer.locationMap: "Location map";
```

###### en.dataRenderer.locationTypeAddress

```ts
readonly dataRenderer.locationTypeAddress: "Address";
```

###### en.dataRenderer.locationTypeBusiness

```ts
readonly dataRenderer.locationTypeBusiness: "Business";
```

###### en.dataRenderer.locationTypeCountry

```ts
readonly dataRenderer.locationTypeCountry: "Country";
```

###### en.dataRenderer.locationTypeLocality

```ts
readonly dataRenderer.locationTypeLocality: "City/Town";
```

###### en.dataRenderer.locationTypePointOfInterest

```ts
readonly dataRenderer.locationTypePointOfInterest: "Point of Interest";
```

###### en.dataRenderer.locationTypePolitical

```ts
readonly dataRenderer.locationTypePolitical: "Political Area";
```

###### en.dataRenderer.longitude

```ts
readonly dataRenderer.longitude: "Lon";
```

###### en.dataRenderer.mapOf

```ts
readonly dataRenderer.mapOf: "Map of {location}";
```

###### en.dataRenderer.matrixRows

```ts
readonly dataRenderer.matrixRows: "Matrix rows";
```

###### en.dataRenderer.maxFilePlural

```ts
readonly dataRenderer.maxFilePlural: "Max {count} files • {size} limit";
```

###### en.dataRenderer.maxFileSingular

```ts
readonly dataRenderer.maxFileSingular: "Max {count} file • {size} limit";
```

###### en.dataRenderer.maxFilesReached

```ts
readonly dataRenderer.maxFilesReached: "Cannot add \"{name}\": maximum {count} files allowed";
```

###### en.dataRenderer.nextYears

```ts
readonly dataRenderer.nextYears: "Show next years";
```

###### en.dataRenderer.noAmountsConfigured

```ts
readonly dataRenderer.noAmountsConfigured: "No amounts configured";
```

###### en.dataRenderer.noAmountsSelected

```ts
readonly dataRenderer.noAmountsSelected: "No amounts selected";
```

###### en.dataRenderer.noCoordinates

```ts
readonly dataRenderer.noCoordinates: "No coordinates";
```

###### en.dataRenderer.noCoordinatesAvailable

```ts
readonly dataRenderer.noCoordinatesAvailable: "No coordinates available";
```

###### en.dataRenderer.noCoordinatesForLocation

```ts
readonly dataRenderer.noCoordinatesForLocation: "No coordinates available for this location";
```

###### en.dataRenderer.noFilesAttached

```ts
readonly dataRenderer.noFilesAttached: "No files attached";
```

###### en.dataRenderer.noFilesSelected

```ts
readonly dataRenderer.noFilesSelected: "No files selected";
```

###### en.dataRenderer.noFilesUploaded

```ts
readonly dataRenderer.noFilesUploaded: "No files uploaded";
```

###### en.dataRenderer.noFileUploaded

```ts
readonly dataRenderer.noFileUploaded: "No file uploaded";
```

###### en.dataRenderer.noLocations

```ts
readonly dataRenderer.noLocations: "No locations selected";
```

###### en.dataRenderer.noProgress

```ts
readonly dataRenderer.noProgress: "No progress";
```

###### en.dataRenderer.noRanges

```ts
readonly dataRenderer.noRanges: "No ranges selected";
```

###### en.dataRenderer.noRating

```ts
readonly dataRenderer.noRating: "No rating";
```

###### en.dataRenderer.noRows

```ts
readonly dataRenderer.noRows: "No rows.";
```

###### en.dataRenderer.null

```ts
readonly dataRenderer.null: "—";
```

###### en.dataRenderer.openInNewTab

```ts
readonly dataRenderer.openInNewTab: "Open in new tab";
```

###### en.dataRenderer.phoneCall

```ts
readonly dataRenderer.phoneCall: "Call";
```

###### en.dataRenderer.phonePlaceholder

```ts
readonly dataRenderer.phonePlaceholder: "Phone number";
```

###### en.dataRenderer.pickDateRanges

```ts
readonly dataRenderer.pickDateRanges: "Pick date range(s)";
```

###### en.dataRenderer.present

```ts
readonly dataRenderer.present: "Present";
```

###### en.dataRenderer.prevYears

```ts
readonly dataRenderer.prevYears: "Show previous years";
```

###### en.dataRenderer.progressIndex

```ts
readonly dataRenderer.progressIndex: "Progress {index}";
```

###### en.dataRenderer.rangePlural

```ts
readonly dataRenderer.rangePlural: "ranges";
```

###### en.dataRenderer.rangeSingular

```ts
readonly dataRenderer.rangeSingular: "range";
```

###### en.dataRenderer.removeAmount

```ts
readonly dataRenderer.removeAmount: "Remove amount";
```

###### en.dataRenderer.removeBooleanValue

```ts
readonly dataRenderer.removeBooleanValue: "Remove boolean value";
```

###### en.dataRenderer.removeDate

```ts
readonly dataRenderer.removeDate: "Remove {date}";
```

###### en.dataRenderer.removeDateTime

```ts
readonly dataRenderer.removeDateTime: "Remove date and time";
```

###### en.dataRenderer.removeLocation

```ts
readonly dataRenderer.removeLocation: "Remove {location}";
```

###### en.dataRenderer.removePhoneNumber

```ts
readonly dataRenderer.removePhoneNumber: "Remove phone number";
```

###### en.dataRenderer.removeProgress

```ts
readonly dataRenderer.removeProgress: "Remove progress value";
```

###### en.dataRenderer.removeRange

```ts
readonly dataRenderer.removeRange: "Remove this range";
```

###### en.dataRenderer.removeRating

```ts
readonly dataRenderer.removeRating: "Remove rating";
```

###### en.dataRenderer.removeRow

```ts
readonly dataRenderer.removeRow: "Remove row";
```

###### en.dataRenderer.removeTime

```ts
readonly dataRenderer.removeTime: "Remove time";
```

###### en.dataRenderer.removeValue

```ts
readonly dataRenderer.removeValue: "Remove value";
```

###### en.dataRenderer.searchCountries

```ts
readonly dataRenderer.searchCountries: "Search countries...";
```

###### en.dataRenderer.searchLocation

```ts
readonly dataRenderer.searchLocation: "Search for a location...";
```

###### en.dataRenderer.searchTarget

```ts
readonly dataRenderer.searchTarget: "Search {target}…";
```

###### en.dataRenderer.seeAllDates

```ts
readonly dataRenderer.seeAllDates: "Click to see all dates";
```

###### en.dataRenderer.selectAmount

```ts
readonly dataRenderer.selectAmount: "Select amount";
```

###### en.dataRenderer.selectDate

```ts
readonly dataRenderer.selectDate: "Select date";
```

###### en.dataRenderer.selectDates

```ts
readonly dataRenderer.selectDates: "Select dates";
```

###### en.dataRenderer.selectDateTime

```ts
readonly dataRenderer.selectDateTime: "Select date and time";
```

###### en.dataRenderer.selectedDatesHeading

```ts
readonly dataRenderer.selectedDatesHeading: "Selected Dates ({count})";
```

###### en.dataRenderer.selectedDatesScroll

```ts
readonly dataRenderer.selectedDatesScroll: "Selected dates";
```

###### en.dataRenderer.selectedRangesHeading

```ts
readonly dataRenderer.selectedRangesHeading: "Selected Ranges ({count})";
```

###### en.dataRenderer.selectedRangesScroll

```ts
readonly dataRenderer.selectedRangesScroll: "Selected ranges";
```

###### en.dataRenderer.selectRecord

```ts
readonly dataRenderer.selectRecord: "Select record…";
```

###### en.dataRenderer.startTime

```ts
readonly dataRenderer.startTime: "Start Time";
```

###### en.dataRenderer.status

```ts
readonly dataRenderer.status: "Status";
```

###### en.dataRenderer.time

```ts
readonly dataRenderer.time: "Time";
```

###### en.dataRenderer.timeRange

```ts
readonly dataRenderer.timeRange: "Time Range";
```

###### en.dataRenderer.true

```ts
readonly dataRenderer.true: "Yes";
```

###### en.dataRenderer.typeToSearchLocations

```ts
readonly dataRenderer.typeToSearchLocations: "Type to search for locations...";
```

###### en.dataRenderer.unknownLocation

```ts
readonly dataRenderer.unknownLocation: "Unknown location";
```

###### en.dataRenderer.uploadFailed

```ts
readonly dataRenderer.uploadFailed: "Upload failed";
```

###### en.dataRenderer.uploadFirstFile

```ts
readonly dataRenderer.uploadFirstFile: "Upload your first file to get started";
```

###### en.dataRenderer.valueIndex

```ts
readonly dataRenderer.valueIndex: "Value {index}";
```

###### en.dataRenderer.valuePlaceholder

```ts
readonly dataRenderer.valuePlaceholder: "Value…";
```

###### en.dataRenderer.viewFile

```ts
readonly dataRenderer.viewFile: "View file";
```

###### en.form.actionsLabel

```ts
readonly form.actionsLabel: "Form actions";
```

###### en.form.addItem

```ts
readonly form.addItem: "Add item";
```

###### en.form.deleting

```ts
readonly form.deleting: "Deleting…";
```

###### en.form.dragToReorder

```ts
readonly form.dragToReorder: "Drag to reorder";
```

###### en.form.dropFiles

```ts
readonly form.dropFiles: "Drop files here or click to browse";
```

###### en.form.dropFilesActive

```ts
readonly form.dropFilesActive: "Drop files to upload";
```

###### en.form.fieldHint

```ts
readonly form.fieldHint: "Hint";
```

###### en.form.fieldHistoryLabel

```ts
readonly form.fieldHistoryLabel: "{label} field history";
```

###### en.form.fieldHistoryRegion

```ts
readonly form.fieldHistoryRegion: "Field history";
```

###### en.form.fieldsRegion

```ts
readonly form.fieldsRegion: "{name} form fields";
```

###### en.form.fileTooLarge

```ts
readonly form.fileTooLarge: "File is too large";
```

###### en.form.fileTypeNotAllowed

```ts
readonly form.fileTypeNotAllowed: "This file type is not allowed";
```

###### en.form.fixErrors

```ts
readonly form.fixErrors: "Fix the highlighted fields before saving.";
```

###### en.form.formMustBeObject

```ts
readonly form.formMustBeObject: "Form values must be an object.";
```

###### en.form.historyLoadFailed

```ts
readonly form.historyLoadFailed: "History could not be loaded.";
```

###### en.form.historyTitle

```ts
readonly form.historyTitle: "{label} history";
```

###### en.form.invalidBoolean

```ts
readonly form.invalidBoolean: "Choose a valid boolean value.";
```

###### en.form.invalidDate

```ts
readonly form.invalidDate: "Enter a valid date";
```

###### en.form.invalidEmail

```ts
readonly form.invalidEmail: "Enter a valid email address";
```

###### en.form.invalidList

```ts
readonly form.invalidList: "Enter a list of values.";
```

###### en.form.invalidNumber

```ts
readonly form.invalidNumber: "Enter a valid number";
```

###### en.form.invalidOption

```ts
readonly form.invalidOption: "Select a valid option.";
```

###### en.form.invalidUrl

```ts
readonly form.invalidUrl: "Enter a valid URL";
```

###### en.form.invalidValue

```ts
readonly form.invalidValue: "Invalid value";
```

###### en.form.loadingForm

```ts
readonly form.loadingForm: "Loading form";
```

###### en.form.maxLength

```ts
readonly form.maxLength: "At most {count} characters";
```

###### en.form.maxValue

```ts
readonly form.maxValue: "Must be at most {value}";
```

###### en.form.minLength

```ts
readonly form.minLength: "At least {count} characters";
```

###### en.form.minValue

```ts
readonly form.minValue: "Must be at least {value}";
```

###### en.form.moveDown

```ts
readonly form.moveDown: "Move down";
```

###### en.form.moveUp

```ts
readonly form.moveUp: "Move up";
```

###### en.form.noSavedChanges

```ts
readonly form.noSavedChanges: "No saved changes yet.";
```

###### en.form.removeItem

```ts
readonly form.removeItem: "Remove item";
```

###### en.form.requiredField

```ts
readonly form.requiredField: "{label} is required";
```

###### en.form.requiredGeneric

```ts
readonly form.requiredGeneric: "This field is required.";
```

###### en.form.save

```ts
readonly form.save: "Save changes";
```

###### en.form.saved

```ts
readonly form.saved: "Saved";
```

###### en.form.savedHistoryLabel

```ts
readonly form.savedHistoryLabel: "{label} saved history";
```

###### en.form.savedSuccessfully

```ts
readonly form.savedSuccessfully: "Saved successfully";
```

###### en.form.saveFailed

```ts
readonly form.saveFailed: "Failed to save. Please try again.";
```

###### en.form.saving

```ts
readonly form.saving: "Saving…";
```

###### en.form.unsaved

```ts
readonly form.unsaved: "Unsaved";
```

###### en.form.unsavedChange

```ts
readonly form.unsavedChange: "Unsaved change";
```

###### en.form.unsavedChanges

```ts
readonly form.unsavedChanges: "You have unsaved changes";
```

###### en.form.unsavedField

```ts
readonly form.unsavedField: "{count} unsaved field";
```

###### en.form.unsavedFields

```ts
readonly form.unsavedFields: "{count} unsaved fields";
```

###### en.form.valuesMustBeObject

```ts
readonly form.valuesMustBeObject: "Validated form values must be an object.";
```

###### en.kanban.addCard

```ts
readonly kanban.addCard: "Add card";
```

###### en.kanban.approvalLoading

```ts
readonly kanban.approvalLoading: "Loading approval payload…";
```

###### en.kanban.boardRegion

```ts
readonly kanban.boardRegion: "Kanban board";
```

###### en.kanban.cardActions

```ts
readonly kanban.cardActions: "Card actions";
```

###### en.kanban.cardCount

```ts
readonly kanban.cardCount: "{count} cards";
```

###### en.kanban.cardMoved

```ts
readonly kanban.cardMoved: "Moved card to {lane}.";
```

###### en.kanban.cardPickedUp

```ts
readonly kanban.cardPickedUp: "Card picked up. Use Left or Right Arrow to move it, or Escape to cancel.";
```

###### en.kanban.columnRegion

```ts
readonly kanban.columnRegion: "{column} column";
```

###### en.kanban.dragCard

```ts
readonly kanban.dragCard: "Drag card";
```

###### en.kanban.emptyLane

```ts
readonly kanban.emptyLane: "No cards in this lane";
```

###### en.kanban.emptyState

```ts
readonly kanban.emptyState: "No cards yet";
```

###### en.kanban.keyboardInstructions

```ts
readonly kanban.keyboardInstructions: "Press Enter to open a card. Press Space to pick it up, then Left or Right Arrow to move it between lanes. Press Escape to cancel.";
```

###### en.kanban.laneClear

```ts
readonly kanban.laneClear: "This lane is clear for the selected view.";
```

###### en.kanban.laneCollapse

```ts
readonly kanban.laneCollapse: "Collapse lane";
```

###### en.kanban.laneExpand

```ts
readonly kanban.laneExpand: "Expand lane";
```

###### en.kanban.lanesRegion

```ts
readonly kanban.lanesRegion: "Kanban lanes";
```

###### en.kanban.loadingBoard

```ts
readonly kanban.loadingBoard: "Loading board";
```

###### en.kanban.moveCancelled

```ts
readonly kanban.moveCancelled: "Card move cancelled.";
```

###### en.kanban.moveLeft

```ts
readonly kanban.moveLeft: "Move left";
```

###### en.kanban.moveRight

```ts
readonly kanban.moveRight: "Move right";
```

###### en.kanban.noLaneDirection

```ts
readonly kanban.noLaneDirection: "No lane in that direction. {lane} is the board edge.";
```

###### en.kanban.noLaneJobs

```ts
readonly kanban.noLaneJobs: "No {lane} jobs";
```

###### en.kanban.scrollForMore

```ts
readonly kanban.scrollForMore: "Scroll for more";
```

###### en.kanban.selectCard

```ts
readonly kanban.selectCard: "Select card";
```

###### en.misc.account

```ts
readonly misc.account: "Account";
```

###### en.misc.activeCollaborators

```ts
readonly misc.activeCollaborators: "Active collaborators";
```

###### en.misc.addFirstProgress

```ts
readonly misc.addFirstProgress: "Add first progress";
```

###### en.misc.addFirstProgressHint

```ts
readonly misc.addFirstProgressHint: "Add your first progress value to get started";
```

###### en.misc.addFirstRating

```ts
readonly misc.addFirstRating: "Add first rating";
```

###### en.misc.addFirstRatingHint

```ts
readonly misc.addFirstRatingHint: "Add your first rating to get started";
```

###### en.misc.addProgress

```ts
readonly misc.addProgress: "Add progress";
```

###### en.misc.addTag

```ts
readonly misc.addTag: "Add new tag";
```

###### en.misc.addTags

```ts
readonly misc.addTags: "Add tags...";
```

###### en.misc.allDay

```ts
readonly misc.allDay: "All day";
```

###### en.misc.appearance

```ts
readonly misc.appearance: "Appearance";
```

###### en.misc.applications

```ts
readonly misc.applications: "Applications";
```

###### en.misc.assigned

```ts
readonly misc.assigned: "{count} assigned";
```

###### en.misc.breadcrumb

```ts
readonly misc.breadcrumb: "Breadcrumb";
```

###### en.misc.browseAndChoose

```ts
readonly misc.browseAndChoose: "Browse and choose where to go.";
```

###### en.misc.calendarGrid

```ts
readonly misc.calendarGrid: "Calendar grid";
```

###### en.misc.calendarNext

```ts
readonly misc.calendarNext: "Next period";
```

###### en.misc.calendarPrevious

```ts
readonly misc.calendarPrevious: "Previous period";
```

###### en.misc.calendarSidebar

```ts
readonly misc.calendarSidebar: "Calendar sidebar";
```

###### en.misc.calendarView

```ts
readonly misc.calendarView: "View: {view}";
```

###### en.misc.cancelledFile

```ts
readonly misc.cancelledFile: "Cancelled {file}";
```

###### en.misc.cellAssignments

```ts
readonly misc.cellAssignments: "{count} assignments on {day} for {resource}";
```

###### en.misc.chartLoading

```ts
readonly misc.chartLoading: "Loading chart";
```

###### en.misc.chartNoData

```ts
readonly misc.chartNoData: "No data available yet";
```

###### en.misc.chartScrollable

```ts
readonly misc.chartScrollable: "Scrollable chart: {title}";
```

###### en.misc.clearButton

```ts
readonly misc.clearButton: "clear";
```

###### en.misc.closeWorkspaceNavigation

```ts
readonly misc.closeWorkspaceNavigation: "Close workspace navigation";
```

###### en.misc.collapseSidebar

```ts
readonly misc.collapseSidebar: "Collapse sidebar";
```

###### en.misc.commandNoResults

```ts
readonly misc.commandNoResults: "No commands found";
```

###### en.misc.commandPlaceholder

```ts
readonly misc.commandPlaceholder: "Type a command or search…";
```

###### en.misc.conversationMessages

```ts
readonly misc.conversationMessages: "Conversation messages";
```

###### en.misc.createOn

```ts
readonly misc.createOn: "Create on {day} for {resource}";
```

###### en.misc.csvParsingWarnings

```ts
readonly misc.csvParsingWarnings: "{count} parsing warning(s) - some data may not display correctly";
```

###### en.misc.csvShowingRows

```ts
readonly misc.csvShowingRows: "Showing first 50 rows of {count} rows";
```

###### en.misc.currentProgress

```ts
readonly misc.currentProgress: "Current Progress";
```

###### en.misc.currentRating

```ts
readonly misc.currentRating: "Current Rating";
```

###### en.misc.dataChart

```ts
readonly misc.dataChart: "Data chart";
```

###### en.misc.day

```ts
readonly misc.day: "Day";
```

###### en.misc.dayEvents

```ts
readonly misc.dayEvents: "Day events";
```

###### en.misc.dropFilesHere

```ts
readonly misc.dropFilesHere: "Drop files here or click to browse";
```

###### en.misc.emptyFolder

```ts
readonly misc.emptyFolder: "Empty folder";
```

###### en.misc.errorUploadingFile

```ts
readonly misc.errorUploadingFile: "Error uploading {file}";
```

###### en.misc.eventCount

```ts
readonly misc.eventCount: "{count} events";
```

###### en.misc.expandSidebar

```ts
readonly misc.expandSidebar: "Expand sidebar";
```

###### en.misc.failedToFetchFile

```ts
readonly misc.failedToFetchFile: "Failed to fetch file.";
```

###### en.misc.failedToLoadFolder

```ts
readonly misc.failedToLoadFolder: "Failed to load folder";
```

###### en.misc.failedToLoadPdf

```ts
readonly misc.failedToLoadPdf: "Failed to load PDF";
```

###### en.misc.failedToLoadPreview

```ts
readonly misc.failedToLoadPreview: "Failed to load preview: {error}";
```

###### en.misc.fileTypeNotAllowed

```ts
readonly misc.fileTypeNotAllowed: "File type {type} is not allowed";
```

###### en.misc.fileTypes

```ts
readonly misc.fileTypes: "{types} files";
```

###### en.misc.frameMobileDescription

```ts
readonly misc.frameMobileDescription: "Browse this area and choose where to go.";
```

###### en.misc.imagePreviewUnavailable

```ts
readonly misc.imagePreviewUnavailable: "Image preview not available.";
```

###### en.misc.impersonate

```ts
readonly misc.impersonate: "Impersonate";
```

###### en.misc.impersonateHint

```ts
readonly misc.impersonateHint: "Preview the workspace under another team’s policy scope.";
```

###### en.misc.items

```ts
readonly misc.items: "{count} items";
```

###### en.misc.language

```ts
readonly misc.language: "Language";
```

###### en.misc.loadingPreview

```ts
readonly misc.loadingPreview: "Loading preview...";
```

###### en.misc.localeName.en

```ts
readonly misc.localeName.en: "English";
```

###### en.misc.localeName.zh

```ts
readonly misc.localeName.zh: "中文";
```

###### en.misc.logout

```ts
readonly misc.logout: "Logout";
```

###### en.misc.markdownAdvancedBlocks

```ts
readonly misc.markdownAdvancedBlocks: "Advanced Blocks";
```

###### en.misc.markdownAttachFiles

```ts
readonly misc.markdownAttachFiles: "Attach files…";
```

###### en.misc.markdownBlockquote

```ts
readonly misc.markdownBlockquote: "Blockquote";
```

###### en.misc.markdownBulletedList

```ts
readonly misc.markdownBulletedList: "Bulleted list";
```

###### en.misc.markdownChecklist

```ts
readonly misc.markdownChecklist: "Checklist";
```

###### en.misc.markdownHeading1

```ts
readonly misc.markdownHeading1: "Heading 1";
```

###### en.misc.markdownHeading2

```ts
readonly misc.markdownHeading2: "Heading 2";
```

###### en.misc.markdownHeading3

```ts
readonly misc.markdownHeading3: "Heading 3";
```

###### en.misc.markdownHorizontalRule

```ts
readonly misc.markdownHorizontalRule: "Horizontal Rule";
```

###### en.misc.markdownInputPlaceholder

```ts
readonly misc.markdownInputPlaceholder: "Type something...";
```

###### en.misc.markdownInsertImage

```ts
readonly misc.markdownInsertImage: "Insert image…";
```

###### en.misc.markdownInsertLink

```ts
readonly misc.markdownInsertLink: "Insert link…";
```

###### en.misc.markdownLists

```ts
readonly misc.markdownLists: "Lists";
```

###### en.misc.markdownMedia

```ts
readonly misc.markdownMedia: "Media";
```

###### en.misc.markdownNumberedList

```ts
readonly misc.markdownNumberedList: "Numbered list";
```

###### en.misc.markdownPlaceholder

```ts
readonly misc.markdownPlaceholder: "Type \"/\" for commands...";
```

###### en.misc.markdownText

```ts
readonly misc.markdownText: "Text";
```

###### en.misc.markdownTypography

```ts
readonly misc.markdownTypography: "Typography";
```

###### en.misc.maximumFilesReached

```ts
readonly misc.maximumFilesReached: "Maximum files reached";
```

###### en.misc.maxSizeEach

```ts
readonly misc.maxSizeEach: "Max {size} each";
```

###### en.misc.mentionKeyboardHint

```ts
readonly misc.mentionKeyboardHint: "↑↓ navigate · Enter add";
```

###### en.misc.mentionMenu

```ts
readonly misc.mentionMenu: "Mention menu";
```

###### en.misc.mentionTree

```ts
readonly misc.mentionTree: "Mention tree";
```

###### en.misc.menuKeyboard

```ts
readonly misc.menuKeyboard: "Keyboard navigation";
```

###### en.misc.month

```ts
readonly misc.month: "Month";
```

###### en.misc.monthEvents

```ts
readonly misc.monthEvents: "Month events";
```

###### en.misc.moreItems

```ts
readonly misc.moreItems: "+{count} more";
```

###### en.misc.moreTags

```ts
readonly misc.moreTags: "{count} more tags";
```

###### en.misc.navigation

```ts
readonly misc.navigation: "Navigation";
```

###### en.misc.nextMonth

```ts
readonly misc.nextMonth: "Next month";
```

###### en.misc.noColorsFound

```ts
readonly misc.noColorsFound: "No colors found.";
```

###### en.misc.noEvents

```ts
readonly misc.noEvents: "No events";
```

###### en.misc.noItemsFound

```ts
readonly misc.noItemsFound: "No items found";
```

###### en.misc.noItemsToDisplay

```ts
readonly misc.noItemsToDisplay: "No items to display";
```

###### en.misc.noMessagesYet

```ts
readonly misc.noMessagesYet: "No messages yet";
```

###### en.misc.none

```ts
readonly misc.none: "None";
```

###### en.misc.noProgressAssigned

```ts
readonly misc.noProgressAssigned: "No progress assigned";
```

###### en.misc.noProgressConfigured

```ts
readonly misc.noProgressConfigured: "No progress configured";
```

###### en.misc.noProgressSelected

```ts
readonly misc.noProgressSelected: "No progress selected";
```

###### en.misc.noRatingsAssigned

```ts
readonly misc.noRatingsAssigned: "No ratings assigned";
```

###### en.misc.noRatingsConfigured

```ts
readonly misc.noRatingsConfigured: "No ratings configured";
```

###### en.misc.noRatingsSelected

```ts
readonly misc.noRatingsSelected: "No ratings selected";
```

###### en.misc.openAccountMenu

```ts
readonly misc.openAccountMenu: "Open account menu";
```

###### en.misc.openNavigation

```ts
readonly misc.openNavigation: "Open {navigation}";
```

###### en.misc.pageSize

```ts
readonly misc.pageSize: "Page size";
```

###### en.misc.pdfPreview

```ts
readonly misc.pdfPreview: "PDF Preview";
```

###### en.misc.pdfPreviewUnavailable

```ts
readonly misc.pdfPreviewUnavailable: "PDF preview not available. Please open in a new tab.";
```

###### en.misc.platform

```ts
readonly misc.platform: "Platform";
```

###### en.misc.previewLoadError

```ts
readonly misc.previewLoadError: "Error loading preview";
```

###### en.misc.previousMonth

```ts
readonly misc.previousMonth: "Previous month";
```

###### en.misc.primaryNavigation

```ts
readonly misc.primaryNavigation: "Primary navigation";
```

###### en.misc.progress

```ts
readonly misc.progress: "Progress";
```

###### en.misc.progressAria

```ts
readonly misc.progressAria: "Progress {index}";
```

###### en.misc.progressComplete

```ts
readonly misc.progressComplete: "Complete";
```

###### en.misc.progressDetails

```ts
readonly misc.progressDetails: "Progress Details";
```

###### en.misc.progressEmpty

```ts
readonly misc.progressEmpty: "Empty";
```

###### en.misc.progressIndex

```ts
readonly misc.progressIndex: "Progress #{index}";
```

###### en.misc.ratingDetails

```ts
readonly misc.ratingDetails: "Rating Details";
```

###### en.misc.ratingIndex

```ts
readonly misc.ratingIndex: "Rating #{index}";
```

###### en.misc.reference

```ts
readonly misc.reference: "Reference";
```

###### en.misc.removeFile

```ts
readonly misc.removeFile: "Remove file";
```

###### en.misc.removeItem

```ts
readonly misc.removeItem: "Remove {name}";
```

###### en.misc.removeTag

```ts
readonly misc.removeTag: "Remove tag";
```

###### en.misc.resizeEnd

```ts
readonly misc.resizeEnd: "Resize end";
```

###### en.misc.resizePanel

```ts
readonly misc.resizePanel: "Resize panel";
```

###### en.misc.resizePanelHeight

```ts
readonly misc.resizePanelHeight: "Resize panel height";
```

###### en.misc.resizeStart

```ts
readonly misc.resizeStart: "Resize start";
```

###### en.misc.resources

```ts
readonly misc.resources: "Resources";
```

###### en.misc.resourceSchedule

```ts
readonly misc.resourceSchedule: "Resource schedule";
```

###### en.misc.retryUpload

```ts
readonly misc.retryUpload: "Retry upload";
```

###### en.misc.roleLabel

```ts
readonly misc.roleLabel: "Role: {role}";
```

###### en.misc.searchColors

```ts
readonly misc.searchColors: "Search colors…";
```

###### en.misc.searchEllipsis

```ts
readonly misc.searchEllipsis: "Search...";
```

###### en.misc.searchOrganizations

```ts
readonly misc.searchOrganizations: "Search organizations...";
```

###### en.misc.searchTree

```ts
readonly misc.searchTree: "Search tree";
```

###### en.misc.selectColorFor

```ts
readonly misc.selectColorFor: "Select a color for \"{value}\"";
```

###### en.misc.selectCountry

```ts
readonly misc.selectCountry: "Select a country";
```

###### en.misc.selectEllipsis

```ts
readonly misc.selectEllipsis: "Select...";
```

###### en.misc.selectOrganization

```ts
readonly misc.selectOrganization: "Select organization";
```

###### en.misc.selectProgress

```ts
readonly misc.selectProgress: "Select progress";
```

###### en.misc.selectRating

```ts
readonly misc.selectRating: "Select rating";
```

###### en.misc.shellMobileDescription

```ts
readonly misc.shellMobileDescription: "Switch organizations, open applications, or manage your account.";
```

###### en.misc.sidebar

```ts
readonly misc.sidebar: "Sidebar";
```

###### en.misc.startConversation

```ts
readonly misc.startConversation: "Start a conversation to see messages here";
```

###### en.misc.statusLabel

```ts
readonly misc.statusLabel: "Status {status}";
```

###### en.misc.stepDetails

```ts
readonly misc.stepDetails: "{label}. Step details available.";
```

###### en.misc.stepOf

```ts
readonly misc.stepOf: "Step {current} of {total}";
```

###### en.misc.stopImpersonating

```ts
readonly misc.stopImpersonating: "Stop impersonating";
```

###### en.misc.switchingTo

```ts
readonly misc.switchingTo: "Switching to {organization}";
```

###### en.misc.switchLocale

```ts
readonly misc.switchLocale: "Switch to {locale}";
```

###### en.misc.switchToDarkMode

```ts
readonly misc.switchToDarkMode: "Switch to dark mode";
```

###### en.misc.switchToLightMode

```ts
readonly misc.switchToLightMode: "Switch to light mode";
```

###### en.misc.themeName.dark

```ts
readonly misc.themeName.dark: "Dark";
```

###### en.misc.themeName.light

```ts
readonly misc.themeName.light: "Light";
```

###### en.misc.timeline

```ts
readonly misc.timeline: "Timeline";
```

###### en.misc.timeRangeSeparator

```ts
readonly misc.timeRangeSeparator: "to";
```

###### en.misc.timeRangeStartAfterEnd

```ts
readonly misc.timeRangeStartAfterEnd: "Start time must be before end time";
```

###### en.misc.timezoneLocal

```ts
readonly misc.timezoneLocal: "Local time";
```

###### en.misc.toastError

```ts
readonly misc.toastError: "Something went wrong";
```

###### en.misc.toastSuccess

```ts
readonly misc.toastSuccess: "Done";
```

###### en.misc.today

```ts
readonly misc.today: "Today";
```

###### en.misc.toggleSidebar

```ts
readonly misc.toggleSidebar: "Toggle Sidebar";
```

###### en.misc.totalFiles

```ts
readonly misc.totalFiles: "Total files ({count})";
```

###### en.misc.treeNavigation

```ts
readonly misc.treeNavigation: "Tree navigation";
```

###### en.misc.unknownFile

```ts
readonly misc.unknownFile: "Unknown file";
```

###### en.misc.unnamed

```ts
readonly misc.unnamed: "(unnamed)";
```

###### en.misc.uploadedFiles

```ts
readonly misc.uploadedFiles: "Uploaded files";
```

###### en.misc.upToFiles

```ts
readonly misc.upToFiles: "Up to {count} files";
```

###### en.misc.valueTable

```ts
readonly misc.valueTable: "Value table";
```

###### en.misc.viewSummary

```ts
readonly misc.viewSummary: "View summary";
```

###### en.misc.week

```ts
readonly misc.week: "Week";
```

###### en.misc.weekEvents

```ts
readonly misc.weekEvents: "Week events";
```

###### en.misc.workspaceNavigation

```ts
readonly misc.workspaceNavigation: "Workspace navigation";
```

###### en.misc.year

```ts
readonly misc.year: "Year";
```

###### en.recordMetadata.deletionRestricted

```ts
readonly recordMetadata.deletionRestricted: "Deletion unavailable";
```

###### en.recordMetadata.pendingApproval

```ts
readonly recordMetadata.pendingApproval: "Pending approval";
```

###### en.recordMetadata.pendingApprovalReason

```ts
readonly recordMetadata.pendingApprovalReason: "This record is read-only while its approval request is pending.";
```

###### en.recordMetadata.readOnly

```ts
readonly recordMetadata.readOnly: "Read only";
```

###### en.recordMetadata.readOnlyMove

```ts
readonly recordMetadata.readOnlyMove: "This record cannot be moved: {reason}";
```

###### en.recordMetadata.selectedDeleteRestricted

```ts
readonly recordMetadata.selectedDeleteRestricted: "The selected records cannot be deleted: {reason}";
```

###### en.recordMetadata.selectedUpdateRestricted

```ts
readonly recordMetadata.selectedUpdateRestricted: "The selected records cannot be updated: {reason}";
```

###### en.recordMetadata.updatesRestricted

```ts
readonly recordMetadata.updatesRestricted: "Updates unavailable";
```

###### en.table.aboutCollection

```ts
readonly table.aboutCollection: "About this collection";
```

###### en.table.actionRefreshFailed

```ts
readonly table.actionRefreshFailed: "Action completed, but the table did not refresh";
```

###### en.table.all

```ts
readonly table.all: "All";
```

###### en.table.applicationLock

```ts
readonly table.applicationLock: "Application";
```

###### en.table.appliedByView

```ts
readonly table.appliedByView: "Applied by this view";
```

###### en.table.appliedFilters

```ts
readonly table.appliedFilters: "Applied filters";
```

###### en.table.approvalActionFailed

```ts
readonly table.approvalActionFailed: "Approval action failed";
```

###### en.table.approvalApproved

```ts
readonly table.approvalApproved: "Request approved";
```

###### en.table.approvalAwaiting

```ts
readonly table.approvalAwaiting: "This record is awaiting approval.";
```

###### en.table.approvalChangesRequested

```ts
readonly table.approvalChangesRequested: "Changes requested";
```

###### en.table.approvalLoading

```ts
readonly table.approvalLoading: "Loading approval status…";
```

###### en.table.approvalRegion

```ts
readonly table.approvalRegion: "{title} approval";
```

###### en.table.approvalRejected

```ts
readonly table.approvalRejected: "Request rejected";
```

###### en.table.approvalRequest

```ts
readonly table.approvalRequest: "Approval request";
```

###### en.table.approvalRequestId

```ts
readonly table.approvalRequestId: "Request ID";
```

###### en.table.approvalStatus

```ts
readonly table.approvalStatus: "Status: {status}";
```

###### en.table.approvalSuperseded

```ts
readonly table.approvalSuperseded: "Approval superseded";
```

###### en.table.approvalWithdrawFailed

```ts
readonly table.approvalWithdrawFailed: "Unable to withdraw approval request";
```

###### en.table.approvalWithdrawn

```ts
readonly table.approvalWithdrawn: "Approval request withdrawn";
```

###### en.table.approve

```ts
readonly table.approve: "Approve";
```

###### en.table.bulkDeleted

```ts
readonly table.bulkDeleted: "Deleted {label}";
```

###### en.table.bulkFailed

```ts
readonly table.bulkFailed: "Bulk {kind} failed";
```

###### en.table.bulkStep1

```ts
readonly table.bulkStep1: "1. Choose a field";
```

###### en.table.bulkStep2

```ts
readonly table.bulkStep2: "2. Set the new value";
```

###### en.table.bulkStep3

```ts
readonly table.bulkStep3: "3. Review update";
```

###### en.table.bulkUpdate

```ts
readonly table.bulkUpdate: "Bulk update";
```

###### en.table.bulkUpdated

```ts
readonly table.bulkUpdated: "Updated {label}";
```

###### en.table.changeRequestReason

```ts
readonly table.changeRequestReason: "Change request reason";
```

###### en.table.chooseField

```ts
readonly table.chooseField: "Choose a field";
```

###### en.table.chooseFieldToUpdate

```ts
readonly table.chooseFieldToUpdate: "Choose a field to update";
```

###### en.table.chooseFilterField

```ts
readonly table.chooseFilterField: "Choose a filter field";
```

###### en.table.chooseOperator

```ts
readonly table.chooseOperator: "Choose an operator";
```

###### en.table.clearAll

```ts
readonly table.clearAll: "Clear all";
```

###### en.table.closeRecordDetail

```ts
readonly table.closeRecordDetail: "Close record detail";
```

###### en.table.collapse

```ts
readonly table.collapse: "Collapse";
```

###### en.table.collapseRowDetails

```ts
readonly table.collapseRowDetails: "Collapse row details";
```

###### en.table.collectionActions

```ts
readonly table.collectionActions: "Collection actions";
```

###### en.table.collectionActionsDescription

```ts
readonly table.collectionActionsDescription: "Run configured pipelines or change selected records.";
```

###### en.table.columnActions

```ts
readonly table.columnActions: "Column actions";
```

###### en.table.columns

```ts
readonly table.columns: "Columns";
```

###### en.table.columnToggle

```ts
readonly table.columnToggle: "Toggle column visibility";
```

###### en.table.confirmDeleteDescription

```ts
readonly table.confirmDeleteDescription: "This permanently removes the selected records. Linked records or collection policy may block the deletion.";
```

###### en.table.confirmDeleteTitle

```ts
readonly table.confirmDeleteTitle: "Delete {label}?";
```

###### en.table.confirmUpdate

```ts
readonly table.confirmUpdate: "Confirm update";
```

###### en.table.confirmUpdateDescription

```ts
readonly table.confirmUpdateDescription: "Every selected record will receive the same value for {field}.";
```

###### en.table.confirmUpdateTitle

```ts
readonly table.confirmUpdateTitle: "Update {label}?";
```

###### en.table.createFormDescription

```ts
readonly table.createFormDescription: "{label} form";
```

###### en.table.deleteRecords

```ts
readonly table.deleteRecords: "Delete records";
```

###### en.table.deleteSelectedLabel

```ts
readonly table.deleteSelectedLabel: "Delete {label}.";
```

###### en.table.describeChangesPlaceholder

```ts
readonly table.describeChangesPlaceholder: "Describe the required changes";
```

###### en.table.detailMissingId

```ts
readonly table.detailMissingId: "Cannot open detail without {field}.";
```

###### en.table.detailOpen

```ts
readonly table.detailOpen: "Open record";
```

###### en.table.detailUnavailable

```ts
readonly table.detailUnavailable: "Record detail is unavailable.";
```

###### en.table.display

```ts
readonly table.display: "Display";
```

###### en.table.emptyState

```ts
readonly table.emptyState: "No records yet";
```

###### en.table.emptyStateFiltered

```ts
readonly table.emptyStateFiltered: "No records match the current filters";
```

###### en.table.emptyStateHint

```ts
readonly table.emptyStateHint: "Try adjusting your search or filters";
```

###### en.table.expand

```ts
readonly table.expand: "Expand";
```

###### en.table.expandRowDetails

```ts
readonly table.expandRowDetails: "Expand row details";
```

###### en.table.export

```ts
readonly table.export: "Export";
```

###### en.table.filterActive

```ts
readonly table.filterActive: "Filters active";
```

###### en.table.filterAdd

```ts
readonly table.filterAdd: "Add filter";
```

###### en.table.filterAnd

```ts
readonly table.filterAnd: "And";
```

###### en.table.filterAnyOf

```ts
readonly table.filterAnyOf: "Any of: {values}";
```

###### en.table.filterAtLeast

```ts
readonly table.filterAtLeast: "{label} is at least {value}";
```

###### en.table.filterAtMost

```ts
readonly table.filterAtMost: "{label} is at most {value}";
```

###### en.table.filterContains

```ts
readonly table.filterContains: "{label} contains {value}";
```

###### en.table.filterFields

```ts
readonly table.filterFields: "Filter fields";
```

###### en.table.filterGreaterThan

```ts
readonly table.filterGreaterThan: "{label} is greater than {value}";
```

###### en.table.filterIs

```ts
readonly table.filterIs: "{label} is {value}";
```

###### en.table.filterIsEmpty

```ts
readonly table.filterIsEmpty: "{label} is empty";
```

###### en.table.filterIsNot

```ts
readonly table.filterIsNot: "{label} is not {value}";
```

###### en.table.filterIsNotEmpty

```ts
readonly table.filterIsNotEmpty: "{label} is not empty";
```

###### en.table.filterLessThan

```ts
readonly table.filterLessThan: "{label} is less than {value}";
```

###### en.table.filterNot

```ts
readonly table.filterNot: "Not {label}";
```

###### en.table.filterOr

```ts
readonly table.filterOr: "Or";
```

###### en.table.filterRecords

```ts
readonly table.filterRecords: "Filter records";
```

###### en.table.filterRemove

```ts
readonly table.filterRemove: "Remove filter";
```

###### en.table.filters

```ts
readonly table.filters: "Filters";
```

###### en.table.filtersAllMatch

```ts
readonly table.filtersAllMatch: "All conditions must match.";
```

###### en.table.fitAll

```ts
readonly table.fitAll: "Fit all";
```

###### en.table.fitColumn

```ts
readonly table.fitColumn: "Fit column";
```

###### en.table.format

```ts
readonly table.format: "Format";
```

###### en.table.groupBy

```ts
readonly table.groupBy: "Group by";
```

###### en.table.hideColumn

```ts
readonly table.hideColumn: "Hide column";
```

###### en.table.import

```ts
readonly table.import: "Import";
```

###### en.table.integrations

```ts
readonly table.integrations: "Integrations";
```

###### en.table.linksTo

```ts
readonly table.linksTo: "Links to {target}";
```

###### en.table.loadError

```ts
readonly table.loadError: "Something went wrong";
```

###### en.table.loading

```ts
readonly table.loading: "Loading records…";
```

###### en.table.loadingRecord

```ts
readonly table.loadingRecord: "Loading record…";
```

###### en.table.metadataError

```ts
readonly table.metadataError: "No field metadata is available for {collection}.";
```

###### en.table.nextPage

```ts
readonly table.nextPage: "Next page";
```

###### en.table.noApprovalRequest

```ts
readonly table.noApprovalRequest: "No approval request";
```

###### en.table.noApprovalRequestDesc

```ts
readonly table.noApprovalRequestDesc: "This record has no approval workflow activity yet.";
```

###### en.table.noCustomView

```ts
readonly table.noCustomView: "No custom record view";
```

###### en.table.noCustomViewDesc

```ts
readonly table.noCustomViewDesc: "This collection has no dedicated UI representation. Use Raw to inspect its fields.";
```

###### en.table.noFiltersApplied

```ts
readonly table.noFiltersApplied: "No filters applied.";
```

###### en.table.noIntegrationsConfigured

```ts
readonly table.noIntegrationsConfigured: "No integrations configured";
```

###### en.table.noIntegrationsDescription

```ts
readonly table.noIntegrationsDescription: "This collection is not currently connected to an external integration.";
```

###### en.table.noPipelinesConfigured

```ts
readonly table.noPipelinesConfigured: "No {kind} pipelines configured";
```

###### en.table.noPipelinesDeclared

```ts
readonly table.noPipelinesDeclared: "This collection does not currently declare a {kind} pipeline.";
```

###### en.table.noValueNeeded

```ts
readonly table.noValueNeeded: "No value needed";
```

###### en.table.openCollectionActions

```ts
readonly table.openCollectionActions: "Open collection actions";
```

###### en.table.pageOf

```ts
readonly table.pageOf: "Page {page} of {pages}";
```

###### en.table.pageSizeDisabled

```ts
readonly table.pageSizeDisabled: "Page size is disabled";
```

###### en.table.pendingApproval

```ts
readonly table.pendingApproval: "Pending approval";
```

###### en.table.pendingSync

```ts
readonly table.pendingSync: "Not saved yet — waiting to sync";
```

###### en.table.perPage

```ts
readonly table.perPage: "/ page";
```

###### en.table.pinColumn

```ts
readonly table.pinColumn: "Pin column";
```

###### en.table.pipelineDescription

```ts
readonly table.pipelineDescription: "{label} {kind} pipeline.";
```

###### en.table.pipelineFailed

```ts
readonly table.pipelineFailed: "{label} failed";
```

###### en.table.pipelineSelectRows

```ts
readonly table.pipelineSelectRows: "Select one or more rows to run {label}.";
```

###### en.table.previousPage

```ts
readonly table.previousPage: "Previous page";
```

###### en.table.rawRegion

```ts
readonly table.rawRegion: "{title} raw data";
```

###### en.table.recordDescription

```ts
readonly table.recordDescription: "{name} record";
```

###### en.table.recordDetails

```ts
readonly table.recordDetails: "{name} record details";
```

###### en.table.recordLoadFailed

```ts
readonly table.recordLoadFailed: "Record could not be loaded";
```

###### en.table.recordLocked

```ts
readonly table.recordLocked: "Application lock — this record can no longer be changed";
```

###### en.table.recordsRegion

```ts
readonly table.recordsRegion: "Collection records";
```

###### en.table.recordUnavailable

```ts
readonly table.recordUnavailable: "This record is no longer available.";
```

###### en.table.refresh

```ts
readonly table.refresh: "Refresh data";
```

###### en.table.refreshFailed

```ts
readonly table.refreshFailed: "Refresh failed";
```

###### en.table.reject

```ts
readonly table.reject: "Reject";
```

###### en.table.reorderColumns

```ts
readonly table.reorderColumns: "Reorder columns";
```

###### en.table.requestChanges

```ts
readonly table.requestChanges: "Request changes";
```

###### en.table.requestChangesDescription

```ts
readonly table.requestChangesDescription: "Explain what must change before this request can be approved.";
```

###### en.table.requesting

```ts
readonly table.requesting: "Requesting…";
```

###### en.table.resetWidth

```ts
readonly table.resetWidth: "Reset width";
```

###### en.table.resizeColumn

```ts
readonly table.resizeColumn: "Resize column";
```

###### en.table.reviewDeletion

```ts
readonly table.reviewDeletion: "Review deletion";
```

###### en.table.rowActions

```ts
readonly table.rowActions: "Row actions";
```

###### en.table.rowCount

```ts
readonly table.rowCount: "{count} rows";
```

###### en.table.rowsPerPage

```ts
readonly table.rowsPerPage: "Rows per page";
```

###### en.table.rowsRegion

```ts
readonly table.rowsRegion: "Collection table rows";
```

###### en.table.run

```ts
readonly table.run: "Run";
```

###### en.table.runPipeline

```ts
readonly table.runPipeline: "Run {label}";
```

###### en.table.searchActive

```ts
readonly table.searchActive: "Search active";
```

###### en.table.searchFields

```ts
readonly table.searchFields: "Search fields…";
```

###### en.table.searchFieldsOverflow

```ts
readonly table.searchFieldsOverflow: "{fields} +{count} more";
```

###### en.table.searchIn

```ts
readonly table.searchIn: "Search {fields}…";
```

###### en.table.searchRecords

```ts
readonly table.searchRecords: "Search records";
```

###### en.table.selectAllRows

```ts
readonly table.selectAllRows: "Select all rows";
```

###### en.table.selectedCount

```ts
readonly table.selectedCount: "{count} selected";
```

###### en.table.selectedFraction

```ts
readonly table.selectedFraction: "{selected} / {total} selected";
```

###### en.table.selectedRecord

```ts
readonly table.selectedRecord: "{count} selected record";
```

###### en.table.selectedRecords

```ts
readonly table.selectedRecords: "{count} selected records";
```

###### en.table.selectFieldPlaceholder

```ts
readonly table.selectFieldPlaceholder: "Select a primitive or linked field";
```

###### en.table.selectRecordLabel

```ts
readonly table.selectRecordLabel: "Select {label}";
```

###### en.table.selectRow

```ts
readonly table.selectRow: "Select row";
```

###### en.table.showColumn

```ts
readonly table.showColumn: "Show column";
```

###### en.table.sizing

```ts
readonly table.sizing: "Sizing";
```

###### en.table.sortAscending

```ts
readonly table.sortAscending: "Sort ascending";
```

###### en.table.sortClear

```ts
readonly table.sortClear: "Clear sort";
```

###### en.table.sortClearLabel

```ts
readonly table.sortClearLabel: "Clear sort for {label}";
```

###### en.table.sortDescending

```ts
readonly table.sortDescending: "Sort descending";
```

###### en.table.sortLabelAscending

```ts
readonly table.sortLabelAscending: "Sort {label} ascending";
```

###### en.table.sortLabelDescending

```ts
readonly table.sortLabelDescending: "Sort {label} descending";
```

###### en.table.supersedeApproval

```ts
readonly table.supersedeApproval: "Supersede approval";
```

###### en.table.supersedeApprovalDescription

```ts
readonly table.supersedeApprovalDescription: "Finish every remaining approval stage. This is exceptional and will be recorded in the audit trail.";
```

###### en.table.supersedeReason

```ts
readonly table.supersedeReason: "Reason for superseding";
```

###### en.table.supersedeReasonPlaceholder

```ts
readonly table.supersedeReasonPlaceholder: "Explain why the remaining review is being bypassed";
```

###### en.table.supersedingApproval

```ts
readonly table.supersedingApproval: "Superseding…";
```

###### en.table.systemFields

```ts
readonly table.systemFields: "System fields";
```

###### en.table.systemLock

```ts
readonly table.systemLock: "System";
```

###### en.table.systemLockPendingApproval

```ts
readonly table.systemLockPendingApproval: "System lock — pending approval";
```

###### en.table.tabApproval

```ts
readonly table.tabApproval: "Approval";
```

###### en.table.tabRaw

```ts
readonly table.tabRaw: "Raw";
```

###### en.table.tabUi

```ts
readonly table.tabUi: "UI";
```

###### en.table.toolbarRegion

```ts
readonly table.toolbarRegion: "Collection toolbar";
```

###### en.table.unableToLoadRecords

```ts
readonly table.unableToLoadRecords: "Unable to load records";
```

###### en.table.ungroup

```ts
readonly table.ungroup: "Ungroup";
```

###### en.table.unpinColumn

```ts
readonly table.unpinColumn: "Unpin column";
```

###### en.table.viewDisabled

```ts
readonly table.viewDisabled: "This view is not accepting changes right now.";
```

###### en.table.withdrawRequest

```ts
readonly table.withdrawRequest: "Withdraw request";
```

<a id="zh"></a>

##### zh

```ts
readonly zh: object;
```

###### zh.common.add

```ts
readonly common.add: "添加";
```

###### zh.common.apply

```ts
readonly common.apply: "应用";
```

###### zh.common.back

```ts
readonly common.back: "返回";
```

###### zh.common.buildItemsStepByStep

```ts
readonly common.buildItemsStepByStep: "逐步构建条目…";
```

###### zh.common.buildItemStepByStep

```ts
readonly common.buildItemStepByStep: "逐步构建条目…";
```

###### zh.common.cancel

```ts
readonly common.cancel: "取消";
```

###### zh.common.clear

```ts
readonly common.clear: "清除";
```

###### zh.common.clearAllOptions

```ts
readonly common.clearAllOptions: "清除全部选项";
```

###### zh.common.clearSelection

```ts
readonly common.clearSelection: "清除选择";
```

###### zh.common.clickNewToStart

```ts
readonly common.clickNewToStart: "点击“新建”开始。";
```

###### zh.common.close

```ts
readonly common.close: "关闭";
```

###### zh.common.complete

```ts
readonly common.complete: "已完成";
```

###### zh.common.confirm

```ts
readonly common.confirm: "确认";
```

###### zh.common.continue

```ts
readonly common.continue: "继续";
```

###### zh.common.copy

```ts
readonly common.copy: "复制";
```

###### zh.common.create

```ts
readonly common.create: "新建";
```

###### zh.common.createOption

```ts
readonly common.createOption: "新建“{query}”";
```

###### zh.common.createToStart

```ts
readonly common.createToStart: "请新建一个选项以开始。";
```

###### zh.common.customFallback

```ts
readonly common.customFallback: "[自定义]";
```

###### zh.common.cut

```ts
readonly common.cut: "剪切";
```

###### zh.common.delete

```ts
readonly common.delete: "删除";
```

###### zh.common.deselectAll

```ts
readonly common.deselectAll: "取消全选";
```

###### zh.common.dismiss

```ts
readonly common.dismiss: "忽略";
```

###### zh.common.done

```ts
readonly common.done: "完成";
```

###### zh.common.download

```ts
readonly common.download: "下载";
```

###### zh.common.edit

```ts
readonly common.edit: "编辑";
```

###### zh.common.emptyGetStarted

```ts
readonly common.emptyGetStarted: "新建你的第一个项目，开始使用。";
```

###### zh.common.enterFullScreen

```ts
readonly common.enterFullScreen: "进入全屏";
```

###### zh.common.errorLabel

```ts
readonly common.errorLabel: "错误：{message}";
```

###### zh.common.existingSelections

```ts
readonly common.existingSelections: "已有选择";
```

###### zh.common.exitFullScreen

```ts
readonly common.exitFullScreen: "退出全屏";
```

###### zh.common.filter

```ts
readonly common.filter: "筛选";
```

###### zh.common.finish

```ts
readonly common.finish: "完成";
```

###### zh.common.itemSelected

```ts
readonly common.itemSelected: "已选择项目";
```

###### zh.common.itemsSelected

```ts
readonly common.itemsSelected: "已选择 {count} 个项目";
```

###### zh.common.less

```ts
readonly common.less: "更少";
```

###### zh.common.loading

```ts
readonly common.loading: "加载中…";
```

###### zh.common.loadingOptions

```ts
readonly common.loadingOptions: "正在加载选项…";
```

###### zh.common.missingKeys

```ts
readonly common.missingKeys: "缺少：{keys}";
```

###### zh.common.more

```ts
readonly common.more: "更多";
```

###### zh.common.new

```ts
readonly common.new: "新建";
```

###### zh.common.next

```ts
readonly common.next: "下一步";
```

###### zh.common.nextStep

```ts
readonly common.nextStep: "转到下一步";
```

###### zh.common.no

```ts
readonly common.no: "否";
```

###### zh.common.noItemsFound

```ts
readonly common.noItemsFound: "未找到项目";
```

###### zh.common.noItemsSelected

```ts
readonly common.noItemsSelected: "未选择任何项目";
```

###### zh.common.noOptions

```ts
readonly common.noOptions: "没有可用选项";
```

###### zh.common.noResults

```ts
readonly common.noResults: "无结果";
```

###### zh.common.noResultsFor

```ts
readonly common.noResultsFor: "未找到“{query}”的相关结果";
```

###### zh.common.noResultsFound

```ts
readonly common.noResultsFound: "未找到结果";
```

###### zh.common.noSelection

```ts
readonly common.noSelection: "未选择";
```

###### zh.common.noSelectionsYet

```ts
readonly common.noSelectionsYet: "暂无选项。";
```

###### zh.common.notAvailable

```ts
readonly common.notAvailable: "不可用";
```

###### zh.common.oneItemSelected

```ts
readonly common.oneItemSelected: "已选择 1 个项目";
```

###### zh.common.open

```ts
readonly common.open: "打开";
```

###### zh.common.optional

```ts
readonly common.optional: "选填";
```

###### zh.common.options

```ts
readonly common.options: "选项";
```

###### zh.common.partial

```ts
readonly common.partial: "未完成";
```

###### zh.common.partialSelection

```ts
readonly common.partialSelection: "未完成的选项";
```

###### zh.common.paste

```ts
readonly common.paste: "粘贴";
```

###### zh.common.previous

```ts
readonly common.previous: "上一步";
```

###### zh.common.previousStep

```ts
readonly common.previousStep: "转到上一步";
```

###### zh.common.print

```ts
readonly common.print: "打印";
```

###### zh.common.redo

```ts
readonly common.redo: "重做";
```

###### zh.common.refresh

```ts
readonly common.refresh: "刷新";
```

###### zh.common.remove

```ts
readonly common.remove: "移除";
```

###### zh.common.removeOption

```ts
readonly common.removeOption: "移除{label}";
```

###### zh.common.removeSelection

```ts
readonly common.removeSelection: "移除选项";
```

###### zh.common.required

```ts
readonly common.required: "必填";
```

###### zh.common.reset

```ts
readonly common.reset: "重置";
```

###### zh.common.retry

```ts
readonly common.retry: "重试";
```

###### zh.common.save

```ts
readonly common.save: "保存";
```

###### zh.common.search

```ts
readonly common.search: "搜索";
```

###### zh.common.searchOptions

```ts
readonly common.searchOptions: "搜索选项…";
```

###### zh.common.searchTree

```ts
readonly common.searchTree: "搜索树";
```

###### zh.common.select

```ts
readonly common.select: "选择";
```

###### zh.common.selectAll

```ts
readonly common.selectAll: "全选";
```

###### zh.common.selectAllOptions

```ts
readonly common.selectAllOptions: "全选选项";
```

###### zh.common.selected

```ts
readonly common.selected: "已选择 {count} 项";
```

###### zh.common.selectedLabel

```ts
readonly common.selectedLabel: "已选择：{label}";
```

###### zh.common.selectedOfTotal

```ts
readonly common.selectedOfTotal: "已选择 {selected} 项，共 {total} 项";
```

###### zh.common.selection

```ts
readonly common.selection: "选项";
```

###### zh.common.selections

```ts
readonly common.selections: "选项";
```

###### zh.common.selectOption

```ts
readonly common.selectOption: "选择选项";
```

###### zh.common.selectOrCreateToStart

```ts
readonly common.selectOrCreateToStart: "请选择或新建一个选项以开始。";
```

###### zh.common.showingCount

```ts
readonly common.showingCount: "显示 {count} 项，共 {total} 项";
```

###### zh.common.stepOf

```ts
readonly common.stepOf: "第 {current} 步，共 {total} 步";
```

###### zh.common.submit

```ts
readonly common.submit: "提交";
```

###### zh.common.undo

```ts
readonly common.undo: "撤销";
```

###### zh.common.unknown

```ts
readonly common.unknown: "未知";
```

###### zh.common.unknownFallback

```ts
readonly common.unknownFallback: "[未知]";
```

###### zh.common.upload

```ts
readonly common.upload: "上传";
```

###### zh.common.view

```ts
readonly common.view: "查看";
```

###### zh.common.viewDetails

```ts
readonly common.viewDetails: "查看详情";
```

###### zh.common.yes

```ts
readonly common.yes: "是";
```

###### zh.dataRenderer.absent

```ts
readonly dataRenderer.absent: "未提供";
```

###### zh.dataRenderer.accepts

```ts
readonly dataRenderer.accepts: "支持类型：{types}";
```

###### zh.dataRenderer.addAmount

```ts
readonly dataRenderer.addAmount: "添加金额";
```

###### zh.dataRenderer.addDateTime

```ts
readonly dataRenderer.addDateTime: "添加日期和时间";
```

###### zh.dataRenderer.addFile

```ts
readonly dataRenderer.addFile: "添加文件";
```

###### zh.dataRenderer.addFirstFile

```ts
readonly dataRenderer.addFirstFile: "添加第一个文件";
```

###### zh.dataRenderer.addMonetaryValue

```ts
readonly dataRenderer.addMonetaryValue: "添加一个金额值以开始。";
```

###### zh.dataRenderer.addPhoneNumber

```ts
readonly dataRenderer.addPhoneNumber: "添加电话号码";
```

###### zh.dataRenderer.addProgress

```ts
readonly dataRenderer.addProgress: "添加进度";
```

###### zh.dataRenderer.addRange

```ts
readonly dataRenderer.addRange: "添加新范围";
```

###### zh.dataRenderer.addRating

```ts
readonly dataRenderer.addRating: "添加评分";
```

###### zh.dataRenderer.addRow

```ts
readonly dataRenderer.addRow: "添加行";
```

###### zh.dataRenderer.addTime

```ts
readonly dataRenderer.addTime: "添加时间";
```

###### zh.dataRenderer.addValue

```ts
readonly dataRenderer.addValue: "添加值";
```

###### zh.dataRenderer.booleanValue

```ts
readonly dataRenderer.booleanValue: "布尔值 {index}";
```

###### zh.dataRenderer.cancelUpload

```ts
readonly dataRenderer.cancelUpload: "取消上传";
```

###### zh.dataRenderer.channelAdd

```ts
readonly dataRenderer.channelAdd: "添加渠道";
```

###### zh.dataRenderer.channelAddress

```ts
readonly dataRenderer.channelAddress: "地址";
```

###### zh.dataRenderer.channelPrimary

```ts
readonly dataRenderer.channelPrimary: "主要";
```

###### zh.dataRenderer.channelRemove

```ts
readonly dataRenderer.channelRemove: "移除渠道";
```

###### zh.dataRenderer.channelsEmpty

```ts
readonly dataRenderer.channelsEmpty: "尚未记录任何渠道。";
```

###### zh.dataRenderer.channelType

```ts
readonly dataRenderer.channelType: "渠道类型";
```

###### zh.dataRenderer.channelVerified

```ts
readonly dataRenderer.channelVerified: "已验证";
```

###### zh.dataRenderer.chooseYear

```ts
readonly dataRenderer.chooseYear: "选择年份";
```

###### zh.dataRenderer.clearAll

```ts
readonly dataRenderer.clearAll: "全部清除";
```

###### zh.dataRenderer.clearAllDates

```ts
readonly dataRenderer.clearAllDates: "清除所有已选日期";
```

###### zh.dataRenderer.clearRating

```ts
readonly dataRenderer.clearRating: "清除评分";
```

###### zh.dataRenderer.clearSelection

```ts
readonly dataRenderer.clearSelection: "清除选择";
```

###### zh.dataRenderer.copied

```ts
readonly dataRenderer.copied: "已复制";
```

###### zh.dataRenderer.copyValue

```ts
readonly dataRenderer.copyValue: "复制值";
```

###### zh.dataRenderer.countryCallingCode

```ts
readonly dataRenderer.countryCallingCode: "国家区号";
```

###### zh.dataRenderer.dateSummaryMany

```ts
readonly dataRenderer.dateSummaryMany: "{count} 个日期（{first} 至 {second}）";
```

###### zh.dataRenderer.dateSummaryTwo

```ts
readonly dataRenderer.dateSummaryTwo: "{first} 和 {second}";
```

###### zh.dataRenderer.emailSend

```ts
readonly dataRenderer.emailSend: "发送邮件";
```

###### zh.dataRenderer.endTime

```ts
readonly dataRenderer.endTime: "结束时间";
```

###### zh.dataRenderer.false

```ts
readonly dataRenderer.false: "否";
```

###### zh.dataRenderer.fileCount

```ts
readonly dataRenderer.fileCount: "共 {count} 个文件";
```

###### zh.dataRenderer.filePreview

```ts
readonly dataRenderer.filePreview: "文件预览";
```

###### zh.dataRenderer.fileProviderMissing

```ts
readonly dataRenderer.fileProviderMissing: "无法编辑文件：未配置工作区上传服务。";
```

###### zh.dataRenderer.filesSelected

```ts
readonly dataRenderer.filesSelected: "已选择 {count} 个文件";
```

###### zh.dataRenderer.fileTooLarge

```ts
readonly dataRenderer.fileTooLarge: "文件 \"{name}\"（{size}）超过 {maxSize} 限制";
```

###### zh.dataRenderer.fileTypeNotAllowed

```ts
readonly dataRenderer.fileTypeNotAllowed: "文件类型 \"{type}\" 不允许用于 \"{name}\"";
```

###### zh.dataRenderer.fileUploadInput

```ts
readonly dataRenderer.fileUploadInput: "文件上传输入";
```

###### zh.dataRenderer.geocoded

```ts
readonly dataRenderer.geocoded: "已地理编码";
```

###### zh.dataRenderer.geoProviderMissing

```ts
readonly dataRenderer.geoProviderMissing: "无法编辑地理位置：未配置地理定位服务。";
```

###### zh.dataRenderer.gpsCompatible

```ts
readonly dataRenderer.gpsCompatible: "支持 GPS";
```

###### zh.dataRenderer.invalidJson

```ts
readonly dataRenderer.invalidJson: "请输入有效的 JSON 后再保存。";
```

###### zh.dataRenderer.invalidPhone

```ts
readonly dataRenderer.invalidPhone: "请输入有效的电话号码。";
```

###### zh.dataRenderer.latitude

```ts
readonly dataRenderer.latitude: "纬度";
```

###### zh.dataRenderer.locationDetails

```ts
readonly dataRenderer.locationDetails: "位置详情";
```

###### zh.dataRenderer.locationMap

```ts
readonly dataRenderer.locationMap: "位置地图";
```

###### zh.dataRenderer.locationTypeAddress

```ts
readonly dataRenderer.locationTypeAddress: "地址";
```

###### zh.dataRenderer.locationTypeBusiness

```ts
readonly dataRenderer.locationTypeBusiness: "商家";
```

###### zh.dataRenderer.locationTypeCountry

```ts
readonly dataRenderer.locationTypeCountry: "国家";
```

###### zh.dataRenderer.locationTypeLocality

```ts
readonly dataRenderer.locationTypeLocality: "城市/城镇";
```

###### zh.dataRenderer.locationTypePointOfInterest

```ts
readonly dataRenderer.locationTypePointOfInterest: "兴趣点";
```

###### zh.dataRenderer.locationTypePolitical

```ts
readonly dataRenderer.locationTypePolitical: "行政区";
```

###### zh.dataRenderer.longitude

```ts
readonly dataRenderer.longitude: "经度";
```

###### zh.dataRenderer.mapOf

```ts
readonly dataRenderer.mapOf: "{location} 的地图";
```

###### zh.dataRenderer.matrixRows

```ts
readonly dataRenderer.matrixRows: "矩阵行";
```

###### zh.dataRenderer.maxFilePlural

```ts
readonly dataRenderer.maxFilePlural: "最多 {count} 个文件 • 大小上限 {size}";
```

###### zh.dataRenderer.maxFileSingular

```ts
readonly dataRenderer.maxFileSingular: "最多 {count} 个文件 • 大小上限 {size}";
```

###### zh.dataRenderer.maxFilesReached

```ts
readonly dataRenderer.maxFilesReached: "无法添加 \"{name}\"：最多允许 {count} 个文件";
```

###### zh.dataRenderer.nextYears

```ts
readonly dataRenderer.nextYears: "显示下一年份";
```

###### zh.dataRenderer.noAmountsConfigured

```ts
readonly dataRenderer.noAmountsConfigured: "未配置金额";
```

###### zh.dataRenderer.noAmountsSelected

```ts
readonly dataRenderer.noAmountsSelected: "未选择金额";
```

###### zh.dataRenderer.noCoordinates

```ts
readonly dataRenderer.noCoordinates: "无坐标";
```

###### zh.dataRenderer.noCoordinatesAvailable

```ts
readonly dataRenderer.noCoordinatesAvailable: "暂无坐标";
```

###### zh.dataRenderer.noCoordinatesForLocation

```ts
readonly dataRenderer.noCoordinatesForLocation: "该位置暂无坐标";
```

###### zh.dataRenderer.noFilesAttached

```ts
readonly dataRenderer.noFilesAttached: "未附加文件";
```

###### zh.dataRenderer.noFilesSelected

```ts
readonly dataRenderer.noFilesSelected: "未选择文件";
```

###### zh.dataRenderer.noFilesUploaded

```ts
readonly dataRenderer.noFilesUploaded: "未上传文件";
```

###### zh.dataRenderer.noFileUploaded

```ts
readonly dataRenderer.noFileUploaded: "未上传文件";
```

###### zh.dataRenderer.noLocations

```ts
readonly dataRenderer.noLocations: "未选择位置";
```

###### zh.dataRenderer.noProgress

```ts
readonly dataRenderer.noProgress: "暂无进度";
```

###### zh.dataRenderer.noRanges

```ts
readonly dataRenderer.noRanges: "未选择范围";
```

###### zh.dataRenderer.noRating

```ts
readonly dataRenderer.noRating: "暂无评分";
```

###### zh.dataRenderer.noRows

```ts
readonly dataRenderer.noRows: "暂无行。";
```

###### zh.dataRenderer.null

```ts
readonly dataRenderer.null: "—";
```

###### zh.dataRenderer.openInNewTab

```ts
readonly dataRenderer.openInNewTab: "在新标签页中打开";
```

###### zh.dataRenderer.phoneCall

```ts
readonly dataRenderer.phoneCall: "拨打";
```

###### zh.dataRenderer.phonePlaceholder

```ts
readonly dataRenderer.phonePlaceholder: "电话号码";
```

###### zh.dataRenderer.pickDateRanges

```ts
readonly dataRenderer.pickDateRanges: "选择日期范围";
```

###### zh.dataRenderer.present

```ts
readonly dataRenderer.present: "已填写";
```

###### zh.dataRenderer.prevYears

```ts
readonly dataRenderer.prevYears: "显示上一年份";
```

###### zh.dataRenderer.progressIndex

```ts
readonly dataRenderer.progressIndex: "进度 {index}";
```

###### zh.dataRenderer.rangePlural

```ts
readonly dataRenderer.rangePlural: "个范围";
```

###### zh.dataRenderer.rangeSingular

```ts
readonly dataRenderer.rangeSingular: "个范围";
```

###### zh.dataRenderer.removeAmount

```ts
readonly dataRenderer.removeAmount: "移除金额";
```

###### zh.dataRenderer.removeBooleanValue

```ts
readonly dataRenderer.removeBooleanValue: "移除布尔值";
```

###### zh.dataRenderer.removeDate

```ts
readonly dataRenderer.removeDate: "移除 {date}";
```

###### zh.dataRenderer.removeDateTime

```ts
readonly dataRenderer.removeDateTime: "移除日期和时间";
```

###### zh.dataRenderer.removeLocation

```ts
readonly dataRenderer.removeLocation: "移除 {location}";
```

###### zh.dataRenderer.removePhoneNumber

```ts
readonly dataRenderer.removePhoneNumber: "移除电话号码";
```

###### zh.dataRenderer.removeProgress

```ts
readonly dataRenderer.removeProgress: "移除进度值";
```

###### zh.dataRenderer.removeRange

```ts
readonly dataRenderer.removeRange: "移除该范围";
```

###### zh.dataRenderer.removeRating

```ts
readonly dataRenderer.removeRating: "移除评分";
```

###### zh.dataRenderer.removeRow

```ts
readonly dataRenderer.removeRow: "移除行";
```

###### zh.dataRenderer.removeTime

```ts
readonly dataRenderer.removeTime: "移除时间";
```

###### zh.dataRenderer.removeValue

```ts
readonly dataRenderer.removeValue: "移除值";
```

###### zh.dataRenderer.searchCountries

```ts
readonly dataRenderer.searchCountries: "搜索国家…";
```

###### zh.dataRenderer.searchLocation

```ts
readonly dataRenderer.searchLocation: "搜索地点…";
```

###### zh.dataRenderer.searchTarget

```ts
readonly dataRenderer.searchTarget: "搜索 {target}…";
```

###### zh.dataRenderer.seeAllDates

```ts
readonly dataRenderer.seeAllDates: "点击查看所有日期";
```

###### zh.dataRenderer.selectAmount

```ts
readonly dataRenderer.selectAmount: "选择金额";
```

###### zh.dataRenderer.selectDate

```ts
readonly dataRenderer.selectDate: "选择日期";
```

###### zh.dataRenderer.selectDates

```ts
readonly dataRenderer.selectDates: "选择日期";
```

###### zh.dataRenderer.selectDateTime

```ts
readonly dataRenderer.selectDateTime: "选择日期和时间";
```

###### zh.dataRenderer.selectedDatesHeading

```ts
readonly dataRenderer.selectedDatesHeading: "已选日期（{count}）";
```

###### zh.dataRenderer.selectedDatesScroll

```ts
readonly dataRenderer.selectedDatesScroll: "已选日期";
```

###### zh.dataRenderer.selectedRangesHeading

```ts
readonly dataRenderer.selectedRangesHeading: "已选范围（{count}）";
```

###### zh.dataRenderer.selectedRangesScroll

```ts
readonly dataRenderer.selectedRangesScroll: "已选范围";
```

###### zh.dataRenderer.selectRecord

```ts
readonly dataRenderer.selectRecord: "选择记录…";
```

###### zh.dataRenderer.startTime

```ts
readonly dataRenderer.startTime: "开始时间";
```

###### zh.dataRenderer.status

```ts
readonly dataRenderer.status: "状态";
```

###### zh.dataRenderer.time

```ts
readonly dataRenderer.time: "时间";
```

###### zh.dataRenderer.timeRange

```ts
readonly dataRenderer.timeRange: "时间段";
```

###### zh.dataRenderer.true

```ts
readonly dataRenderer.true: "是";
```

###### zh.dataRenderer.typeToSearchLocations

```ts
readonly dataRenderer.typeToSearchLocations: "输入以搜索地点…";
```

###### zh.dataRenderer.unknownLocation

```ts
readonly dataRenderer.unknownLocation: "未知地点";
```

###### zh.dataRenderer.uploadFailed

```ts
readonly dataRenderer.uploadFailed: "上传失败";
```

###### zh.dataRenderer.uploadFirstFile

```ts
readonly dataRenderer.uploadFirstFile: "上传您的第一个文件以开始";
```

###### zh.dataRenderer.valueIndex

```ts
readonly dataRenderer.valueIndex: "值 {index}";
```

###### zh.dataRenderer.valuePlaceholder

```ts
readonly dataRenderer.valuePlaceholder: "值…";
```

###### zh.dataRenderer.viewFile

```ts
readonly dataRenderer.viewFile: "查看文件";
```

###### zh.form.actionsLabel

```ts
readonly form.actionsLabel: "表单操作";
```

###### zh.form.addItem

```ts
readonly form.addItem: "添加项目";
```

###### zh.form.deleting

```ts
readonly form.deleting: "删除中…";
```

###### zh.form.dragToReorder

```ts
readonly form.dragToReorder: "拖拽以排序";
```

###### zh.form.dropFiles

```ts
readonly form.dropFiles: "将文件拖到此处或点击浏览";
```

###### zh.form.dropFilesActive

```ts
readonly form.dropFilesActive: "松开以上传文件";
```

###### zh.form.fieldHint

```ts
readonly form.fieldHint: "提示";
```

###### zh.form.fieldHistoryLabel

```ts
readonly form.fieldHistoryLabel: "{label} 字段历史";
```

###### zh.form.fieldHistoryRegion

```ts
readonly form.fieldHistoryRegion: "字段历史";
```

###### zh.form.fieldsRegion

```ts
readonly form.fieldsRegion: "{name} 表单字段";
```

###### zh.form.fileTooLarge

```ts
readonly form.fileTooLarge: "文件过大";
```

###### zh.form.fileTypeNotAllowed

```ts
readonly form.fileTypeNotAllowed: "不支持此文件类型";
```

###### zh.form.fixErrors

```ts
readonly form.fixErrors: "请先修正高亮字段再保存。";
```

###### zh.form.formMustBeObject

```ts
readonly form.formMustBeObject: "表单值必须是对象。";
```

###### zh.form.historyLoadFailed

```ts
readonly form.historyLoadFailed: "无法加载历史记录。";
```

###### zh.form.historyTitle

```ts
readonly form.historyTitle: "{label} 历史";
```

###### zh.form.invalidBoolean

```ts
readonly form.invalidBoolean: "请选择有效的布尔值。";
```

###### zh.form.invalidDate

```ts
readonly form.invalidDate: "请输入有效的日期";
```

###### zh.form.invalidEmail

```ts
readonly form.invalidEmail: "请输入有效的邮箱地址";
```

###### zh.form.invalidList

```ts
readonly form.invalidList: "请输入一个值列表。";
```

###### zh.form.invalidNumber

```ts
readonly form.invalidNumber: "请输入有效的数字";
```

###### zh.form.invalidOption

```ts
readonly form.invalidOption: "请选择有效的选项。";
```

###### zh.form.invalidUrl

```ts
readonly form.invalidUrl: "请输入有效的网址";
```

###### zh.form.invalidValue

```ts
readonly form.invalidValue: "值无效";
```

###### zh.form.loadingForm

```ts
readonly form.loadingForm: "正在加载表单";
```

###### zh.form.maxLength

```ts
readonly form.maxLength: "最多 {count} 个字符";
```

###### zh.form.maxValue

```ts
readonly form.maxValue: "最多为 {value}";
```

###### zh.form.minLength

```ts
readonly form.minLength: "至少 {count} 个字符";
```

###### zh.form.minValue

```ts
readonly form.minValue: "至少为 {value}";
```

###### zh.form.moveDown

```ts
readonly form.moveDown: "下移";
```

###### zh.form.moveUp

```ts
readonly form.moveUp: "上移";
```

###### zh.form.noSavedChanges

```ts
readonly form.noSavedChanges: "暂无保存的更改。";
```

###### zh.form.removeItem

```ts
readonly form.removeItem: "移除项目";
```

###### zh.form.requiredField

```ts
readonly form.requiredField: "请填写{label}";
```

###### zh.form.requiredGeneric

```ts
readonly form.requiredGeneric: "此字段为必填项。";
```

###### zh.form.save

```ts
readonly form.save: "保存更改";
```

###### zh.form.saved

```ts
readonly form.saved: "已保存";
```

###### zh.form.savedHistoryLabel

```ts
readonly form.savedHistoryLabel: "{label} 已保存的历史";
```

###### zh.form.savedSuccessfully

```ts
readonly form.savedSuccessfully: "保存成功";
```

###### zh.form.saveFailed

```ts
readonly form.saveFailed: "保存失败，请重试。";
```

###### zh.form.saving

```ts
readonly form.saving: "保存中…";
```

###### zh.form.unsaved

```ts
readonly form.unsaved: "未保存";
```

###### zh.form.unsavedChange

```ts
readonly form.unsavedChange: "未保存的更改";
```

###### zh.form.unsavedChanges

```ts
readonly form.unsavedChanges: "您有未保存的更改";
```

###### zh.form.unsavedField

```ts
readonly form.unsavedField: "{count} 个未保存字段";
```

###### zh.form.unsavedFields

```ts
readonly form.unsavedFields: "{count} 个未保存字段";
```

###### zh.form.valuesMustBeObject

```ts
readonly form.valuesMustBeObject: "验证后的表单值必须是对象。";
```

###### zh.kanban.addCard

```ts
readonly kanban.addCard: "添加卡片";
```

###### zh.kanban.approvalLoading

```ts
readonly kanban.approvalLoading: "正在加载审批数据…";
```

###### zh.kanban.boardRegion

```ts
readonly kanban.boardRegion: "看板";
```

###### zh.kanban.cardActions

```ts
readonly kanban.cardActions: "卡片操作";
```

###### zh.kanban.cardCount

```ts
readonly kanban.cardCount: "共 {count} 张卡片";
```

###### zh.kanban.cardMoved

```ts
readonly kanban.cardMoved: "已将卡片移至{lane}。";
```

###### zh.kanban.cardPickedUp

```ts
readonly kanban.cardPickedUp: "已拿起卡片。使用左或右方向键移动它，或按 Esc 取消。";
```

###### zh.kanban.columnRegion

```ts
readonly kanban.columnRegion: "{column} 列";
```

###### zh.kanban.dragCard

```ts
readonly kanban.dragCard: "拖动卡片";
```

###### zh.kanban.emptyLane

```ts
readonly kanban.emptyLane: "此列暂无卡片";
```

###### zh.kanban.emptyState

```ts
readonly kanban.emptyState: "暂无卡片";
```

###### zh.kanban.keyboardInstructions

```ts
readonly kanban.keyboardInstructions: "按回车键打开卡片。按空格键拿起卡片，然后用左或右方向键在列间移动，按 Esc 取消。";
```

###### zh.kanban.laneClear

```ts
readonly kanban.laneClear: "此列在当前视图下没有卡片。";
```

###### zh.kanban.laneCollapse

```ts
readonly kanban.laneCollapse: "收起此列";
```

###### zh.kanban.laneExpand

```ts
readonly kanban.laneExpand: "展开此列";
```

###### zh.kanban.lanesRegion

```ts
readonly kanban.lanesRegion: "看板列";
```

###### zh.kanban.loadingBoard

```ts
readonly kanban.loadingBoard: "正在加载看板";
```

###### zh.kanban.moveCancelled

```ts
readonly kanban.moveCancelled: "已取消卡片移动。";
```

###### zh.kanban.moveLeft

```ts
readonly kanban.moveLeft: "向左移动";
```

###### zh.kanban.moveRight

```ts
readonly kanban.moveRight: "向右移动";
```

###### zh.kanban.noLaneDirection

```ts
readonly kanban.noLaneDirection: "该方向没有列。{lane} 是看板的边缘。";
```

###### zh.kanban.noLaneJobs

```ts
readonly kanban.noLaneJobs: "没有{lane}任务";
```

###### zh.kanban.scrollForMore

```ts
readonly kanban.scrollForMore: "向下滚动查看更多";
```

###### zh.kanban.selectCard

```ts
readonly kanban.selectCard: "选择卡片";
```

###### zh.misc.account

```ts
readonly misc.account: "账户";
```

###### zh.misc.activeCollaborators

```ts
readonly misc.activeCollaborators: "正在协作的用户";
```

###### zh.misc.addFirstProgress

```ts
readonly misc.addFirstProgress: "添加第一个进度";
```

###### zh.misc.addFirstProgressHint

```ts
readonly misc.addFirstProgressHint: "添加第一个进度值以开始";
```

###### zh.misc.addFirstRating

```ts
readonly misc.addFirstRating: "添加第一个评分";
```

###### zh.misc.addFirstRatingHint

```ts
readonly misc.addFirstRatingHint: "添加您的第一个评分以开始";
```

###### zh.misc.addProgress

```ts
readonly misc.addProgress: "添加进度";
```

###### zh.misc.addTag

```ts
readonly misc.addTag: "添加新标签";
```

###### zh.misc.addTags

```ts
readonly misc.addTags: "添加标签...";
```

###### zh.misc.allDay

```ts
readonly misc.allDay: "全天";
```

###### zh.misc.appearance

```ts
readonly misc.appearance: "外观";
```

###### zh.misc.applications

```ts
readonly misc.applications: "应用";
```

###### zh.misc.assigned

```ts
readonly misc.assigned: "已安排 {count} 项";
```

###### zh.misc.breadcrumb

```ts
readonly misc.breadcrumb: "面包屑";
```

###### zh.misc.browseAndChoose

```ts
readonly misc.browseAndChoose: "浏览并选择要前往的位置。";
```

###### zh.misc.calendarGrid

```ts
readonly misc.calendarGrid: "日历网格";
```

###### zh.misc.calendarNext

```ts
readonly misc.calendarNext: "下一时段";
```

###### zh.misc.calendarPrevious

```ts
readonly misc.calendarPrevious: "上一时段";
```

###### zh.misc.calendarSidebar

```ts
readonly misc.calendarSidebar: "日历侧栏";
```

###### zh.misc.calendarView

```ts
readonly misc.calendarView: "视图：{view}";
```

###### zh.misc.cancelledFile

```ts
readonly misc.cancelledFile: "已取消上传 {file}";
```

###### zh.misc.cellAssignments

```ts
readonly misc.cellAssignments: "{day} 的 {resource} 共 {count} 项安排";
```

###### zh.misc.chartLoading

```ts
readonly misc.chartLoading: "图表加载中";
```

###### zh.misc.chartNoData

```ts
readonly misc.chartNoData: "暂无数据";
```

###### zh.misc.chartScrollable

```ts
readonly misc.chartScrollable: "可滚动图表：{title}";
```

###### zh.misc.clearButton

```ts
readonly misc.clearButton: "清除";
```

###### zh.misc.closeWorkspaceNavigation

```ts
readonly misc.closeWorkspaceNavigation: "关闭工作区导航";
```

###### zh.misc.collapseSidebar

```ts
readonly misc.collapseSidebar: "收起侧边栏";
```

###### zh.misc.commandNoResults

```ts
readonly misc.commandNoResults: "未找到命令";
```

###### zh.misc.commandPlaceholder

```ts
readonly misc.commandPlaceholder: "输入命令或搜索…";
```

###### zh.misc.conversationMessages

```ts
readonly misc.conversationMessages: "对话消息";
```

###### zh.misc.createOn

```ts
readonly misc.createOn: "在 {day} 为 {resource} 创建安排";
```

###### zh.misc.csvParsingWarnings

```ts
readonly misc.csvParsingWarnings: "{count} 个解析警告 - 部分数据可能无法正确显示";
```

###### zh.misc.csvShowingRows

```ts
readonly misc.csvShowingRows: "显示 {count} 行中的前 50 行";
```

###### zh.misc.currentProgress

```ts
readonly misc.currentProgress: "当前进度";
```

###### zh.misc.currentRating

```ts
readonly misc.currentRating: "当前评分";
```

###### zh.misc.dataChart

```ts
readonly misc.dataChart: "数据图表";
```

###### zh.misc.day

```ts
readonly misc.day: "日";
```

###### zh.misc.dayEvents

```ts
readonly misc.dayEvents: "日事件";
```

###### zh.misc.dropFilesHere

```ts
readonly misc.dropFilesHere: "将文件拖到此处或点击浏览";
```

###### zh.misc.emptyFolder

```ts
readonly misc.emptyFolder: "空文件夹";
```

###### zh.misc.errorUploadingFile

```ts
readonly misc.errorUploadingFile: "上传 {file} 失败";
```

###### zh.misc.eventCount

```ts
readonly misc.eventCount: "共 {count} 个事件";
```

###### zh.misc.expandSidebar

```ts
readonly misc.expandSidebar: "展开侧边栏";
```

###### zh.misc.failedToFetchFile

```ts
readonly misc.failedToFetchFile: "获取文件失败。";
```

###### zh.misc.failedToLoadFolder

```ts
readonly misc.failedToLoadFolder: "无法加载文件夹";
```

###### zh.misc.failedToLoadPdf

```ts
readonly misc.failedToLoadPdf: "PDF 加载失败";
```

###### zh.misc.failedToLoadPreview

```ts
readonly misc.failedToLoadPreview: "预览加载失败：{error}";
```

###### zh.misc.fileTypeNotAllowed

```ts
readonly misc.fileTypeNotAllowed: "不允许文件类型 {type}";
```

###### zh.misc.fileTypes

```ts
readonly misc.fileTypes: "{types} 文件";
```

###### zh.misc.frameMobileDescription

```ts
readonly misc.frameMobileDescription: "浏览此区域并选择要前往的位置。";
```

###### zh.misc.imagePreviewUnavailable

```ts
readonly misc.imagePreviewUnavailable: "图片预览不可用。";
```

###### zh.misc.impersonate

```ts
readonly misc.impersonate: "身份模拟";
```

###### zh.misc.impersonateHint

```ts
readonly misc.impersonateHint: "以其他团队的策略范围预览此工作区。";
```

###### zh.misc.items

```ts
readonly misc.items: "共 {count} 项";
```

###### zh.misc.language

```ts
readonly misc.language: "语言";
```

###### zh.misc.loadingPreview

```ts
readonly misc.loadingPreview: "正在加载预览…";
```

###### zh.misc.localeName.en

```ts
readonly misc.localeName.en: "English";
```

###### zh.misc.localeName.zh

```ts
readonly misc.localeName.zh: "中文";
```

###### zh.misc.logout

```ts
readonly misc.logout: "退出登录";
```

###### zh.misc.markdownAdvancedBlocks

```ts
readonly misc.markdownAdvancedBlocks: "高级块";
```

###### zh.misc.markdownAttachFiles

```ts
readonly misc.markdownAttachFiles: "附加文件…";
```

###### zh.misc.markdownBlockquote

```ts
readonly misc.markdownBlockquote: "引用块";
```

###### zh.misc.markdownBulletedList

```ts
readonly misc.markdownBulletedList: "项目符号列表";
```

###### zh.misc.markdownChecklist

```ts
readonly misc.markdownChecklist: "任务清单";
```

###### zh.misc.markdownHeading1

```ts
readonly misc.markdownHeading1: "标题 1";
```

###### zh.misc.markdownHeading2

```ts
readonly misc.markdownHeading2: "标题 2";
```

###### zh.misc.markdownHeading3

```ts
readonly misc.markdownHeading3: "标题 3";
```

###### zh.misc.markdownHorizontalRule

```ts
readonly misc.markdownHorizontalRule: "分割线";
```

###### zh.misc.markdownInputPlaceholder

```ts
readonly misc.markdownInputPlaceholder: "输入内容…";
```

###### zh.misc.markdownInsertImage

```ts
readonly misc.markdownInsertImage: "插入图片…";
```

###### zh.misc.markdownInsertLink

```ts
readonly misc.markdownInsertLink: "插入链接…";
```

###### zh.misc.markdownLists

```ts
readonly misc.markdownLists: "列表";
```

###### zh.misc.markdownMedia

```ts
readonly misc.markdownMedia: "媒体";
```

###### zh.misc.markdownNumberedList

```ts
readonly misc.markdownNumberedList: "编号列表";
```

###### zh.misc.markdownPlaceholder

```ts
readonly misc.markdownPlaceholder: "输入 \"/\" 查看命令…";
```

###### zh.misc.markdownText

```ts
readonly misc.markdownText: "正文";
```

###### zh.misc.markdownTypography

```ts
readonly misc.markdownTypography: "排版";
```

###### zh.misc.maximumFilesReached

```ts
readonly misc.maximumFilesReached: "已达到文件数量上限";
```

###### zh.misc.maxSizeEach

```ts
readonly misc.maxSizeEach: "每个不超过 {size}";
```

###### zh.misc.mentionKeyboardHint

```ts
readonly misc.mentionKeyboardHint: "↑↓ 导航 · Enter 添加";
```

###### zh.misc.mentionMenu

```ts
readonly misc.mentionMenu: "提及菜单";
```

###### zh.misc.mentionTree

```ts
readonly misc.mentionTree: "提及树";
```

###### zh.misc.menuKeyboard

```ts
readonly misc.menuKeyboard: "键盘导航";
```

###### zh.misc.month

```ts
readonly misc.month: "月";
```

###### zh.misc.monthEvents

```ts
readonly misc.monthEvents: "月事件";
```

###### zh.misc.moreItems

```ts
readonly misc.moreItems: "还有 {count} 项";
```

###### zh.misc.moreTags

```ts
readonly misc.moreTags: "还有 {count} 个标签";
```

###### zh.misc.navigation

```ts
readonly misc.navigation: "导航";
```

###### zh.misc.nextMonth

```ts
readonly misc.nextMonth: "下个月";
```

###### zh.misc.noColorsFound

```ts
readonly misc.noColorsFound: "未找到颜色。";
```

###### zh.misc.noEvents

```ts
readonly misc.noEvents: "暂无事件";
```

###### zh.misc.noItemsFound

```ts
readonly misc.noItemsFound: "未找到条目";
```

###### zh.misc.noItemsToDisplay

```ts
readonly misc.noItemsToDisplay: "没有可显示的条目";
```

###### zh.misc.noMessagesYet

```ts
readonly misc.noMessagesYet: "暂无消息";
```

###### zh.misc.none

```ts
readonly misc.none: "无";
```

###### zh.misc.noProgressAssigned

```ts
readonly misc.noProgressAssigned: "未设置进度";
```

###### zh.misc.noProgressConfigured

```ts
readonly misc.noProgressConfigured: "未配置进度";
```

###### zh.misc.noProgressSelected

```ts
readonly misc.noProgressSelected: "未选择进度";
```

###### zh.misc.noRatingsAssigned

```ts
readonly misc.noRatingsAssigned: "未设置评分";
```

###### zh.misc.noRatingsConfigured

```ts
readonly misc.noRatingsConfigured: "未配置评分";
```

###### zh.misc.noRatingsSelected

```ts
readonly misc.noRatingsSelected: "未选择评分";
```

###### zh.misc.openAccountMenu

```ts
readonly misc.openAccountMenu: "打开账户菜单";
```

###### zh.misc.openNavigation

```ts
readonly misc.openNavigation: "打开 {navigation}";
```

###### zh.misc.pageSize

```ts
readonly misc.pageSize: "每页数量";
```

###### zh.misc.pdfPreview

```ts
readonly misc.pdfPreview: "PDF 预览";
```

###### zh.misc.pdfPreviewUnavailable

```ts
readonly misc.pdfPreviewUnavailable: "PDF 预览不可用，请在新标签页中打开。";
```

###### zh.misc.platform

```ts
readonly misc.platform: "平台";
```

###### zh.misc.previewLoadError

```ts
readonly misc.previewLoadError: "预览加载出错";
```

###### zh.misc.previousMonth

```ts
readonly misc.previousMonth: "上个月";
```

###### zh.misc.primaryNavigation

```ts
readonly misc.primaryNavigation: "主导航";
```

###### zh.misc.progress

```ts
readonly misc.progress: "进度";
```

###### zh.misc.progressAria

```ts
readonly misc.progressAria: "进度 {index}";
```

###### zh.misc.progressComplete

```ts
readonly misc.progressComplete: "已完成";
```

###### zh.misc.progressDetails

```ts
readonly misc.progressDetails: "进度详情";
```

###### zh.misc.progressEmpty

```ts
readonly misc.progressEmpty: "未填写";
```

###### zh.misc.progressIndex

```ts
readonly misc.progressIndex: "进度 #{index}";
```

###### zh.misc.ratingDetails

```ts
readonly misc.ratingDetails: "评分详情";
```

###### zh.misc.ratingIndex

```ts
readonly misc.ratingIndex: "评分 #{index}";
```

###### zh.misc.reference

```ts
readonly misc.reference: "引用";
```

###### zh.misc.removeFile

```ts
readonly misc.removeFile: "移除文件";
```

###### zh.misc.removeItem

```ts
readonly misc.removeItem: "移除 {name}";
```

###### zh.misc.removeTag

```ts
readonly misc.removeTag: "移除标签";
```

###### zh.misc.resizeEnd

```ts
readonly misc.resizeEnd: "调整结束位置";
```

###### zh.misc.resizePanel

```ts
readonly misc.resizePanel: "调整面板大小";
```

###### zh.misc.resizePanelHeight

```ts
readonly misc.resizePanelHeight: "调整面板高度";
```

###### zh.misc.resizeStart

```ts
readonly misc.resizeStart: "调整开始位置";
```

###### zh.misc.resources

```ts
readonly misc.resources: "资源";
```

###### zh.misc.resourceSchedule

```ts
readonly misc.resourceSchedule: "资源排期";
```

###### zh.misc.retryUpload

```ts
readonly misc.retryUpload: "重试上传";
```

###### zh.misc.roleLabel

```ts
readonly misc.roleLabel: "角色：{role}";
```

###### zh.misc.searchColors

```ts
readonly misc.searchColors: "搜索颜色…";
```

###### zh.misc.searchEllipsis

```ts
readonly misc.searchEllipsis: "搜索…";
```

###### zh.misc.searchOrganizations

```ts
readonly misc.searchOrganizations: "搜索组织…";
```

###### zh.misc.searchTree

```ts
readonly misc.searchTree: "搜索树";
```

###### zh.misc.selectColorFor

```ts
readonly misc.selectColorFor: "为 \"{value}\" 选择颜色";
```

###### zh.misc.selectCountry

```ts
readonly misc.selectCountry: "选择国家";
```

###### zh.misc.selectEllipsis

```ts
readonly misc.selectEllipsis: "选择…";
```

###### zh.misc.selectOrganization

```ts
readonly misc.selectOrganization: "选择组织";
```

###### zh.misc.selectProgress

```ts
readonly misc.selectProgress: "选择进度";
```

###### zh.misc.selectRating

```ts
readonly misc.selectRating: "选择评分";
```

###### zh.misc.shellMobileDescription

```ts
readonly misc.shellMobileDescription: "切换组织、打开应用或管理您的账户。";
```

###### zh.misc.sidebar

```ts
readonly misc.sidebar: "侧边栏";
```

###### zh.misc.startConversation

```ts
readonly misc.startConversation: "开始对话以查看消息";
```

###### zh.misc.statusLabel

```ts
readonly misc.statusLabel: "状态：{status}";
```

###### zh.misc.stepDetails

```ts
readonly misc.stepDetails: "{label}。可查看步骤详情。";
```

###### zh.misc.stepOf

```ts
readonly misc.stepOf: "第 {current} 步，共 {total} 步";
```

###### zh.misc.stopImpersonating

```ts
readonly misc.stopImpersonating: "停止模拟";
```

###### zh.misc.switchingTo

```ts
readonly misc.switchingTo: "正在切换到 {organization}";
```

###### zh.misc.switchLocale

```ts
readonly misc.switchLocale: "切换到 {locale}";
```

###### zh.misc.switchToDarkMode

```ts
readonly misc.switchToDarkMode: "切换到深色模式";
```

###### zh.misc.switchToLightMode

```ts
readonly misc.switchToLightMode: "切换到浅色模式";
```

###### zh.misc.themeName.dark

```ts
readonly misc.themeName.dark: "深色";
```

###### zh.misc.themeName.light

```ts
readonly misc.themeName.light: "浅色";
```

###### zh.misc.timeline

```ts
readonly misc.timeline: "时间线";
```

###### zh.misc.timeRangeSeparator

```ts
readonly misc.timeRangeSeparator: "至";
```

###### zh.misc.timeRangeStartAfterEnd

```ts
readonly misc.timeRangeStartAfterEnd: "开始时间必须早于结束时间";
```

###### zh.misc.timezoneLocal

```ts
readonly misc.timezoneLocal: "本地时间";
```

###### zh.misc.toastError

```ts
readonly misc.toastError: "出错了";
```

###### zh.misc.toastSuccess

```ts
readonly misc.toastSuccess: "完成";
```

###### zh.misc.today

```ts
readonly misc.today: "今天";
```

###### zh.misc.toggleSidebar

```ts
readonly misc.toggleSidebar: "切换侧边栏";
```

###### zh.misc.totalFiles

```ts
readonly misc.totalFiles: "文件总数（{count}）";
```

###### zh.misc.treeNavigation

```ts
readonly misc.treeNavigation: "树形导航";
```

###### zh.misc.unknownFile

```ts
readonly misc.unknownFile: "未知文件";
```

###### zh.misc.unnamed

```ts
readonly misc.unnamed: "(未命名)";
```

###### zh.misc.uploadedFiles

```ts
readonly misc.uploadedFiles: "已上传文件";
```

###### zh.misc.upToFiles

```ts
readonly misc.upToFiles: "最多 {count} 个文件";
```

###### zh.misc.valueTable

```ts
readonly misc.valueTable: "值表格";
```

###### zh.misc.viewSummary

```ts
readonly misc.viewSummary: "查看摘要";
```

###### zh.misc.week

```ts
readonly misc.week: "周";
```

###### zh.misc.weekEvents

```ts
readonly misc.weekEvents: "周事件";
```

###### zh.misc.workspaceNavigation

```ts
readonly misc.workspaceNavigation: "工作区导航";
```

###### zh.misc.year

```ts
readonly misc.year: "年";
```

###### zh.recordMetadata.deletionRestricted

```ts
readonly recordMetadata.deletionRestricted: "无法删除";
```

###### zh.recordMetadata.pendingApproval

```ts
readonly recordMetadata.pendingApproval: "等待审批";
```

###### zh.recordMetadata.pendingApprovalReason

```ts
readonly recordMetadata.pendingApprovalReason: "审批请求处理期间，此记录为只读。";
```

###### zh.recordMetadata.readOnly

```ts
readonly recordMetadata.readOnly: "只读";
```

###### zh.recordMetadata.readOnlyMove

```ts
readonly recordMetadata.readOnlyMove: "此记录无法移动：{reason}";
```

###### zh.recordMetadata.selectedDeleteRestricted

```ts
readonly recordMetadata.selectedDeleteRestricted: "所选记录无法删除：{reason}";
```

###### zh.recordMetadata.selectedUpdateRestricted

```ts
readonly recordMetadata.selectedUpdateRestricted: "所选记录无法更新：{reason}";
```

###### zh.recordMetadata.updatesRestricted

```ts
readonly recordMetadata.updatesRestricted: "无法更新";
```

###### zh.table.aboutCollection

```ts
readonly table.aboutCollection: "关于此集合";
```

###### zh.table.actionRefreshFailed

```ts
readonly table.actionRefreshFailed: "操作已完成，但表格未刷新";
```

###### zh.table.all

```ts
readonly table.all: "全部";
```

###### zh.table.applicationLock

```ts
readonly table.applicationLock: "应用";
```

###### zh.table.appliedByView

```ts
readonly table.appliedByView: "由当前视图应用";
```

###### zh.table.appliedFilters

```ts
readonly table.appliedFilters: "已应用的筛选";
```

###### zh.table.approvalActionFailed

```ts
readonly table.approvalActionFailed: "审批操作失败";
```

###### zh.table.approvalApproved

```ts
readonly table.approvalApproved: "请求已批准";
```

###### zh.table.approvalAwaiting

```ts
readonly table.approvalAwaiting: "此记录正在等待审批。";
```

###### zh.table.approvalChangesRequested

```ts
readonly table.approvalChangesRequested: "已请求变更";
```

###### zh.table.approvalLoading

```ts
readonly table.approvalLoading: "正在加载审批状态…";
```

###### zh.table.approvalRegion

```ts
readonly table.approvalRegion: "{title} 审批";
```

###### zh.table.approvalRejected

```ts
readonly table.approvalRejected: "请求已驳回";
```

###### zh.table.approvalRequest

```ts
readonly table.approvalRequest: "审批请求";
```

###### zh.table.approvalRequestId

```ts
readonly table.approvalRequestId: "请求 ID";
```

###### zh.table.approvalStatus

```ts
readonly table.approvalStatus: "状态：{status}";
```

###### zh.table.approvalSuperseded

```ts
readonly table.approvalSuperseded: "审批已被越级完成";
```

###### zh.table.approvalWithdrawFailed

```ts
readonly table.approvalWithdrawFailed: "无法撤回审批请求";
```

###### zh.table.approvalWithdrawn

```ts
readonly table.approvalWithdrawn: "审批请求已撤回";
```

###### zh.table.approve

```ts
readonly table.approve: "批准";
```

###### zh.table.bulkDeleted

```ts
readonly table.bulkDeleted: "已删除{label}";
```

###### zh.table.bulkFailed

```ts
readonly table.bulkFailed: "批量{kind}失败";
```

###### zh.table.bulkStep1

```ts
readonly table.bulkStep1: "1. 选择字段";
```

###### zh.table.bulkStep2

```ts
readonly table.bulkStep2: "2. 设置新值";
```

###### zh.table.bulkStep3

```ts
readonly table.bulkStep3: "3. 确认更新";
```

###### zh.table.bulkUpdate

```ts
readonly table.bulkUpdate: "批量更新";
```

###### zh.table.bulkUpdated

```ts
readonly table.bulkUpdated: "已更新{label}";
```

###### zh.table.changeRequestReason

```ts
readonly table.changeRequestReason: "变更请求原因";
```

###### zh.table.chooseField

```ts
readonly table.chooseField: "选择字段";
```

###### zh.table.chooseFieldToUpdate

```ts
readonly table.chooseFieldToUpdate: "选择要更新的字段";
```

###### zh.table.chooseFilterField

```ts
readonly table.chooseFilterField: "选择筛选字段";
```

###### zh.table.chooseOperator

```ts
readonly table.chooseOperator: "选择运算符";
```

###### zh.table.clearAll

```ts
readonly table.clearAll: "全部清除";
```

###### zh.table.closeRecordDetail

```ts
readonly table.closeRecordDetail: "关闭记录详情";
```

###### zh.table.collapse

```ts
readonly table.collapse: "收起";
```

###### zh.table.collapseRowDetails

```ts
readonly table.collapseRowDetails: "收起行详情";
```

###### zh.table.collectionActions

```ts
readonly table.collectionActions: "集合操作";
```

###### zh.table.collectionActionsDescription

```ts
readonly table.collectionActionsDescription: "运行已配置的流程或更改选中的记录。";
```

###### zh.table.columnActions

```ts
readonly table.columnActions: "列操作";
```

###### zh.table.columns

```ts
readonly table.columns: "列";
```

###### zh.table.columnToggle

```ts
readonly table.columnToggle: "切换列显示";
```

###### zh.table.confirmDeleteDescription

```ts
readonly table.confirmDeleteDescription: "这将永久删除选中的记录。关联记录或集合策略可能阻止删除。";
```

###### zh.table.confirmDeleteTitle

```ts
readonly table.confirmDeleteTitle: "删除{label}？";
```

###### zh.table.confirmUpdate

```ts
readonly table.confirmUpdate: "确认更新";
```

###### zh.table.confirmUpdateDescription

```ts
readonly table.confirmUpdateDescription: "所有选中的记录都将应用相同的值：{field}。";
```

###### zh.table.confirmUpdateTitle

```ts
readonly table.confirmUpdateTitle: "更新{label}？";
```

###### zh.table.createFormDescription

```ts
readonly table.createFormDescription: "{label} 表单";
```

###### zh.table.deleteRecords

```ts
readonly table.deleteRecords: "删除记录";
```

###### zh.table.deleteSelectedLabel

```ts
readonly table.deleteSelectedLabel: "删除{label}。";
```

###### zh.table.describeChangesPlaceholder

```ts
readonly table.describeChangesPlaceholder: "描述需要进行的更改";
```

###### zh.table.detailMissingId

```ts
readonly table.detailMissingId: "无法打开详情：缺少 {field}。";
```

###### zh.table.detailOpen

```ts
readonly table.detailOpen: "打开记录";
```

###### zh.table.detailUnavailable

```ts
readonly table.detailUnavailable: "记录详情不可用。";
```

###### zh.table.display

```ts
readonly table.display: "显示";
```

###### zh.table.emptyState

```ts
readonly table.emptyState: "暂无记录";
```

###### zh.table.emptyStateFiltered

```ts
readonly table.emptyStateFiltered: "没有符合当前筛选条件的记录";
```

###### zh.table.emptyStateHint

```ts
readonly table.emptyStateHint: "请调整搜索或筛选条件";
```

###### zh.table.expand

```ts
readonly table.expand: "展开";
```

###### zh.table.expandRowDetails

```ts
readonly table.expandRowDetails: "展开行详情";
```

###### zh.table.export

```ts
readonly table.export: "导出";
```

###### zh.table.filterActive

```ts
readonly table.filterActive: "已应用筛选";
```

###### zh.table.filterAdd

```ts
readonly table.filterAdd: "添加筛选条件";
```

###### zh.table.filterAnd

```ts
readonly table.filterAnd: "并且";
```

###### zh.table.filterAnyOf

```ts
readonly table.filterAnyOf: "任意一项：{values}";
```

###### zh.table.filterAtLeast

```ts
readonly table.filterAtLeast: "{label}不小于{value}";
```

###### zh.table.filterAtMost

```ts
readonly table.filterAtMost: "{label}不大于{value}";
```

###### zh.table.filterContains

```ts
readonly table.filterContains: "{label}包含{value}";
```

###### zh.table.filterFields

```ts
readonly table.filterFields: "筛选字段";
```

###### zh.table.filterGreaterThan

```ts
readonly table.filterGreaterThan: "{label}大于{value}";
```

###### zh.table.filterIs

```ts
readonly table.filterIs: "{label}为{value}";
```

###### zh.table.filterIsEmpty

```ts
readonly table.filterIsEmpty: "{label}为空";
```

###### zh.table.filterIsNot

```ts
readonly table.filterIsNot: "{label}不是{value}";
```

###### zh.table.filterIsNotEmpty

```ts
readonly table.filterIsNotEmpty: "{label}不为空";
```

###### zh.table.filterLessThan

```ts
readonly table.filterLessThan: "{label}小于{value}";
```

###### zh.table.filterNot

```ts
readonly table.filterNot: "非{label}";
```

###### zh.table.filterOr

```ts
readonly table.filterOr: "或者";
```

###### zh.table.filterRecords

```ts
readonly table.filterRecords: "筛选记录";
```

###### zh.table.filterRemove

```ts
readonly table.filterRemove: "移除筛选条件";
```

###### zh.table.filters

```ts
readonly table.filters: "筛选条件";
```

###### zh.table.filtersAllMatch

```ts
readonly table.filtersAllMatch: "所有条件必须同时满足。";
```

###### zh.table.fitAll

```ts
readonly table.fitAll: "适应全部";
```

###### zh.table.fitColumn

```ts
readonly table.fitColumn: "适应列宽";
```

###### zh.table.format

```ts
readonly table.format: "格式";
```

###### zh.table.groupBy

```ts
readonly table.groupBy: "分组依据";
```

###### zh.table.hideColumn

```ts
readonly table.hideColumn: "隐藏列";
```

###### zh.table.import

```ts
readonly table.import: "导入";
```

###### zh.table.integrations

```ts
readonly table.integrations: "集成";
```

###### zh.table.linksTo

```ts
readonly table.linksTo: "关联到{target}";
```

###### zh.table.loadError

```ts
readonly table.loadError: "出错了";
```

###### zh.table.loading

```ts
readonly table.loading: "正在加载记录…";
```

###### zh.table.loadingRecord

```ts
readonly table.loadingRecord: "正在加载记录…";
```

###### zh.table.metadataError

```ts
readonly table.metadataError: "没有 {collection} 的字段元数据。";
```

###### zh.table.nextPage

```ts
readonly table.nextPage: "下一页";
```

###### zh.table.noApprovalRequest

```ts
readonly table.noApprovalRequest: "没有审批请求";
```

###### zh.table.noApprovalRequestDesc

```ts
readonly table.noApprovalRequestDesc: "此记录尚无审批流程活动。";
```

###### zh.table.noCustomView

```ts
readonly table.noCustomView: "没有自定义记录视图";
```

###### zh.table.noCustomViewDesc

```ts
readonly table.noCustomViewDesc: "此集合没有专用的界面表示。使用原始视图检查其字段。";
```

###### zh.table.noFiltersApplied

```ts
readonly table.noFiltersApplied: "未应用筛选条件。";
```

###### zh.table.noIntegrationsConfigured

```ts
readonly table.noIntegrationsConfigured: "未配置集成";
```

###### zh.table.noIntegrationsDescription

```ts
readonly table.noIntegrationsDescription: "此集合当前未连接到外部集成。";
```

###### zh.table.noPipelinesConfigured

```ts
readonly table.noPipelinesConfigured: "未配置{kind}流程";
```

###### zh.table.noPipelinesDeclared

```ts
readonly table.noPipelinesDeclared: "此集合当前未声明{kind}流程。";
```

###### zh.table.noValueNeeded

```ts
readonly table.noValueNeeded: "无需值";
```

###### zh.table.openCollectionActions

```ts
readonly table.openCollectionActions: "打开集合操作";
```

###### zh.table.pageOf

```ts
readonly table.pageOf: "第 {page} 页，共 {pages} 页";
```

###### zh.table.pageSizeDisabled

```ts
readonly table.pageSizeDisabled: "每页行数已禁用";
```

###### zh.table.pendingApproval

```ts
readonly table.pendingApproval: "等待审批";
```

###### zh.table.pendingSync

```ts
readonly table.pendingSync: "尚未保存，等待同步";
```

###### zh.table.perPage

```ts
readonly table.perPage: "/ 页";
```

###### zh.table.pinColumn

```ts
readonly table.pinColumn: "固定列";
```

###### zh.table.pipelineDescription

```ts
readonly table.pipelineDescription: "{label} {kind}流程。";
```

###### zh.table.pipelineFailed

```ts
readonly table.pipelineFailed: "{label}执行失败";
```

###### zh.table.pipelineSelectRows

```ts
readonly table.pipelineSelectRows: "选择一行或多行以运行{label}。";
```

###### zh.table.previousPage

```ts
readonly table.previousPage: "上一页";
```

###### zh.table.rawRegion

```ts
readonly table.rawRegion: "{title} 原始数据";
```

###### zh.table.recordDescription

```ts
readonly table.recordDescription: "{name} 记录";
```

###### zh.table.recordDetails

```ts
readonly table.recordDetails: "{name} 记录详情";
```

###### zh.table.recordLoadFailed

```ts
readonly table.recordLoadFailed: "无法加载记录";
```

###### zh.table.recordLocked

```ts
readonly table.recordLocked: "应用锁定 — 此记录不能再更改";
```

###### zh.table.recordsRegion

```ts
readonly table.recordsRegion: "记录列表";
```

###### zh.table.recordUnavailable

```ts
readonly table.recordUnavailable: "此记录已不可用。";
```

###### zh.table.refresh

```ts
readonly table.refresh: "刷新数据";
```

###### zh.table.refreshFailed

```ts
readonly table.refreshFailed: "刷新失败";
```

###### zh.table.reject

```ts
readonly table.reject: "驳回";
```

###### zh.table.reorderColumns

```ts
readonly table.reorderColumns: "调整列顺序";
```

###### zh.table.requestChanges

```ts
readonly table.requestChanges: "请求变更";
```

###### zh.table.requestChangesDescription

```ts
readonly table.requestChangesDescription: "请说明在此请求获得批准前需要更改的内容。";
```

###### zh.table.requesting

```ts
readonly table.requesting: "正在请求…";
```

###### zh.table.resetWidth

```ts
readonly table.resetWidth: "重置列宽";
```

###### zh.table.resizeColumn

```ts
readonly table.resizeColumn: "调整列宽";
```

###### zh.table.reviewDeletion

```ts
readonly table.reviewDeletion: "确认删除";
```

###### zh.table.rowActions

```ts
readonly table.rowActions: "行操作";
```

###### zh.table.rowCount

```ts
readonly table.rowCount: "共 {count} 行";
```

###### zh.table.rowsPerPage

```ts
readonly table.rowsPerPage: "每页行数";
```

###### zh.table.rowsRegion

```ts
readonly table.rowsRegion: "表格行区域";
```

###### zh.table.run

```ts
readonly table.run: "运行";
```

###### zh.table.runPipeline

```ts
readonly table.runPipeline: "运行{label}";
```

###### zh.table.searchActive

```ts
readonly table.searchActive: "搜索已应用";
```

###### zh.table.searchFields

```ts
readonly table.searchFields: "搜索字段…";
```

###### zh.table.searchFieldsOverflow

```ts
readonly table.searchFieldsOverflow: "{fields} 等 {count} 项";
```

###### zh.table.searchIn

```ts
readonly table.searchIn: "搜索{fields}…";
```

###### zh.table.searchRecords

```ts
readonly table.searchRecords: "搜索记录";
```

###### zh.table.selectAllRows

```ts
readonly table.selectAllRows: "全选所有行";
```

###### zh.table.selectedCount

```ts
readonly table.selectedCount: "已选择 {count} 项";
```

###### zh.table.selectedFraction

```ts
readonly table.selectedFraction: "已选择 {selected} / {total} 项";
```

###### zh.table.selectedRecord

```ts
readonly table.selectedRecord: "已选择 {count} 条记录";
```

###### zh.table.selectedRecords

```ts
readonly table.selectedRecords: "已选择 {count} 条记录";
```

###### zh.table.selectFieldPlaceholder

```ts
readonly table.selectFieldPlaceholder: "选择基础字段或关联字段";
```

###### zh.table.selectRecordLabel

```ts
readonly table.selectRecordLabel: "选择{label}";
```

###### zh.table.selectRow

```ts
readonly table.selectRow: "选择该行";
```

###### zh.table.showColumn

```ts
readonly table.showColumn: "显示列";
```

###### zh.table.sizing

```ts
readonly table.sizing: "尺寸";
```

###### zh.table.sortAscending

```ts
readonly table.sortAscending: "升序排列";
```

###### zh.table.sortClear

```ts
readonly table.sortClear: "清除排序";
```

###### zh.table.sortClearLabel

```ts
readonly table.sortClearLabel: "清除{label}的排序";
```

###### zh.table.sortDescending

```ts
readonly table.sortDescending: "降序排列";
```

###### zh.table.sortLabelAscending

```ts
readonly table.sortLabelAscending: "将{label}升序排列";
```

###### zh.table.sortLabelDescending

```ts
readonly table.sortLabelDescending: "将{label}降序排列";
```

###### zh.table.supersedeApproval

```ts
readonly table.supersedeApproval: "越级完成审批";
```

###### zh.table.supersedeApprovalDescription

```ts
readonly table.supersedeApprovalDescription: "完成所有剩余审批阶段。这是例外操作，并会记录在审计日志中。";
```

###### zh.table.supersedeReason

```ts
readonly table.supersedeReason: "越级完成原因";
```

###### zh.table.supersedeReasonPlaceholder

```ts
readonly table.supersedeReasonPlaceholder: "说明为何需要跳过剩余审核";
```

###### zh.table.supersedingApproval

```ts
readonly table.supersedingApproval: "正在越级完成…";
```

###### zh.table.systemFields

```ts
readonly table.systemFields: "系统字段";
```

###### zh.table.systemLock

```ts
readonly table.systemLock: "系统";
```

###### zh.table.systemLockPendingApproval

```ts
readonly table.systemLockPendingApproval: "系统锁定 — 等待审批";
```

###### zh.table.tabApproval

```ts
readonly table.tabApproval: "审批";
```

###### zh.table.tabRaw

```ts
readonly table.tabRaw: "原始数据";
```

###### zh.table.tabUi

```ts
readonly table.tabUi: "界面";
```

###### zh.table.toolbarRegion

```ts
readonly table.toolbarRegion: "集合工具栏";
```

###### zh.table.unableToLoadRecords

```ts
readonly table.unableToLoadRecords: "无法加载记录";
```

###### zh.table.ungroup

```ts
readonly table.ungroup: "取消分组";
```

###### zh.table.unpinColumn

```ts
readonly table.unpinColumn: "取消固定列";
```

###### zh.table.viewDisabled

```ts
readonly table.viewDisabled: "此视图当前不接受更改。";
```

###### zh.table.withdrawRequest

```ts
readonly table.withdrawRequest: "撤回请求";
```
