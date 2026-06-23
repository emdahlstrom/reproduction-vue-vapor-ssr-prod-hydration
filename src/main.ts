import { createVaporSSRApp } from 'vue'
import Counter from './Counter.vue'

// Pure vapor SSR hydration: no vDOM host, no vaporInteropPlugin. On a non-inline
// production build, the component's render is not effective after hydration, so
// the button never gets its click handler and stays inert. The same failure also
// happens through the vDOM-interop bridge (createSSRApp + vaporInteropPlugin), so
// it is not specific to interop.
createVaporSSRApp(Counter).mount('#app')
