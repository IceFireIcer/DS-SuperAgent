# DS SuperAgent logo

The transparent whale mark comes from `source/logo-source.png`. `source/whale.template.svg`
holds its vector geometry; `build.mjs` fills the template with each palette and writes the
exports below.

## Files

- `whale.svg`, `whale.png`: the tight transparent mark.
- `logo.svg`, `logo.png`: the square app icon.
- `logo.ico`: Windows icon with 16 to 256 px images.
- `variants/<colour>/`: the same four files in another colour.
- `preview.png`: all palettes on one sheet.

The root files are the primary blue set. Available colours: `aurora`, `rose`, `tangerine`,
`violet`, `sky`, `emerald`, and `graphite`.

## Rebuild

```sh
node logo/build.mjs
```
