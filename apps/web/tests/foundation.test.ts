// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResizableDivider from '../src/components/layout/ResizableDivider.vue';
import UiAlertDialog from '../src/components/ui/UiAlertDialog.vue';
import UiDialog from '../src/components/ui/UiDialog.vue';
import { useApiKeySettings } from '../src/composables/useApiKeySettings';
import { useWorkbenchLayout } from '../src/composables/useWorkbenchLayout';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('M3.1 前端工作台底座', () => {
  it('恢复设置、响应视口，并约束右栏宽度', async () => {
    localStorage.setItem('mini-agent-run.theme', 'light');
    localStorage.setItem('mini-agent-run.inspector-width', '1000');
    vi.stubGlobal('innerWidth', 1280);
    const wrapper = mount(defineComponent({
      setup() {
        const layout = useWorkbenchLayout();
        return () => h('button', { onClick: () => { layout.toggleTheme(); layout.setInspectorWidth(200); } },
          [layout.viewport.value, layout.theme.value, layout.inspectorWidth.value].join(' '));
      },
    }));
    try {
      expect(wrapper.text()).toBe('desktop light 720');
      await wrapper.trigger('click');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(localStorage.getItem('mini-agent-run.inspector-width')).toBe('340');
      vi.stubGlobal('innerWidth', 959);
      window.dispatchEvent(new Event('resize'));
      await nextTick();
      expect(wrapper.text()).toBe('mobile dark 340');
    } finally { wrapper.unmount(); }
  });

  it('弹窗循环 Tab、Esc 后还原焦点，删除确认保持遮罩点击保护', async () => {
    const open = ref(false);
    const wrapper = mount(defineComponent({
      setup: () => () => h('div', [
        h('button', { id: 'opener', onClick: () => { open.value = true; } }, '打开'),
        h(UiDialog, { open: open.value, title: '标题', onClose: () => { open.value = false; } }, () =>
          h('button', { 'data-autofocus': '' }, '继续')),
      ]),
    }), { attachTo: document.body });
    try {
      const opener = wrapper.get<HTMLButtonElement>('#opener');
      opener.element.focus();
      await opener.trigger('click');
      await nextTick();
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement?.textContent).toBe('继续');
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭');
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await nextTick();
      expect(document.activeElement).toBe(opener.element);
    } finally { wrapper.unmount(); }

    const alert = mount(UiAlertDialog, {
      props: { open: true, title: '删除' }, global: { stubs: { teleport: true } },
    });
    try {
      const panel = alert.get('[role="alertdialog"]');
      const backdrop = alert.get('.ui-overlay');
      await backdrop.trigger('click');
      expect(alert.emitted('close')).toBeUndefined();
      await panel.trigger('keydown', { key: 'Escape' });
      expect(alert.emitted('close')).toHaveLength(1);
    } finally { alert.unmount(); }
  });

  it('以 24px 调整分隔条，并支持鼠标拖动', async () => {
    const divider = mount(ResizableDivider, { props: { width: 560 } });
    try {
      await divider.trigger('keydown', { key: 'ArrowLeft' });
      expect(divider.emitted('update:width')).toEqual([[584]]);
      await divider.trigger('mousedown', { button: 0, clientX: 850 });
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 825 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(divider.emitted('update:width')?.at(-1)).toEqual([585]);
    } finally { divider.unmount(); }
  });

  it('存储受限时仍可打开工作台，并报告 Key 保存失败', () => {
    const storage = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('storage disabled'); });
    const keys = useApiKeySettings();
    expect(keys.hasCustomApiKey.value).toBe(false);
    expect(keys.saveApiKey('local-override-key-001')).toBe(false);
    expect(keys.getApiKeyForRequest()).toBeUndefined();
    expect(() => keys.clearApiKey()).not.toThrow();
    storage.mockRestore();
  });
});
