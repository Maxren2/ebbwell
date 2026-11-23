# Translations

The app's locale files are nested i18next JSON v4 catalogs in `shared/i18n/locales/`. English (`en.json`) is the source of truth; the supported locales are `en`, `fr`, `de`, `sv`, and `ar`.

## Weblate component

The public [Ebbwell project on Hosted Weblate](https://hosted.weblate.org/projects/ebbwell/) is ready for its repository component. Configure one component with:

- **Repository:** `https://github.com/Maxren2/ebbwell`
- **Branch:** `main`
- **File format:** i18next JSON file v4 (`i18nextv4`)
- **File mask:** `shared/i18n/locales/*.json`
- **Source language:** English

The JSON format does not carry translator comments or descriptions. Keep keys understandable, maintain a project glossary in Weblate, and use the review process for strings whose meaning is not clear from their key and surrounding text.

## Changes and review

Edit English source strings in `shared/i18n/locales/en.json`. Translation updates should arrive as ordinary reviewed changes; do not accept generated code or runtime changes from translation-only contributions. CI checks raw locale key parity, supported interpolation variables, required CLDR plural categories, application-level message completeness, and the normal test suite.

Plural forms use i18next v4 CLDR suffixes such as `_one`, `_few`, and `_other`, with `{{count}}` interpolation. Preserve every placeholder used by a string. Some languages can omit the count from a grammatically complete form, but must not introduce placeholder names that the runtime does not provide.

Adding a new application message also requires updating the typed `Messages` contract in `shared/i18n/catalog-types.d.ts`; dynamic messages must be registered in `shared/i18n/bindings.ts` with their argument names and plural behavior.

The Weblate project exists, but its repository component is not connected yet. Connect it after these JSON catalogs are available on the repository's `main` branch.
