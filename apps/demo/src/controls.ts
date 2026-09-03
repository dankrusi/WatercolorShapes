/**
 * Small DOM helpers for the control panel.
 *
 * The parameter sliders are generated from the library's own `PARAM_SPECS`
 * rather than written out here, so a new parameter shows up in the UI with
 * correct bounds the moment it exists in the renderer - and cannot drift out
 * of sync with it.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export interface SliderHandle {
  root: HTMLElement;
  set(value: number): void;
}

export function slider(o: SliderOptions): SliderHandle {
  const out = el('output', {}, [format(o.value, o.step, o.format)]);
  const input = el('input', {
    type: 'range',
    min: String(o.min),
    max: String(o.max),
    step: String(o.step),
    value: String(o.value),
  }) as HTMLInputElement;
  const head = el('div', { class: 'slider-head' }, [
    el('span', o.hint ? { title: o.hint } : {}, [o.label]),
    out,
  ]);
  const root = el('div', { class: 'slider' }, [head, input]);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v, o.step, o.format);
    o.onInput(v);
  });
  return {
    root,
    set(value: number) {
      input.value = String(value);
      out.textContent = format(value, o.step, o.format);
    },
  };
}

function format(v: number, step: number, custom?: (v: number) => string): string {
  if (custom) return custom(v);
  if (step >= 1) return String(Math.round(v));
  const decimals = Math.min(5, Math.max(0, Math.ceil(-Math.log10(step))));
  return v.toFixed(decimals);
}

export function group(title: string, children: (Node | string)[]): HTMLElement {
  return el('section', { class: 'group' }, [el('h2', {}, [title]), ...children]);
}

export function subgroup(title: string, children: (Node | string)[], open = false): HTMLElement {
  const d = el('details', { class: 'subgroup' });
  if (open) d.setAttribute('open', '');
  d.append(el('summary', {}, [title]), el('div', {}, children));
  return d;
}

export function button(
  label: string,
  onClick: () => void,
  cls = '',
): HTMLButtonElement {
  const b = el('button', cls ? { class: cls } : {}, [label]) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

export interface ToggleHandle {
  root: HTMLButtonElement;
  set(pressed: boolean): void;
  get(): boolean;
}

/**
 * A pressed/unpressed button.
 *
 * Returns a handle rather than the element because switching workspaces has to
 * push state back into every control, and a toggle that can only be read is
 * exactly the control that silently ends up disagreeing with the state it is
 * supposed to be showing.
 */
export function toggle(
  label: string,
  pressed: boolean,
  onChange: (pressed: boolean) => void,
  hint?: string,
): ToggleHandle {
  const attrs: Record<string, string> = { class: 'toggle', 'aria-pressed': String(pressed) };
  if (hint) attrs.title = hint;
  const b = el('button', attrs, [label]) as HTMLButtonElement;
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(next));
    onChange(next);
  });
  return {
    root: b,
    set(value: boolean) {
      b.setAttribute('aria-pressed', String(value));
    },
    get() {
      return b.getAttribute('aria-pressed') === 'true';
    },
  };
}
