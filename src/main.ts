import { createVaporSSRApp } from 'vue'
import Counter from './Counter.vue'

// Pure vapor SSR hydration (no vDOM interop). On a non-inline prod build the
// hydrated button stays inert — bug #1.
createVaporSSRApp(Counter).mount('#app')
