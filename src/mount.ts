import { createVaporApp } from 'vue'
import Counter from './Counter.vue'

// Plain fresh mount: no SSR markup, no hydration. The same handleSetupResult bug
// that leaves the *hydrated* button inert (src/main.ts) fails harder here. On a
// non-inline production build, instance.block is set to the setup() bindings
// object instead of a DOM block, so insert() reads `.anchor` off it and throws
// "Cannot read properties of undefined (reading 'anchor')" — no button renders.
// mountApp does not adopt existing DOM; it clears #app first, so this is not a
// hydration artifact. The dev runtime and the inline build both mount fine.
createVaporApp(Counter).mount('#app')
