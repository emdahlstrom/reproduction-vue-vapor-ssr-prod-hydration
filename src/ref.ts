import { createVaporApp } from 'vue'
import RefProbe from './RefProbe.vue'

// Fresh mount (no SSR). With #1 patched so render() runs, onMounted reports
// whether the setup-variable template ref resolved: "ref-ok" if `el.value` is the
// <button>, "ref-null" if setRef's setupState write was dead-code-eliminated (#1b).
createVaporApp(RefProbe).mount('#app')
