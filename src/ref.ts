import { createVaporApp } from 'vue'
import RefProbe from './RefProbe.vue'

// Fresh mount. onMounted reports whether the setup-variable template ref resolved
// (ref-ok / ref-null) — bug #1b.
createVaporApp(RefProbe).mount('#app')
