# Vue Vapor: non-inline component dead under the production runtime

A `<script setup vapor>` component compiled **non-inline** is not interactive on
the **production** Vue runtime, in two forms of the same bug:

- **Hydrated** (`createVaporSSRApp`): the server-rendered `<button>` is adopted
  with no mismatch but stays inert: `button.$evtclick` is `undefined`, clicks do
  nothing.
- **Fresh mount** (`createVaporApp`, empty container, no SSR): it throws
  `TypeError: Cannot read properties of undefined (reading 'anchor')` and renders
  no button.

The inline compile (default `vite build`) and the development runtime are both
interactive. The cause is one `__DEV__`-gated branch in `@vue/runtime-vapor`'s
`handleSetupResult` ([Root cause](#root-cause)); the fix is in `patches/`.

- `vue@3.6.0-beta.16` (`@vue/runtime-vapor@3.6.0-beta.16`)
- `vite@8.1.0`, `@vitejs/plugin-vue@6.0.7`, node 24

## Reproduce

```bash
pnpm install
pnpm verify          # builds 4 variants, drives each in headless Chromium, asserts
node confirm-fix.mjs # applies the fix to the runtime, shows both surfaces recover
```

`pnpm verify` builds one component (`src/Counter.vue`) four ways and drives each
in a real browser:

```text
✓ non-inline + prod, hydration  [the bug]: "count is 0" -> "count is 0"  $evtclick=undefined  reactive=false
✓ inline + prod, hydration: "count is 0" -> "count is 1"  $evtclick=function  reactive=true
✓ non-inline + dev, hydration (control): "count is 0" -> "count is 1"  $evtclick=function  reactive=true
✓ non-inline + prod, fresh mount [crashes, no SSR]: "null" -> "null"  $evtclick=null  reactive=false  error=TypeError: Cannot read properties of undefined (reading 'anchor')
```

`node confirm-fix.mjs` patches the runtime and re-checks both surfaces:

```text
✓ hydration  (createVaporSSRApp, pre-rendered button)
    unpatched: interactive=false $evtclick=undefined
    patched:   interactive=true $evtclick=function
✓ fresh mount (createVaporApp, empty #app)
    unpatched: interactive=false $evtclick=null error=TypeError: Cannot read properties of undefined (reading 'anchor')
    patched:   interactive=true $evtclick=function
```

By hand: `pnpm dev` (dev runtime, works) versus `pnpm build && pnpm preview`
(prod runtime, dead).

## The trigger: inline vs non-inline compilation

`@vitejs/plugin-vue` folds the template into `setup()` only when
`isUseInlineTemplate` holds (`!devServer && !devToolsEnabled && <script setup> &&
no template src`); otherwise it emits a **separate `render()`**. This repo forces
non-inline with `features: { prodDevtools: true }` (`vite.config.ts`). Production
builds reach non-inline for other reasons too: an Astro build runs the plugin
with `options.devServer` truthy, so every component is non-inline. Same output;
the failure is in the runtime, not the compiler.

```js
// non-inline (broken): the click handler is attached inside a separate render()
function render(_ctx) {
  const a = template(), o = child(a)
  a.$evtclick = createInvoker(() => _ctx.count++)
  renderEffect(() => setText(o, "count is " + _ctx.count))
  return a
}
// inline (works): the click handler is attached inside setup()
setup() {
  const count = ref(0), n = template(), r = child(n)
  n.$evtclick = createInvoker(() => count.value++)
  renderEffect(() => setText(r, "count is " + count.value))
  return n
}
```

## Root cause

A non-inline `setup()` returns the bindings object (`{ count }`), not a DOM
block, and the template compiles to a separate `render()`. `handleSetupResult`
wires bindings to render only through `devRender()`, inside
`if (__DEV__ && !isBlock(setupResult)) { … }`. With `__DEV__ = false` that whole
branch (discriminator and all) is dead-code-eliminated, leaving:

```js
// @vue/runtime-vapor handleSetupResult, production
if (setupResult === EMPTY_OBJ && component.render)
  instance.block = callRender(component.render, instance, setupResult)
else
  instance.block = setupResult   // ← the bindings object, not a block
```

`setupResult` is the non-empty `{ count }`, so the first branch is dead and the
bindings object is assigned as `instance.block`; `render()` never runs. Inline
builds escape because their `setup()` returns `EMPTY_OBJ` and hits the first
branch. The deepest cause is that the `isBlock(setupResult)` discriminator, the
only thing that separates "setup returned a DOM block" from "setup returned
bindings + a separate render", lives inside the `__DEV__` gate, so production
cannot tell them apart.

`mountComponent` then forks on `if (!isHydrating)`: hydration skips the insert and
leaves the SSR `<button>` inert; a fresh mount inserts the bad block, `insert()`
reads `.anchor` off the bindings object, and throws.

**Fix.** Restore the discriminator outside the `__DEV__` gate:

```js
else if (!isBlock(setupResult) && component.render) {
  instance.setupState = proxyRefs(setupResult)
  instance.block = callRender(component.render, instance, instance.setupState)
}
```

`node confirm-fix.mjs` applies exactly this to the `@vue/runtime-vapor` source
(backing up and restoring `node_modules`), rebuilds, and shows both surfaces
become interactive, confirming the cause, not just describing the symptom. The
branch plus `callRender` removes the crash and wires the handler; `proxyRefs` is
independently needed for text reactivity.

## Apply the fix

`patches/@vue__runtime-vapor@3.6.0-beta.16.patch` is the same diff as a drop-in
patch for the bundler build (`runtime-vapor.esm-bundler.js`) that Vite, Astro and
Nuxt consume. Apply it in your own app, not here, where it would un-break the
reproduction. With pnpm, copy it into your app's `patches/`, then add:

```json
"pnpm": {
  "patchedDependencies": {
    "@vue/runtime-vapor@3.6.0-beta.16": "patches/@vue__runtime-vapor@3.6.0-beta.16.patch"
  }
}
```

then `pnpm install` (npm/yarn: `patch-package`). The patch is pinned to
`3.6.0-beta.16`; regenerate it for other versions.

## Notes

- Verified in a real browser. `happy-dom`/`jsdom` are not reliable oracles here:
  they report the inline build as broken too, which a real browser does not.
- It is not a measurement artifact. It reproduces unminified, survives long waits
  and repeated clicks, and is independent of `__VUE_PROD_DEVTOOLS__` (interactivity
  tracks the codegen, not the flag). It is not specific to the vDOM interop bridge
  (`createSSRApp` + `vaporInteropPlugin`); pure `createVaporSSRApp` fails
  identically. Flipping only the compile mode to inline, with the same runtime and
  markup, fixes it.
