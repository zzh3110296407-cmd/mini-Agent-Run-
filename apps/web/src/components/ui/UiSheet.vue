<script setup lang="ts">
import UiDialog from './UiDialog.vue';

defineProps<{ open: boolean; title: string; side: 'left' | 'right' }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <UiDialog :open="open" :title="title" :side="side" @close="emit('close')"><slot /></UiDialog>
</template>
