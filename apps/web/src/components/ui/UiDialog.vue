<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import UiButton from './UiButton.vue';
import UiIcon from './UiIcon.vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  role?: 'dialog' | 'alertdialog';
  dismissOnBackdrop?: boolean;
  side?: 'left' | 'right';
}>(), { role: 'dialog', dismissOnBackdrop: true });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const titleId = useId();
let opener: HTMLElement | null = null;

function restoreFocus() {
  if (opener?.isConnected) opener.focus();
  opener = null;
}

function focusable() {
  return Array.from(panel.value?.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, [tabindex]',
  ) ?? []).filter((element) => element.tabIndex >= 0
    && !element.matches(':disabled, input[type="hidden"]') && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

watch(() => props.open, async (open) => {
  if (!open) {
    restoreFocus();
    return;
  }
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (!props.open) return;
  const items = focusable();
  (items.find((item) => item.hasAttribute('data-autofocus')) ?? items[0] ?? panel.value)?.focus();
}, { immediate: true, flush: 'post' });

onBeforeUnmount(restoreFocus);

function handleKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
  if (event.key !== 'Tab') return;
  const controls = focusable();
  const first = controls[0];
  const last = controls.at(-1);
  const active = document.activeElement;
  if (!first || !last) {
    event.preventDefault();
    panel.value?.focus();
  } else if (active === (event.shiftKey ? first : last) || !controls.some((control) => control === active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ui-overlay" :class="side" @click.self="dismissOnBackdrop && emit('close')">
      <section
        ref="panel" class="ui-dialog" tabindex="-1" :role="role" :aria-labelledby="titleId" aria-modal="true"
        v-bind="$attrs" @keydown="handleKey"
      >
        <header class="ui-dialog-header">
          <slot name="title" :title-id="titleId"><h2 :id="titleId">{{ title }}</h2></slot>
          <UiButton variant="ghost" size="sm" aria-label="关闭" @click="emit('close')"><UiIcon name="x" /></UiButton>
        </header>
        <div class="ui-dialog-content"><slot /></div>
        <footer v-if="$slots.footer" class="ui-dialog-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-overlay {
  position: fixed;
  z-index: var(--z-modal);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--bg-backdrop);
}
.ui-dialog {
  display: flex;
  flex-direction: column;
  width: min(100%, var(--dialog-width, 480px));
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 70px var(--bg-backdrop);
  outline: none;
}
.ui-dialog-header, .ui-dialog-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
}
.ui-dialog-header { justify-content: space-between; border-bottom: 1px solid var(--border-subtle); }
.ui-dialog-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.ui-dialog-content { min-height: 0; overflow: auto; padding: 14px 16px; }
.ui-dialog-footer { justify-content: flex-end; border-top: 1px solid var(--border-subtle); }
.ui-overlay.left, .ui-overlay.right {
  z-index: var(--z-drawer);
  place-items: stretch start;
  padding: 0;
}
.ui-overlay.right { justify-items: end; }
.left .ui-dialog, .right .ui-dialog {
  width: min(88vw, var(--sheet-width, 480px));
  min-height: 100%;
  border-radius: 0;
  background: var(--bg-panel);
  animation: slide-in var(--duration-normal) var(--ease-snappy);
}
.left .ui-dialog { --sheet-offset: -100%; --sheet-width: var(--sidebar-width); }
.right .ui-dialog { --sheet-offset: 100%; }
.left .ui-dialog-content, .right .ui-dialog-content { flex: 1; padding: 0; }
@keyframes slide-in { from { transform: translateX(var(--sheet-offset)); } }
</style>
