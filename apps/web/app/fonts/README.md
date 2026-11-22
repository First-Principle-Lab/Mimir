# Local web fonts

Archivo and DM Sans retain the application's existing font families, CSS
variables and weight ranges. Local assets let a fresh static build work without
Google Fonts CSS or download availability.

The variable TTF sources come from the Google Fonts repository. `sources.json`
records their URLs and SHA-256 hashes, plus the hashes of the shipped WOFF2
files. The only transformation is compression with `woff2_compress`; no glyphs
were removed. Each font's SIL Open Font License is included alongside it.
