# Vue Vapor: non-inline SSR component not interactive after hydration (production runtime)

A `<script setup vapor>` component that is server-rendered and then hydrated is
not interactive when both of these hold:

1. the SFC is compiled with a non-inline render function, and
2. the client loads the production Vue runtime.

The server-rendered DOM is reused and hydration reports no mismatch, but the
render never takes effect: the delegated click handler is not attached to the
live node (`button.$evtclick` is `undefined`), so clicks do nothing. The default
`vite build` (inline compile) works, and the development runtime works either way.

This is not framework-specific. It reproduces with a plain
`createVaporSSRApp(...).mount(...)` (what this repo uses) and also through the
vDOM interop bridge (`createSSRApp(...).use(vaporInteropPlugin)`). Any vapor SSR
setup is affected, pure-vapor (Nuxt-style) and vapor-island (Astro-style) alike.

- `vue@3.6.0-beta.16` (`@vue/runtime-vapor@3.6.0-beta.16`)
- `vite@8.1.0`, `@vitejs/plugin-vue@6.0.7`, node 24

## Reproduce

```bash
pnpm install
pnpm verify     # builds 3 variants, hydrates each in headless Chromium, asserts
```

Expected output:

```
✓ non-inline + prod runtime  [the bug]: "count is 0" -> "count is 0"  $evtclick=undefined  reactive=false
✓ inline + prod runtime: "count is 0" -> "count is 1"  $evtclick=function  reactive=true
✓ non-inline + dev runtime (control): "count is 0" -> "count is 1"  $evtclick=function  reactive=true
```

By hand:

```bash
pnpm dev                      # open the page and interact: works (dev runtime)
pnpm build && pnpm preview    # open the page and interact: dead (prod runtime)
```

## What the page exercises

One component, `src/Counter.vue`: a `<script setup vapor>` button that increments
its own `ref` on click. `index.html` holds its server-rendered output (exactly
what `@vue/server-renderer` `renderToString` emits for it). `src/main.ts`
hydrates it with `createVaporSSRApp(Counter).mount('#app')`, pure vapor with no
vDOM host. Vue reports no hydration mismatch, so the markup matches what the
client renders.

Under the bug the button is inert: clicking does nothing and `button.$evtclick`
is `undefined`. The dev runtime and the inline build both make it interactive.

The same failure occurs through the vDOM interop bridge, where a vapor component
is mounted inside a vDOM app via `createSSRApp` + `vaporInteropPlugin` (how Astro
islands and incremental vDOM-plus-vapor apps mount). So the trigger is the vapor
component, not the surrounding app. A related variant with a parent that computes
a sum over child checkboxes showed the parent sum, the child's own state, and a
standalone counter all freeze together while only a checkbox's native `checked`
toggle flipped: one inert component tree, not a propagation-specific bug. It is
in git history (commit `35cef9c`).

## The trigger: inline vs non-inline compilation

The broken and working builds differ in one thing: how `@vitejs/plugin-vue`
compiles the template. Inline folds the template into `setup()`; non-inline emits
a separate `render()` function. The plugin inlines only when
`isUseInlineTemplate` is true, which requires
`!devServer && !devToolsEnabled && <script setup> && no template src`.

This repo forces non-inline with `features: { prodDevtools: true }`
(`vite.config.ts`), since `prodDevtools` flips `devToolsEnabled`.

Real production builds reach non-inline for other reasons too. An Astro build,
for instance, runs the plugin with `options.devServer` truthy, so it emits
non-inline output for every Vue component. Either way the compiled output is
non-inline, and the failure is in the runtime, not the compiler.

Compiled output (minified), production build.

Non-inline (broken). The template is cloned and the handler attached in a
separate render function:

```js
delegateEvents("click");
function render(e, ...) {
  let a = template(), o = child(a);
  return a.$evtclick = createInvoker(() => e.count++),   // handler on `a`
         renderEffect(() => setText(o, "count is " + e.count)),
         a;
}
```

Inline (works). The template is cloned and the handler attached inside `setup()`:

```js
setup(e) {
  let t = ref(0), n = template(), r = child(n);
  return n.$evtclick = createInvoker(() => t.value++),    // handler on `n`
         renderEffect(() => setText(r, "count is " + t.value)),
         n;
}
```

## Mechanism

On the production runtime the non-inline component's render never takes effect
during hydration. Instrumenting the interop variant (an
`Object.prototype.$evtclick` setter plus logging inside the compiled render and
the runtime's `template()` helper) showed the separate `render()` is never
entered and no `$evtclick` is assigned to any node. The pure-vapor variant shows
the same end state: the SSR node is adopted (no mismatch) but stays inert, with
`$evtclick` undefined.

- non-inline + prod: the render is not effective, so no handler and no reactive
  update. The server `<button>` is untouched and has no `$evtclick`.
- inline + prod: `setup()` runs during hydration, the template helper adopts the
  live SSR `<button>`, and `$evtclick` is set on that live node, so it is
  interactive.
- non-inline + dev (control): the same non-inline output hydrates and is
  interactive.

The divergence is `__DEV__`-gated in `@vue/runtime-vapor`'s hydration path: with
`__DEV__=false` a non-inline vapor component's render is not applied during
hydration. We did not pinpoint the exact runtime branch; the above is observed
via instrumentation, not inferred.

An adversarial review tried to break this finding and could not. It is not a
minification or bundler artifact (it reproduces unminified), not a hydration race
or measurement error (10s waits, 10 clicks, and 5 dispatch mechanisms, with the
render still not taking effect), and not the `__VUE_PROD_DEVTOOLS__` runtime flag
(a 2×2 codegen-by-flag factorial shows interactivity tracks the codegen, not the
flag).

## Ruled out

Each of these hydrates and stays interactive on its own in a real browser, so
none is the trigger:

- the vDOM interop bridge: the bug reproduces with and without it (pure
  `createVaporSSRApp` fails the same way)
- the prebuilt `vue.runtime-with-vapor.esm-browser.prod.js` versus the bundler
  `vue` (both fine with inline)
- static versus dynamic import of the runtime
- a single shared runtime copy (no dual-instance involved)

Flipping only the compile mode to inline, with the same runtime, markup, and
mount, fixes it.

## Notes

- `happy-dom`/`jsdom` is not a reliable oracle here. It reports the inline build
  as broken too, which a real browser does not. Use a browser, as `pnpm verify`
  does.
