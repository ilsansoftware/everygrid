# Contributing

Thanks for helping with Everygrid. Bug reports, fixes and docs improvements are all welcome.

## Reporting a bug

Open an [issue](https://github.com/ilsansoftware/everygrid/issues/new/choose) with the version of
`@everygrid/grid`, your browser, a minimal grid config and the steps to reproduce. Security issues
go through [SECURITY.md](SECURITY.md) instead, not a public issue.

## Development setup

Requirements: Node.js, [pnpm](https://pnpm.io), and Rust with
[wasm-pack](https://rustwasm.github.io/wasm-pack/) for the engine.

```bash
pnpm install
pnpm build      # WASM engine → ES module → standalone UMD
pnpm demo       # demo portal on http://localhost:4000, library rebuilt on save
```

| Command | Use |
|---|---|
| `pnpm build:wasm` | Rebuild the engine after any change under `everygrid-wasm/src/` |
| `pnpm lint` | ESLint over the whole repo |
| `pnpm test` | Vitest |

## Layout

- `everygrid-wasm/`: the Rust engine (filter, sort, paginate), compiled to WebAssembly.
- `packages/everygrid/`: the library, `@everygrid/grid`.
- `demo/portal/`: the demo site.

## Pull requests

- Keep a change focused on one thing, and match the style of the code around it.
- `pnpm lint` and `pnpm test` should pass.
- If you change a public config key or API, update `README.md` in the same pull request.
- Don't edit build outputs (`everygrid-wasm/pkg/`, `dist/`) by hand.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
