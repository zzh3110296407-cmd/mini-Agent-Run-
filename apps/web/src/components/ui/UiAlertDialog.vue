<script setup lang="ts">
import UiDialog from './UiDialog.vue';

defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <UiDialog :open="open" :title="title" role="alertdialog" :dismiss-on-backdrop="false" @close="emit('close')">
    <slot />
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </UiDialog>
</template>
