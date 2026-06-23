# Vue Vapor: non-inline SSR component is dead after hydration in the production runtime

**Minimal reproduction.** A `<script setup vapor>` component that is server-rendered
and hydrated is **not interactive** when:

1. the SFC is compiled with a **non-inline** render function, **and**
2. the client uses the **production** Vue runtime.

The server-rendered DOM is reused, hydration reports no mismatch, but the
delegated event handler is never attached to the live node (`button.$evtclick`
is `undefined`), so clicks do nothing. The **inline** compile (the default
`vite build`) works, and the **development** runtime works for both.

- `vue@3.6.0-beta.16` (`@vue/runtime-vapor@3.6.0-beta.16`)
- `vite@8.1.0`, `@vitejs/plugin-vue@6.0.7`, node 24

## Reproduce

```bash
pnpm install
pnpm verify     # builds 3 variants, hydrates each in headless Chromium, asserts
```

Expected output:

```
✓ NON-INLINE compile (Astro-style) + PROD runtime  [the bug]
    "count is 0" -> "count is 0"  | $evtclick=undefined | interactive=false
✓ INLINE compile (default vite build) + PROD runtime
    "count is 0" -> "count is 1"  | $evtclick=function | interactive=true
✓ NON-INLINE compile + DEV runtime (control)
    "count is 0" -> "count is 1"  | $evtclick=function | interactive=true
```

Or see it by hand (the repo is configured non-inline, mirroring an Astro build):

```bash
pnpm dev                      # open the page, click → works (dev runtime)
pnpm build && pnpm preview    # open the page, click → DEAD (prod runtime)
```

## What the component is

`src/Counter.vue` — the smallest vapor component with state + a handler:

```vue
<script setup vapor lang="ts">
import { ref } from 'vue'
const count = ref(0)
</script>
<template>
  <button type="button" @click="count++">count is {{ count }}</button>
</template>
```

SSR via `@vue/server-renderer` `renderToString`; client hydration via the vDOM
interop path that vapor SSR uses — `createSSRApp({ render: () => h(Counter) })`
`.use(vaporInteropPlugin).mount('#app')` (see `src/entry-*.ts`).

## The trigger: inline vs non-inline compilation

The only difference between the broken and working builds is how
`@vitejs/plugin-vue` compiles the template. With Vue prod-devtools enabled
(`features: { prodDevtools: true }`, or `__VUE_PROD_DEVTOOLS__`), the SFC is
compiled **non-inline** — a separate `render()` function instead of inlining the
template into `setup()`. This is what an **Astro** production build emits for Vue
islands, which is how this was first hit.

Compiled output (minified), production build:

**Non-inline (broken)** — template is cloned and the handler attached in a
*separate render function*:

```js
delegateEvents("click");
function render(e, ...) {
  let a = template(), o = child(a);
  return a.$evtclick = createInvoker(() => e.count++),   // handler on `a`
         renderEffect(() => setText(o, "count is " + e.count)),
         a;
}
```

**Inline (works)** — template cloned and handler attached *inside `setup()`*:

```js
setup(e) {
  let t = ref(0), n = template(), r = child(n);
  return n.$evtclick = createInvoker(() => t.value++),    // handler on `n`
         renderEffect(() => setText(r, "count is " + t.value)),
         n;
}
```

## Observed mechanism

In the non-inline production build, during hydration the template helper returns
a **freshly-created node**, not the server-rendered one. `$evtclick` is set on
that detached node, while the server-rendered `<button>` (still in the document)
gets no handler — so the click does nothing. Concretely, after hydration:

- `document.querySelector('#app button')` is the original SSR node (unchanged), and
- that node has **no `$evtclick`** property (the inline build gives it one).

The development runtime hydrates the same non-inline output correctly, so the
divergence is between the dev and prod **runtime** builds on the **non-inline**
code path. (We did not trace the exact `__DEV__`-gated branch in the runtime —
the prod build is minified — so the internal cause is left to the maintainer;
everything above is observed, not inferred.)

## Ruled out (to save investigation time)

Each of these reproduces **correctly** (interactive) on its own, in a real
browser — so none is the trigger:

- the prebuilt `vue.runtime-with-vapor.esm-browser.prod.js` vs the bundler `vue`
  (both fine with inline);
- static vs dynamic import of the runtime;
- a `<slot>` with a vDOM child (`astro-slot`/`innerHTML`), and the exact Astro
  island markup (`<astro-island>`, `<!--astro:end-->`, `idPrefix`);
- two islands on one page; mounting on a custom element via `mount(el, true)`;
- a single shared runtime copy (no dual-instance involved).

Flipping **only** the compile mode to inline (same runtime, same markup, same
mount) fixes it — which is why the finger points at the non-inline path.

## Notes

- A `happy-dom`/`jsdom` unit test is **not** a reliable oracle here — it reports
  the inline build as broken too, which a real browser does not. Use a browser
  (this repo's `pnpm verify` does).
