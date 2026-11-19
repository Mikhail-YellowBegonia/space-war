const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function getElementKey(el: Element): string | null {
  if (el.id) {
    return `#${el.id}`;
  }
  const attrs = el.attributes;
  if (!attrs || attrs.length === 0) {
    return null;
  }
  const dataParts: string[] = [];
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]!;
    if (attr.name.startsWith('data-')) {
      dataParts.push(`${attr.name}=${attr.value}`);
    }
  }
  if (dataParts.length === 0) {
    return null;
  }
  dataParts.sort();
  return `${el.tagName}:${dataParts.join('&')}`;
}

function syncElementAttributes(existing: Element, desired: Element, activeEl: Element | null): void {
  const isFocusedFormField =
    activeEl === existing && (existing.tagName === 'INPUT' || existing.tagName === 'SELECT');

  const existingAttrs = existing.attributes;
  const toRemove: string[] = [];
  for (let i = 0; i < existingAttrs.length; i++) {
    const name = existingAttrs[i]!.name;
    if (!desired.hasAttribute(name)) {
      toRemove.push(name);
    }
  }
  for (const name of toRemove) {
    existing.removeAttribute(name);
  }

  const desiredAttrs = desired.attributes;
  for (let i = 0; i < desiredAttrs.length; i++) {
    const attr = desiredAttrs[i]!;
    if (isFocusedFormField && (attr.name === 'value' || attr.name === 'checked')) {
      continue;
    }
    if (existing.getAttribute(attr.name) !== attr.value) {
      existing.setAttribute(attr.name, attr.value);
    }
  }

  if (!isFocusedFormField && (existing.tagName === 'INPUT' || existing.tagName === 'SELECT')) {
    const desiredVal = desired.getAttribute('value');
    const inputEl = existing as HTMLInputElement;
    if (desiredVal !== null && existing.tagName === 'INPUT' && inputEl.value !== desiredVal) {
      inputEl.value = desiredVal;
    }
    if (existing.tagName === 'INPUT' && inputEl.type === 'checkbox') {
      const shouldBeChecked = desired.hasAttribute('checked');
      if (inputEl.checked !== shouldBeChecked) {
        inputEl.checked = shouldBeChecked;
      }
    }
  } else if (existing.tagName === 'OPTION' && activeEl !== existing.parentElement) {
    const optEl = existing as HTMLOptionElement;
    const shouldBeSelected = desired.hasAttribute('selected');
    if (optEl.selected !== shouldBeSelected) {
      optEl.selected = shouldBeSelected;
    }
  }
}

function reconcileChildNodes(targetParent: Node, desiredParent: Node, activeEl: Element | null): void {
  const existingChildren = [...targetParent.childNodes];
  const desiredChildren = [...desiredParent.childNodes];

  const keyedPool = new Map<string, Element[]>();
  const used = new Set<Node>();

  for (const child of existingChildren) {
    if (child.nodeType === ELEMENT_NODE) {
      const key = getElementKey(child as Element);
      if (key) {
        const list = keyedPool.get(key);
        if (list) {
          list.push(child as Element);
        } else {
          keyedPool.set(key, [child as Element]);
        }
      }
    }
  }

  let cursor = 0;

  for (let i = 0; i < desiredChildren.length; i++) {
    const desired = desiredChildren[i]!;
    let matched: Node | null = null;

    if (desired.nodeType === ELEMENT_NODE) {
      const key = getElementKey(desired as Element);
      if (key) {
        const queue = keyedPool.get(key);
        while (queue && queue.length > 0) {
          const candidate = queue.shift()!;
          if (!used.has(candidate)) {
            matched = candidate;
            break;
          }
        }
      }
    }

    if (!matched) {
      while (cursor < existingChildren.length) {
        const candidate = existingChildren[cursor]!;
        cursor += 1;
        if (used.has(candidate)) {
          continue;
        }
        if (desired.nodeType === ELEMENT_NODE && candidate.nodeType === ELEMENT_NODE) {
          const candKey = getElementKey(candidate as Element);
          const desKey = getElementKey(desired as Element);
          if (
            (candidate as Element).tagName === (desired as Element).tagName &&
            (!candKey || candKey === desKey)
          ) {
            matched = candidate;
            break;
          }
        } else if (desired.nodeType === TEXT_NODE && candidate.nodeType === TEXT_NODE) {
          matched = candidate;
          break;
        }
      }
    }

    const refNode = targetParent.childNodes[i] ?? null;

    if (matched) {
      used.add(matched);
      if (matched !== refNode) {
        targetParent.insertBefore(matched, refNode);
      }
      if (desired.nodeType === TEXT_NODE) {
        if (matched.nodeValue !== desired.nodeValue) {
          matched.nodeValue = desired.nodeValue;
        }
      } else if (desired.nodeType === ELEMENT_NODE) {
        syncElementAttributes(matched as Element, desired as Element, activeEl);
        reconcileChildNodes(matched, desired, activeEl);
      }
    } else {
      targetParent.insertBefore(desired, refNode);
    }
  }

  for (const child of existingChildren) {
    if (!used.has(child) && child.parentNode === targetParent) {
      targetParent.removeChild(child);
    }
  }
}

/**
 * Reconciles `root` children against `nextHtml` in place so unchanged elements
 * (especially `<button data-action="...">` controls) preserve DOM identity,
 * hover states, and ongoing clicks across 10Hz telemetry updates.
 */
export function morphDomHtml(
  root: HTMLElement,
  nextHtml: string,
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): void {
  if (!doc || typeof doc.createElement !== 'function') {
    root.innerHTML = nextHtml;
    return;
  }

  const tpl = doc.createElement('template');
  tpl.innerHTML = nextHtml;
  const activeEl = (doc.activeElement as Element | null) ?? null;
  reconcileChildNodes(root, tpl.content, activeEl);
}
