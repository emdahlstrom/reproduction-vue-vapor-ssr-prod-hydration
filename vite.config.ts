import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// features.prodDevtools: true makes @vitejs/plugin-vue emit a NON-INLINE render
// function (a separate render(){…} instead of inlining the template into setup()) —
// the output that triggers the bug. An Astro prod build emits the same non-inline
// output via a different switch (options.devServer truthy). Set it to false for the
// default inline compile and the prod build hydrates fine. Only `pnpm dev`/`build`/
// `preview` read this; verify.mjs and confirm.mjs compile each variant themselves.
export default defineConfig({
  plugins: [vue({ features: { prodDevtools: true } })],
})
