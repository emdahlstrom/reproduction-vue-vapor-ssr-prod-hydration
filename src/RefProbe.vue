<script setup vapor lang="ts">
import { ref, onMounted } from 'vue'

// A setup-variable template ref: `el` should hold the <button> after mount.
// In non-inline prod, setRef's `setupState[ref] = node` write is __DEV__-gated
// and DCE'd, so `el.value` stays null (bug #1b) even once #1 lets render() run.
const el = ref<HTMLButtonElement | null>(null)
const refState = ref('pending')
onMounted(() => {
  refState.value = el.value ? 'ref-ok' : 'ref-null'
})
</script>

<template>
  <button type="button" ref="el">{{ refState }}</button>
</template>
