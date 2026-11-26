import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { readLocalStorage, writeLocalStorage } from '../utils/localStorage';

export type WorkbenchTheme = 'dark' | 'light';
export type ViewportMode = 'desktop' | 'tablet' | 'mobile';

const themeKey = 'mini-agent-run.theme';
const widthKey = 'mini-agent-run.inspector-width';
export const minInspectorWidth = 340;

export function viewportModeFor(width: number): ViewportMode {
  return width >= 1280 ? 'desktop' : width >= 960 ? 'tablet' : 'mobile';
}

export function maxInspectorWidthFor(viewportWidth: number, mode: ViewportMode): number {
  if (mode === 'mobile') return viewportWidth;
  const reservedWidth = mode === 'desktop' ? 264 + 240 : 48;
  return Math.max(minInspectorWidth, viewportWidth - reservedWidth);
}

export function clampInspectorWidth(width: number, maxWidth: number) {
  return Math.max(Math.min(minInspectorWidth, maxWidth), Math.min(maxWidth, width));
}

export function readWorkbenchTheme(): WorkbenchTheme {
  return readLocalStorage(themeKey) === 'light' ? 'light' : 'dark';
}

export function applyWorkbenchTheme(theme: WorkbenchTheme) {
  document.documentElement.dataset.theme = theme;
}

export function useWorkbenchLayout() {
  const width = ref(window.innerWidth);
  const viewport = computed(() => viewportModeFor(width.value));
  const theme = ref(readWorkbenchTheme());
  const inspectorOpen = ref(false);
  const inspectorFullscreen = ref(false);
  const sidebarDrawerOpen = ref(false);
  const savedWidth = Number(readLocalStorage(widthKey) ?? 560);
  const preferredWidth = ref(Number.isFinite(savedWidth) ? savedWidth : 560);
  const maxInspectorWidth = computed(() => maxInspectorWidthFor(width.value, viewport.value));
  const inspectorWidth = computed(() => clampInspectorWidth(preferredWidth.value, maxInspectorWidth.value));

  watch(inspectorOpen, (open) => { if (!open) exitInspectorFullscreen(); }, { flush: 'sync' });

  function measure() {
    width.value = window.innerWidth;
    if (viewport.value !== 'mobile') sidebarDrawerOpen.value = false;
  }

  onMounted(() => {
    measure();
    applyWorkbenchTheme(theme.value);
    window.addEventListener('resize', measure);
  });
  onUnmounted(() => window.removeEventListener('resize', measure));

  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    applyWorkbenchTheme(theme.value);
    writeLocalStorage(themeKey, theme.value);
  }

  function setInspectorWidth(value: number) {
    if (!Number.isFinite(value)) return;
    preferredWidth.value = clampInspectorWidth(value, maxInspectorWidth.value);
    writeLocalStorage(widthKey, String(preferredWidth.value));
  }

  function toggleInspectorFullscreen() {
    if (inspectorOpen.value) inspectorFullscreen.value = !inspectorFullscreen.value;
  }

  function exitInspectorFullscreen() {
    inspectorFullscreen.value = false;
  }

  return {
    viewport, theme, inspectorOpen, sidebarDrawerOpen, inspectorWidth, maxInspectorWidth, inspectorFullscreen,
    toggleTheme, setInspectorWidth, toggleInspectorFullscreen, exitInspectorFullscreen,
  };
}
