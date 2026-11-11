import type { BrowserRuntime } from './browser';
import type {
  BrowserInput,
  ElementAnimation,
  ElementEdit,
  ElementInsertion,
  ElementQuery,
} from '../shared/types';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效');
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('文本格式无效');
  return value;
}
export async function dispatchBrowserAction(
  browser: BrowserRuntime,
  action: string,
  payload?: unknown,
): Promise<unknown> {
  switch (action) {
    case 'browser:start':
      await browser.start();
      return browser.getState();
    case 'browser:tabs':
      return browser.listTabs();
    case 'browser:new-tab': {
      const data = payload === undefined ? {} : record(payload);
      return browser.newTab(data.url === undefined ? undefined : string(data.url, 4000));
    }
    case 'browser:switch-tab':
      return browser.switchTab(string(record(payload).id, 200));
    case 'browser:close-tab':
      return browser.closeTab(string(record(payload).id, 200));
    case 'browser:query': {
      const data = record(payload);
      const query: ElementQuery = {
        selector: data.selector === undefined ? undefined : string(data.selector, 2000),
        text: data.text === undefined ? undefined : string(data.text, 2000),
        role: data.role === undefined ? undefined : string(data.role, 200),
        exact: data.exact === true,
        limit: 30,
      };
      return browser.queryElements(query);
    }
    case 'browser:element':
      return browser.selectElement(string(record(payload).ref, 1500));
    case 'browser:element-details':
      return browser.getElementDetails(string(record(payload).ref, 1500));
    case 'browser:edit': {
      const data = record(payload);
      const changes: ElementEdit = {};
      if (data.text !== undefined) changes.text = string(data.text, 20_000);
      if (data.styles !== undefined) {
        const styles = record(data.styles);
        if (Object.keys(styles).length > 30) throw new Error('一次修改的样式过多');
        changes.styles = Object.fromEntries(
          Object.entries(styles).map(([key, value]) => [string(key, 80), string(value, 500)]),
        );
      }
      if (data.animation !== undefined) {
        changes.animation =
          data.animation === null ? null : (record(data.animation) as unknown as ElementAnimation);
      }
      if (data.insert !== undefined)
        changes.insert = record(data.insert) as unknown as ElementInsertion;
      return browser.editElement(string(data.ref, 1500), changes);
    }
    case 'browser:preview-styles': {
      const data = record(payload);
      const styles = Object.fromEntries(
        Object.entries(record(data.styles)).map(([key, value]) => [
          string(key, 80),
          string(value, 500),
        ]),
      );
      return browser.previewStyles(
        string(data.ref, 1500),
        styles,
        data.editId === undefined ? undefined : string(data.editId, 1500),
      );
    }
    case 'browser:commit-styles': {
      const data = record(payload);
      return browser.commitStyles(string(data.ref, 1500), string(data.editId, 1500));
    }
    case 'browser:undo': {
      const data = payload === undefined ? {} : record(payload);
      return browser.undoEdit(data.editId === undefined ? undefined : string(data.editId, 1500));
    }
    case 'browser:navigate':
      await browser.navigate(string(record(payload).url, 4000));
      return browser.getState();
    case 'browser:back':
      await browser.back();
      return true;
    case 'browser:forward':
      await browser.forward();
      return true;
    case 'browser:reload':
      await browser.reload();
      return true;
    case 'browser:snapshot':
      return browser.snapshot();
    case 'browser:diagnostics':
      return browser.callTool('workbench_browser_diagnostics', {});
    case 'browser:input':
      await browser.dispatchInput(record(payload) as unknown as BrowserInput);
      return true;
    case 'browser:resize': {
      const data = record(payload);
      if (!Number.isFinite(data.width) || !Number.isFinite(data.height))
        throw new Error('页面尺寸不正确');
      if (data.fitToWidth !== undefined && typeof data.fitToWidth !== 'boolean')
        throw new Error('页面缩放模式不正确');
      if (
        data.pixelRatio !== undefined &&
        (typeof data.pixelRatio !== 'number' ||
          !Number.isFinite(data.pixelRatio) ||
          data.pixelRatio <= 0)
      )
        throw new Error('屏幕像素倍率不正确');
      return browser.resize(Number(data.width), Number(data.height), {
        fitToWidth: data.fitToWidth === true,
        tabId: data.tabId === undefined ? undefined : string(data.tabId, 200),
        pixelRatio: data.pixelRatio as number | undefined,
      });
    }
    case 'browser:inspect': {
      const enabled = record(payload).enabled;
      if (typeof enabled !== 'boolean') throw new Error('选择状态不正确');
      await browser.setInspect(enabled);
      return true;
    }
    default:
      throw new Error('不支持的页面操作');
  }
}
