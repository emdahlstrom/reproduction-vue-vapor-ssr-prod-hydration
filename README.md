# Vue Vapor: non-inline SSR component not interactive after hydration (production runtime)

A `<script setup vapor>` component that is server-rendered and then hydrated is
not interactive when both of these hold:

1. the SFC is compiled with a non-inline render function, and
2. the client loads the production Vue runtime.

The server-rendered DOM is reused and hydration reports no mismatch, but the
delegated event handler is never attached to the live node (`button.$evtclick`
is `undefined`), so clicks do nothing. The default `vite build` (inline compile)
works, and the development runtime works either way.

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

By hand (the repo ships the non-inline config, matching an Astro build):

```bash
pnpm dev                      # open the page and interact: works (dev runtime)
pnpm build && pnpm preview    # open the page and interact: dead (prod runtime)
```

## What the page exercises

One component, `src/Counter.vue`: a `<script setup vapor>` button that increments
its own `ref` on click. `index.html` holds its server-rendered output (exactly
what `@vue/server-renderer` `renderToString` emits for it); `src/main.ts`
hydrates that markup through the vDOM interop path vapor SSR relies on,
`createSSRApp(...).use(vaporInteropPlugin).mount('#app')`. Vue reports no
hydration mismatch, so the markup matches what the client renders.

Under the bug the button is inert: clicking does nothing and `button.$evtclick`
is `undefined`. The dev runtime and the inline build both make it interactive.

The same failure hits cross-component reactivity. An earlier variant (a parent
computing a sum over child checkboxes) showed the parent sum, the child's own
state, and a standalone counter all freeze together, while only the checkbox's
native `checked` toggle flipped. That is the confusing real-world symptom: the
thing you clicked seems to change, but the total it feeds does not, because the
whole island is inert and the native checkbox hides it. It is one inert island,
not a propagation-specific bug. That variant is in git history (commit `35cef9c`);
the single counter here is the tightest demonstration.

## The trigger: inline vs non-inline compilation

The broken and working builds differ in one thing: how `@vitejs/plugin-vue`
compiles the template. Inline folds the template into `setup()`; non-inline emits
a separate `render()` function. The plugin inlines only when
`isUseInlineTemplate` is true, which requires
`!devServer && !devToolsEnabled && <script setup> && no template src`.

This repo forces non-inline with `features: { prodDevtools: true }`
(`vite.config.ts`), since `prodDevtools` flips `devToolsEnabled`. It is a
self-contained way to get the non-inline output.

An Astro production build emits the same non-inline output for Vue islands, but
through a different switch: during `astro build`, `@vitejs/plugin-vue` sees
`options.devServer` as truthy, so `isUseInlineTemplate` returns false.
`__VUE_PROD_DEVTOOLS__` is not involved (it resolves to `false` in Astro). The
lever differs, but the compiled output and the runtime failure are the same.

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

On the production runtime, the non-inline component's `render()` is never invoked
during hydration. Instrumenting the served bundle (an `Object.prototype.$evtclick`
setter plus logging inside the compiled render and the runtime's `template()`
helper) shows:

- non-inline + prod: only module-eval runs (`delegateEvents("click")`). The
  separate `render()` is never entered, and no `$evtclick` is assigned to any
  node. The component is inert: no handler and no reactive update. The server
  `<button>` is untouched and has no `$evtclick`.
- inline + prod: `setup()` runs during hydration, the template helper adopts the
  live SSR `<button>`, and `$evtclick` is set on that live node, so it is
  interactive.
- non-inline + dev (control): the same separate `render()` is entered, the
  handler attaches, and it is interactive.

The divergence is `__DEV__`-gated in `@vue/runtime-vapor`'s vDOM-interop
hydration path: with `__DEV__=false` it skips invoking a non-inline vapor
component's render during hydration. We did not pinpoint the exact runtime
branch; the above is observed via instrumentation, not inferred.

An adversarial review tried to break this finding and could not. It is not a
minification or bundler artifact (it reproduces unminified), not a hydration race
or measurement error (10s waits, 10 clicks, and 5 dispatch mechanisms, with
render still never running), and not the `__VUE_PROD_DEVTOOLS__` runtime flag (a
2×2 codegen-by-flag factorial shows interactivity tracks the codegen, not the
flag). It also reproduces in a real Astro build, where compiling inline fixes it.

## Ruled out

Each of these hydrates and stays interactive on its own in a real browser, so
none is the trigger:

- the prebuilt `vue.runtime-with-vapor.esm-browser.prod.js` versus the bundler
  `vue` (both fine with inline)
- static versus dynamic import of the runtime
- a `<slot>` with a vDOM child (`astro-slot`/`innerHTML`), and the exact Astro
  island markup (`<astro-island>`, `<!--astro:end-->`, `idPrefix`)
- two islands on one page, and mounting on a custom element via `mount(el, true)`
- a single shared runtime copy (no dual-instance involved)

Flipping only the compile mode to inline, with the same runtime, markup, and
mount, fixes it.

## Notes

- `happy-dom`/`jsdom` is not a reliable oracle here. It reports the inline build
  as broken too, which a real browser does not. Use a browser, as `pnpm verify`
  does.
