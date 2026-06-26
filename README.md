# Vue Vapor: non-inline `<script setup vapor>` is dead under the production runtime

## TL;DR

Under the Vue 3.6 production Vapor runtime (including beta.17), a **non-inline**
`<script setup vapor>` component hydrates dead and crashes on a fresh mount
(**#1**, `handleSetupResult`), and its string template refs never reach the setup
variable (**#1b**, `setRef`). Both are wiring behind a `__DEV__` gate that
production dead-code-elimination strips. `pnpm install && pnpm verify` reproduces
it in a real browser; `node confirm.mjs` shows the bundled patch fixes both. This
is the pure-Vite / `createVaporSSRApp` repro — the canonical minimal one.

## What's broken

A `<script setup vapor>` component compiled **non-inline** is not interactive on
the production runtime:

- **Hydrated** (`createVaporSSRApp`): the server-rendered `<button>` is adopted
  with no mismatch but stays inert — `button.$evtclick` is `undefined`, clicks do
  nothing.
- **Fresh mount** (`createVaporApp`, no SSR): it throws `TypeError: Cannot read
  properties of undefined (reading 'anchor')` and renders no button.
- **Template ref** (`const el = ref(); ref="el"`): once #1 is fixed so the
  component renders, `el.value` is still `null` in `onMounted` (#1b).

The inline compile (default `vite build`) and the development runtime are both fine.

- `vue@3.6.0-beta.17` (`@vue/runtime-vapor@3.6.0-beta.17`)
- `vite@8.1.0`, `@vitejs/plugin-vue@6.0.7`, node 24

## Reproduce

```bash
pnpm install
pnpm verify        # builds Counter four ways, drives each in headless Chromium
node confirm.mjs   # patches the runtime-vapor bundler build; proves the fix for both bugs
```

`pnpm verify` drives #1, the directly observable bug:

```text
✓ non-inline + prod, hydration  [the bug]: "count is 0" -> "count is 0"  $evtclick=undefined  reactive=false
✓ inline + prod, hydration: "count is 0" -> "count is 1"  $evtclick=function  reactive=true
✓ non-inline + dev, hydration (control): "count is 0" -> "count is 1"  $evtclick=function  reactive=true
✓ non-inline + prod, fresh mount [crashes, no SSR]: "null" -> "null"  $evtclick=null  reactive=false  error=TypeError: Cannot read properties of undefined (reading 'anchor')
```

`node confirm.mjs` patches the `@vue/runtime-vapor` bundler build at each level
(#1b is masked until #1 runs `render()`):

```text
#1 handleSetupResult — non-inline prod is dead; the fix revives it:
  ✓ hydration   (createVaporSSRApp)  unpatched dead=true  →  patched interactive=true
  ✓ fresh mount (createVaporApp)     unpatched dead=true  error=TypeError: Cannot read properties of undefined (reading 'anchor')  →  patched interactive=true

#1b setRef — a setup-variable template ref, at three patch levels:
  ✓ no fix    onMounted=—  error=TypeError: Cannot read properties of undefined (reading 'anchor')
  ✓ #1 only   onMounted=ref-null
  ✓ #1 + #1b  onMounted=ref-ok
```

By hand: `pnpm dev` (dev runtime, works) versus `pnpm build && pnpm preview`
(prod runtime, dead).

## Why non-inline matters

`@vitejs/plugin-vue` folds the template into `setup()` only when
`isUseInlineTemplate` holds (`!devServer && !devToolsEnabled && <script setup> &&
no template src`); otherwise it emits a **separate `render()`**. This repo forces
non-inline with `features: { prodDevtools: true }` (`vite.config.ts`). Production
builds reach non-inline for other reasons too: an Astro build runs the plugin with
`options.devServer` truthy, so every island is non-inline. Same output; the
failure is in the runtime, not the compiler.

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

## Root cause #1: `handleSetupResult` (`packages/runtime-vapor/src/component.ts`)

A non-inline `setup()` returns the bindings object (`{ count }`), not a DOM block,
and the template compiles to a separate `render()`. `handleSetupResult` wires
bindings to render only inside `if (__DEV__ && !isBlock(setupResult)) { … }`. With
`__DEV__ = false` that whole branch, discriminator included, is
dead-code-eliminated, leaving:

```js
// production
if (setupResult === EMPTY_OBJ && component.render)
  instance.block = callRender(component.render, instance, setupResult)
else
  instance.block = setupResult   // the bindings object, not a block
```

`setupResult` is the non-empty `{ count }`, so the first branch is dead and the
bindings object becomes `instance.block`; `render()` never runs. Inline builds
escape because their `setup()` returns `EMPTY_OBJ` and takes the first branch. The
`isBlock(setupResult)` discriminator — the only thing separating "setup returned a
DOM block" from "setup returned bindings plus a separate render" — lives inside
the `__DEV__` gate, so production cannot tell them apart. `mountComponent` then
forks on `if (!isHydrating)`: hydration leaves the SSR `<button>` inert; a fresh
mount inserts the bad block, and `insert()` reads `.anchor` off the bindings
object and throws.

**Fix.** Restore the discriminator outside the `__DEV__` gate (`callRender` clears
the crash and wires the handler; `proxyRefs` is needed for text reactivity):

```js
else if (!isBlock(setupResult) && component.render) {
  instance.setupState = proxyRefs(setupResult)
  instance.block = callRender(component.render, instance, instance.setupState)
}
```

## Root cause #1b: `setRef` (`packages/runtime-vapor/src/apiTemplateRef.ts`)

The same `__DEV__`-DCE pattern hits `setRef`. In production it computes
`setupState = __DEV__ ? instance.setupState || {} : null` and guards every
`setupState[ref] = node` write with `__DEV__ && canSetSetupRef(ref)`. So a string
template ref writes only to `instance.refs`, never to `setupState` — and the
`setupState[ref]` write (through `proxyRefs`) is what sets the setup variable's
`.value`. Result: `el.value` is `null` in `onMounted`. #1 masks it: until #1 runs
`render()`, `setRef` never fires.

| patch level | render runs | `el.value` in `onMounted` |
|---|---|---|
| no fix | no (fresh-mount crash) | — |
| #1 only | yes | `null` |
| #1 + #1b | yes | the `<button>` |

**Fix.** Make `setupState` and `canSetSetupRef` live in production and ungate the
writes (`__DEV__ && canSetSetupRef(ref)` → `canSetSetupRef(ref)`).

## Apply the fix

`patches/@vue__runtime-vapor@3.6.0-beta.17.patch` carries both fixes against the
bundler build (`runtime-vapor.esm-bundler.js`). To use it downstream, apply it in
your app (not here — it would un-break the reproduction); with pnpm:

```json
"pnpm": {
  "patchedDependencies": {
    "@vue/runtime-vapor@3.6.0-beta.17": "patches/@vue__runtime-vapor@3.6.0-beta.17.patch"
  }
}
```

Pinned to `3.6.0-beta.17`; regenerate for other versions.

## Notes

- Verified in a real browser. `happy-dom`/`jsdom` are not reliable oracles here:
  they report the inline build as broken too, which a real browser does not.
- Independent of `__VUE_PROD_DEVTOOLS__` — interactivity tracks the codegen, not
  the flag. Not specific to the vDOM-interop bridge (`createSSRApp` +
  `vaporInteropPlugin`): pure `createVaporSSRApp` fails identically. Flipping only
  the compile mode to inline, with the same runtime and markup, fixes it.
