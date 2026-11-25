import { computed, onMounted, onUnmounted, ref } from 'vue';
import { readLocalStorage, writeLocalStorage } from '../utils/localStorage';

export type WorkbenchTheme = 'dark' | 'light';

const themeKey = 'mini-agent-run.theme';
const widthKey = 'mini-agent-run.inspector-width';
export const minInspectorWidth = 340;
export const maxInspectorWidth = 720;

export function clampInspectorWidth(width: number) {
  return Math.max(minInspectorWidth, Math.min(maxInspectorWidth, width));
}

export function readWorkbenchTheme(): WorkbenchTheme {
  return readLocalStorage(themeKey) === 'light' ? 'light' : 'dark';
}

export function applyWorkbenchTheme(theme: WorkbenchTheme) {
  document.documentElement.dataset.theme = theme;
}

export function useWorkbenchLayout() {
  const width = ref(window.innerWidth);
  const viewport = computed(() => width.value >= 1280 ? 'desktop' : width.value >= 960 ? 'tablet' : 'mobile');
  const theme = ref(readWorkbenchTheme());
  const inspectorOpen = ref(false);
  const sidebarDrawerOpen = ref(false);
  const savedWidth = Number(readLocalStorage(widthKey) ?? 560);
  const inspectorWidth = ref(Number.isFinite(savedWidth) ? clampInspectorWidth(savedWidth) : 560);

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
    inspectorWidth.value = clampInspectorWidth(value);
    writeLocalStorage(widthKey, String(inspectorWidth.value));
  }

  return { viewport, theme, inspectorOpen, sidebarDrawerOpen, inspectorWidth, toggleTheme, setInspectorWidth };
}
