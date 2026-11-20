# Third-party notices

Vibe is licensed under the [MIT License](LICENSE). It is built on other people's work, which stays under its own licenses.

## Shipped inside a built Vibe

A built web app, a compiled `vibe` and the container image carry these with them.

| What                                                                                                               | License                                             | Copyright                           |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------- |
| Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono, the web app's typefaces, through `@fontsource-variable` | SIL OFL 1.1                                         | Braille Institute of America, Inc.  |
| React and React DOM                                                                                                | MIT                                                 | Meta Platforms, Inc. and affiliates |
| react-markdown, remark-gfm and the unified packages under them                                                     | MIT                                                 | Their authors                       |
| Elysia                                                                                                             | MIT                                                 | Its authors                         |
| Drizzle ORM                                                                                                        | Apache-2.0                                          | Drizzle Team                        |
| Zod                                                                                                                | MIT                                                 | Colin McDonnell                     |
| @cfworker/json-schema                                                                                              | MIT                                                 | Its authors                         |
| The Bun runtime, inside a compiled `vibe`                                                                          | MIT, with parts under other licenses that Bun lists | Oven and Bun's contributors         |

The fonts are used unmodified. The SIL Open Font License lets them be bundled and redistributed with software, and asks that its text and the copyright notice travel with them: both are in each font package under `node_modules/@fontsource-variable/`, and at <https://openfontlicense.org>.

## Used to build and test

Development dependencies are not shipped. They are listed in each `package.json` and pinned in `bun.lock`, and each carries its license in its package.

To see every dependency's license as installed:

```bash
bun install
find node_modules/.bun -maxdepth 4 -name package.json -path '*node_modules*' \
  -exec sh -c 'printf "%s\t%s\n" "$(jq -r .name "$1")" "$(jq -r ".license // \"?\"" "$1")"' _ {} \; | sort -u
```
