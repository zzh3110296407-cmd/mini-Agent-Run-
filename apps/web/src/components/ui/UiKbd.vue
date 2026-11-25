<template>
  <kbd class="ui-kbd"><slot /></kbd>
</template>

<style scoped>
.ui-kbd {
  min-width: 17px;
  padding: 0 3px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-secondary);
  box-shadow: inset 0 -1px var(--border-subtle);
  font: 500 11.5px/16px var(--font-mono);
  text-align: center;
}
</style>
