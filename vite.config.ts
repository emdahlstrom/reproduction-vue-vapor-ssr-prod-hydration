import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// `features.prodDevtools: true` makes @vitejs/plugin-vue compile the SFC with a
// NON-INLINE render function (a separate `render(_ctx){…}` instead of inlining
// the template into `setup()`). This is what an Astro production build produces
// for Vue islands, and it is the trigger for the bug — see README.
//
// Flip it to `false` (or remove it) to get the default INLINE compile, and the
// production build hydrates correctly. `pnpm verify` builds and checks BOTH.
export default defineConfig({
  plugins: [vue({ features: { prodDevtools: true } })],
})
