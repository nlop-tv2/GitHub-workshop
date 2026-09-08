# McSquishy: Blob on the Run

This directory contains the browser-based TypeScript game foundation. The
application is intentionally limited to a canvas entry point and separated
placeholder modules until game features are implemented.

Run the commands below from this directory:

```sh
npm install
npm run dev
npm run build
npm test
npm run typecheck
```

`npm run dev` starts the local Vite development server. `npm run build`
creates a static production build in `dist/`. Tests run in Vitest's Node
environment and do not require browser or network access.
