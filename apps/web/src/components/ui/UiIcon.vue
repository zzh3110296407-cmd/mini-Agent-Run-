<script lang="ts">
const paths = {
  plus: ['M12 5v14m-7-7h14'],
  'panel-right': ['M3 5h18v14H3zM15 5v14'],
  'panel-left': ['M3 5h18v14H3zM9 5v14'],
  'maximize-2': ['M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7'],
  'minimize-2': ['M21 3l-7 7M14 4v6h6M3 21l7-7M4 14h6v6'],
  x: ['m6 6 12 12M18 6 6 18'],
  'grip-vertical': ['M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  'folder-open': ['M3 17V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2M3 17l2-6h17l-2 6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  'file-text': ['M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6'],
  'corner-left-up': ['m9 10 4-4 4 4m-4-4v9a3 3 0 0 0 3 3h4'],
  loader: ['M12 3v3m9 6h-3m-6 9v-3M3 12h3m12.4-6.4-2.1 2.1m2.1 10.7-2.1-2.1M5.6 18.4l2.1-2.1M5.6 5.6l2.1 2.1'],
  'check-circle': ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'm8 12 3 3 5-6'],
  square: ['M5 5h14v14H5z'],
  'x-circle': ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'm9 9 6 6m0-6-6 6'],
  'alert-triangle': ['M12 4 2 20h20L12 4Zm0 6v4m0 3h.01'],
  'rotate-ccw': ['M3 11a9 9 0 1 1 2.8 7.5M3 5v6h6'],
  search: ['M15.5 15.5 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'],
  'chevron-right': ['m9 6 6 6-6 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-up': ['m6 15 6-6 6 6'],
  copy: ['M8 8h12v12H8zM16 4H4v12'],
  pencil: ['m4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4'],
  'trash-2': ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'],
  settings: ['m10 3-.6 2.5-2 .9-2.3-.9-2 3.5 2 1.6v2.8l-2 1.6 2 3.5 2.3-.9 2 .9.6 2.5h4l.6-2.5 2-.9 2.3.9 2-3.5-2-1.6v-2.8l2-1.6-2-3.5-2.3.9-2-.9L14 3z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  sun: ['M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19m0-14-1.4 1.4M6.4 17.6 5 19', 'M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z'],
  moon: ['M20.5 15.5A8.8 8.8 0 0 1 8.5 3.5a9 9 0 1 0 12 12Z'],
  key: ['M14 11a5 5 0 1 0-4.6-3L3 14v5h5v-3h3l2-2A5 5 0 0 0 14 11Zm2-4h.01'],
  check: ['m5 12 4 4L19 6'],
  'alert-circle': ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 8v4m0 4h.01'],
  'refresh-cw': ['M20 7v4h-4M4 17v-4h4m12-2A8 8 0 0 0 6 6m-2 7a8 8 0 0 0 14 5'],
  'arrow-down': ['M12 4v16m-6-6 6 6 6-6'],
  send: ['M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10z'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
  zap: ['m13 2-9 12h7l-1 8 10-12h-8z'],
  terminal: ['M3 5h18v14H3zM7 9l3 3-3 3m6 0h4'],
};

export type IconName = keyof typeof paths;
</script>

<script setup lang="ts">
withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
  >
    <path v-for="path in paths[name]" :key="path" :d="path" />
  </svg>
</template>

<style scoped>
svg { display: block; flex: none; }
</style>
