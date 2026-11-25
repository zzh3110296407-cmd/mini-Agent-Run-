<script setup lang="ts">
import { ref } from 'vue';
import AppTopbar from './components/layout/AppTopbar.vue';
import ResizableDivider from './components/layout/ResizableDivider.vue';
import SettingsModal from './components/sidebar/SettingsModal.vue';
import UiButton from './components/ui/UiButton.vue';
import UiEmpty from './components/ui/UiEmpty.vue';
import UiIcon from './components/ui/UiIcon.vue';
import UiSheet from './components/ui/UiSheet.vue';
import { useHealthProbe } from './composables/useHealthProbe';
import { useWorkbenchLayout } from './composables/useWorkbenchLayout';

const settingsOpen = ref(false);
const { health, checkHealth } = useHealthProbe();
const { viewport, theme, inspectorOpen, sidebarDrawerOpen, inspectorWidth, toggleTheme, setInspectorWidth } = useWorkbenchLayout();
</script>

<template>
  <div class="workbench" :data-layout="viewport">
    <AppTopbar
      :theme="theme" :health="health" :show-sidebar-toggle="viewport === 'mobile'" :sidebar-open="sidebarDrawerOpen"
      :inspector-open="inspectorOpen" @retry-health="checkHealth" @toggle-theme="toggleTheme"
      @toggle-sidebar="sidebarDrawerOpen = !sidebarDrawerOpen" @toggle-inspector="inspectorOpen = !inspectorOpen"
    />
    <div class="workbench-body">
      <aside v-if="viewport !== 'mobile'" id="sidebar-pane" class="workbench-sidebar" aria-label="排查会话">
        <h2>排查会话</h2>
        <UiButton variant="ghost" data-testid="open-settings-btn" @click="settingsOpen = true"><UiIcon name="settings" />设置</UiButton>
      </aside>
      <main class="workspace">
        <div class="workspace-inner">
          <h1>排查工作区</h1>
          <UiEmpty title="选择排查会话"><template #icon><UiIcon name="folder-open" :size="23" /></template></UiEmpty>
        </div>
      </main>
      <template v-if="viewport === 'desktop' && inspectorOpen">
        <ResizableDivider :width="inspectorWidth" @update:width="setInspectorWidth" />
        <aside id="inspector-panel" class="inspector" :style="{ width: inspectorWidth + 'px' }" aria-label="日志检视器">
          <h2>日志检视器</h2>
        </aside>
      </template>
    </div>
    <UiSheet
      v-if="viewport === 'mobile'" id="sidebar-pane" :open="sidebarDrawerOpen" side="left" title="排查会话"
      @close="sidebarDrawerOpen = false"
    >
      <UiButton variant="ghost" data-testid="open-settings-btn" @click="settingsOpen = true"><UiIcon name="settings" />设置</UiButton>
    </UiSheet>
    <UiSheet
      v-if="viewport !== 'desktop'" id="inspector-panel" :open="inspectorOpen" side="right" title="日志检视器"
      @close="inspectorOpen = false"
    />
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.workbench { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.workbench-body { display: flex; flex: 1; min-height: 0; }
.workbench-sidebar, .inspector { flex: none; min-height: 0; background: var(--bg-panel); }
.workbench-sidebar { width: var(--sidebar-width); border-inline-end: 1px solid var(--border-subtle); }
.workspace { min-width: 0; flex: 1; overflow: auto; }
.workspace-inner { width: min(100%, 760px); margin: auto; padding: 27px clamp(16px, 4vw, 32px); }
.workspace h1 { margin: 0 0 15px; font-size: 23px; line-height: 1.28; letter-spacing: -.025em; overflow-wrap: anywhere; }
.workbench-sidebar h2, .inspector h2 { margin: 0; padding: 13px 14px; font-size: 14px; }
.inspector { max-width: calc(100% - var(--sidebar-width) - 285px); overflow: auto; }
</style>
