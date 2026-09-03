/**
 * Workspace tab bar.
 *
 * Renders the whole strip on every change rather than diffing it. There are
 * never more than a few dozen tabs and each is three elements, so a rebuild is
 * far cheaper than a render frame - and it removes the entire class of bug
 * where the DOM and the workspace list disagree about what exists.
 *
 * The one piece of state kept here is which tab is being renamed, because that
 * lives in the DOM (an input with a caret and a selection) rather than in the
 * session.
 */

import { el } from './controls.js';
import type { Workspace } from './workspaces.js';

export interface TabBarCallbacks {
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
  onRename(id: string, title: string): void;
  onDuplicate(id: string): void;
  onImport(): void;
  onExport(): void;
}

export interface TabBar {
  root: HTMLElement;
  render(workspaces: Workspace[], activeId: string): void;
  /** Put the active tab straight into rename mode. */
  beginRename(id: string): void;
}

export function createTabBar(cb: TabBarCallbacks): TabBar {
  const strip = el('div', { class: 'tabs', role: 'tablist' });
  const actions = el('div', { class: 'tabbar-actions' }, [
    mkButton('Import…', 'Import a workspace from a JSON file', cb.onImport),
    mkButton('Export', 'Export this workspace to a JSON file', cb.onExport),
  ]);
  const root = el('header', { class: 'tabbar' }, [
    el('span', { class: 'brand' }, ['Watercolour Shapes']),
    strip,
    actions,
  ]);

  let renamingId: string | null = null;
  let current: Workspace[] = [];
  let currentActive = '';

  function render(workspaces: Workspace[], activeId: string): void {
    current = workspaces;
    currentActive = activeId;
    strip.replaceChildren();
    for (const ws of workspaces) {
      strip.append(tabFor(ws, ws.id === activeId, workspaces.length > 1));
    }
    const add = mkButton('+', 'New workspace', cb.onAdd);
    add.classList.add('tab-add');
    strip.append(add);
  }

  function tabFor(ws: Workspace, active: boolean, closable: boolean): HTMLElement {
    const tab = el('div', {
      class: `tab${active ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': String(active),
    });

    if (renamingId === ws.id) {
      const input = el('input', {
        type: 'text',
        class: 'tab-rename',
        value: ws.title,
        maxlength: '60',
      }) as HTMLInputElement;
      const commit = (save: boolean) => {
        if (renamingId !== ws.id) return;
        renamingId = null;
        const next = input.value.trim();
        if (save && next && next !== ws.title) cb.onRename(ws.id, next);
        else render(current, currentActive);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commit(false);
        }
      });
      input.addEventListener('blur', () => commit(true));
      tab.append(input);
      // Focus after the element is in the document, or the selection is lost.
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
      return tab;
    }

    const label = el('button', {
      class: 'tab-label',
      title: `${ws.sourceName} — double-click to rename`,
    }, [ws.title]);
    label.addEventListener('click', () => {
      if (!active) cb.onSelect(ws.id);
    });
    label.addEventListener('dblclick', (e) => {
      e.preventDefault();
      beginRename(ws.id);
    });
    tab.append(label);

    if (closable) {
      const close = el('button', { class: 'tab-close', title: 'Close workspace' }, ['×']);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onClose(ws.id);
      });
      tab.append(close);
    }
    return tab;
  }

  function beginRename(id: string): void {
    renamingId = id;
    render(current, currentActive);
  }

  // Middle-click closes, matching every other tab strip.
  strip.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = (e.target as HTMLElement).closest('.tab');
    if (!tab) return;
    const index = [...strip.children].indexOf(tab);
    const ws = current[index];
    if (ws && current.length > 1) {
      e.preventDefault();
      cb.onClose(ws.id);
    }
  });

  strip.addEventListener('contextmenu', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab');
    if (!tab) return;
    const index = [...strip.children].indexOf(tab);
    const ws = current[index];
    if (!ws) return;
    e.preventDefault();
    cb.onDuplicate(ws.id);
  });

  return { root, render, beginRename };
}

function mkButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { title }, [label]) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}
