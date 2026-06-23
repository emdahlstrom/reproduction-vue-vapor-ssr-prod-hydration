import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// `features.prodDevtools: true` makes @vitejs/plugin-vue compile the SFC with a
// NON-INLINE render function (a separate `render(){…}` instead of inlining the
// template into `setup()`). That non-inline output is what triggers the bug.
//
// It is the same non-inline output an Astro production build emits for Vue
// islands. Astro reaches it via a different switch (its build runs the plugin
// with `options.devServer` truthy), not via prodDevtools. See README.
//
// Set this to `false` (or remove it) for the default inline compile, and the
// production build hydrates correctly. `pnpm verify` builds and checks both.
export default defineConfig({
  plugins: [vue({ features: { prodDevtools: true } })],
})
