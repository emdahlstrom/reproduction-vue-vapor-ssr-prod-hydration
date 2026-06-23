import { createSSRApp, h, vaporInteropPlugin } from 'vue'
import Counter from './Counter.vue'

// Hydrate the server-rendered markup through the vDOM interop path that vapor
// SSR uses. On a non-inline production build, Counter's render is never invoked
// here, so the button never gets its click handler and stays inert.
const app = createSSRApp({ render: () => h(Counter) })
app.use(vaporInteropPlugin)
app.mount('#app')
