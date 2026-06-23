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
✓ NON-INLINE + PROD runtime  [the bug]
    standalone counter:        count is 0 -> count is 0          (reactive=false)
    interacted child OWN state: self 0 -> self 0                 (reactive=false)
    parent SUM (cross-comp):    0 of 3 checked -> 0 of 3 checked (reactive=false)
    checkbox native checked=true  <- flips even when dead
✓ INLINE + PROD runtime
    ... all reactive=true ...
✓ NON-INLINE + DEV runtime (control)
    ... all reactive=true ...
```

Or see it by hand (the repo is configured non-inline, mirroring an Astro build):

```bash
pnpm dev                      # open the page, interact → works (dev runtime)
pnpm build && pnpm preview    # open the page, interact → DEAD (prod runtime)
```

## What the page exercises

Three reactive paths, so the failure can't be mistaken for a local quirk
(`src/app.ts` renders both components):

1. **`src/Counter.vue`** — a standalone vapor component's own state
   (`@click="count++"`).
2. **`src/TodoList.vue` + `src/TodoItem.vue`** — a parent that derives a **sum**
   (`computed` "N of 3 checked") from child checkboxes; each child also has its
   **own** reactive counter and emits `toggle` upward. This is the realistic
   cross-component case.

Under the bug, **all three are dead** — counter, the interacted child's own
state, and the parent sum. The controls flip all three.

> **The deceptive part.** A checkbox `@change="emit('toggle')"` still toggles
> its `checked` box **natively in the browser** even when the handler is dead.
> So it *looks* like "the component I clicked changed," while the sum it feeds
> never updates and no reactivity ran at all. That mismatch — interacted thing
> appears to change, the aggregate doesn't — is the original real-world symptom;
> it's not a separate cross-component bug, it's the whole island being inert with
> the native checkbox masking it.

SSR via `@vue/server-renderer` `renderToString`; client hydration via the vDOM
interop path vapor SSR uses — `createSSRApp(Root).use(vaporInteropPlugin)`
`.mount('#app')` (see `src/entry-*.ts`).

## The trigger: inline vs non-inline compilation

The only difference between the broken and working builds is how
`@vitejs/plugin-vue` compiles the template: **inline** (the template is compiled
into `setup()`) vs **non-inline** (a separate `render()` function). The plugin
compiles inline only when `isUseInlineTemplate` is true, i.e. when
`!devServer && !devToolsEnabled && <script setup> && no template src`.

This repro forces **non-inline** with `features: { prodDevtools: true }`
(`vite.config.ts`) — the cleanest self-contained lever, since `prodDevtools`
flips `devToolsEnabled`.

An **Astro** production build emits the **same non-inline output** for Vue
islands, but via a *different* switch: during `astro build`, `@vitejs/plugin-vue`
sees `options.devServer` as truthy, so `isUseInlineTemplate` is false. (It is
**not** `__VUE_PROD_DEVTOOLS__` — that resolves to `false` in Astro.) Either way
the compiled output is non-inline, and the production Vue runtime fails to
hydrate it. The lever differs; the broken artifact and the runtime defect are
identical.

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

## Mechanism

Under the **production** runtime, the non-inline vapor component's `render()`
function is **never invoked during hydration**. Instrumenting the served bundle
(an `Object.prototype.$evtclick` setter + logging inside the compiled render and
the runtime's `template()` helper) shows:

- **non-inline + prod**: only module-eval runs (`delegateEvents("click")`); the
  separate `render()` is **never entered**, and **zero** `$evtclick` assignments
  happen on any node. The component is fully inert — no handler, no reactive
  update. The server `<button>` is untouched and has no `$evtclick`.
- **inline + prod**: `setup()` runs during hydration, the template helper adopts
  the live SSR `<button>`, and `$evtclick` is set on that live node → interactive.
- **non-inline + dev** (control): the same separate `render()` **is** entered →
  handler attached → interactive.

So the divergence is purely `__DEV__`-gated in `@vue/runtime-vapor`'s
vDOM-interop hydration path: with `__DEV__=false` it skips invoking a non-inline
vapor component's render during hydration. (We did not pinpoint the exact runtime
branch; everything above is observed via instrumentation, not inferred.)

> This was validated by an adversarial panel that tried to break it: it is **not**
> a minification/bundler artifact (reproduces unminified), **not** a hydration
> race or measurement error (10s waits, 10 clicks, 5 dispatch mechanisms — render
> never runs), and **not** the `__VUE_PROD_DEVTOOLS__` runtime flag (a 2×2
> codegen×flag factorial shows interactivity tracks the codegen, not the flag).
> It also reproduces in the real Astro build, where compiling inline fixes it.

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
