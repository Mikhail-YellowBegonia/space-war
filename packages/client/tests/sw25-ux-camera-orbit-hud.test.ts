import { SOLAR_SYSTEM_BODIES } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D, CameraController } from '../src/camera/index.js';
import { OrbitInteractionManager } from '../src/interaction/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import { morphDomHtml } from '../src/ui/index.js';

interface FakeAttr {
  name: string;
  value: string;
}

class FakeNode {
  nodeType: number;
  nodeValue: string | null = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    if (ref === null) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(ref);
      if (idx >= 0) {
        this.childNodes.splice(idx, 0, node);
      } else {
        this.childNodes.push(node);
      }
    }
    return node;
  }

  removeChild(node: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super(3);
    this.nodeValue = text;
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  id = '';
  value = '';
  checked = false;
  selected = false;
  type = '';
  private attrMap = new Map<string, string>();
  private htmlVal = '';

  constructor(tagName: string) {
    super(1);
    this.tagName = tagName.toUpperCase();
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get attributes(): FakeAttr[] {
    return [...this.attrMap.entries()].map(([name, value]) => ({ name, value }));
  }

  hasAttribute(name: string): boolean {
    return this.attrMap.has(name);
  }

  getAttribute(name: string): string | null {
    return this.attrMap.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrMap.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'value') this.value = value;
    if (name === 'type') this.type = value;
  }

  removeAttribute(name: string): void {
    this.attrMap.delete(name);
    if (name === 'id') this.id = '';
  }

  get content(): FakeElement {
    return this;
  }

  set innerHTML(html: string) {
    this.htmlVal = html;
    this.childNodes = [];
    parseSimpleHtmlInto(html, this);
  }

  get innerHTML(): string {
    return this.htmlVal;
  }
}

function parseSimpleHtmlInto(html: string, root: FakeNode): void {
  const stack: FakeNode[] = [root];
  const tokenRe = /<\/([a-zA-Z0-9-]+)>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (match[2]) {
      const el = new FakeElement(match[2]);
      const attrStr = match[3] ?? '';
      const attrRe = /([a-zA-Z0-9-:]+)(?:="([^"]*)")?/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrStr)) !== null) {
        el.setAttribute(am[1]!, am[2] ?? '');
      }
      stack[stack.length - 1]!.insertBefore(el, null);
      if (!match[4] && el.tagName !== 'INPUT') {
        stack.push(el);
      }
      continue;
    }
    if (match[5]) {
      stack[stack.length - 1]!.insertBefore(new FakeText(match[5]), null);
    }
  }
}

describe('SW-25 UX polish: DOM morphing, camera tracking, timeScale, and orbit insertion UX', () => {
  it('morphDomHtml preserves button identity and focused input values across 10Hz ticks', () => {
    const fakeRoot = new FakeElement('div');
    let active: FakeElement | null = null;
    const fakeDoc = {
      get activeElement() {
        return active;
      },
      createElement: (tag: string) => new FakeElement(tag),
    } as unknown as Document;

    const renderTick = (secText: string, activeMode: string) => `
      <div class="cic-topbar">
        <div class="cic-clock">${secText}</div>
        <input id="cic-room-id" class="cic-input" value="alpha-1" />
        <button class="cic-btn ${activeMode === 'select' ? 'active' : ''}" data-action="set-mode" data-mode="select">[1] 选择</button>
        <button class="cic-btn ${activeMode === 'orbit_insertion' ? 'active' : ''}" data-action="set-mode" data-mode="orbit_insertion">[2] 进入轨道</button>
      </div>
    `;

    const elems = (n: FakeNode): FakeElement[] =>
      n.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);

    morphDomHtml(fakeRoot as unknown as HTMLElement, renderTick('T+00:01', 'select'), fakeDoc);
    const topbar = elems(fakeRoot)[0]!;
    const [clockBefore, inputEl, btnSelect, btnOrbit] = elems(topbar) as [
      FakeElement,
      FakeElement,
      FakeElement,
      FakeElement,
    ];
    expect((clockBefore.childNodes[0] as FakeText).nodeValue).toBe('T+00:01');
    expect(btnSelect.getAttribute('data-mode')).toBe('select');
    expect(btnOrbit.getAttribute('class')).not.toContain('active');

    // Simulate user typing into focused input and hovering/clicking btnOrbit
    active = inputEl;
    inputEl.value = 'my-room-9';

    morphDomHtml(fakeRoot as unknown as HTMLElement, renderTick('T+00:02', 'orbit_insertion'), fakeDoc);
    const topbarAfter = elems(fakeRoot)[0]!;
    const [clockAfter, , btnSelectAfter, btnOrbitAfter] = elems(topbarAfter) as [
      FakeElement,
      FakeElement,
      FakeElement,
      FakeElement,
    ];

    // Exact same DOM element instances preserved; only clock text & active class updated
    expect(btnSelectAfter).toBe(btnSelect);
    expect(btnOrbitAfter).toBe(btnOrbit);
    expect((clockAfter.childNodes[0] as FakeText).nodeValue).toBe('T+00:02');
    expect(btnOrbitAfter.getAttribute('class')).toContain('active');
    expect(inputEl.value).toBe('my-room-9');
  });

  it('tracks targets in Camera2D, centers wheel zoom while tracking, and releases lock on pan or reset', () => {
    const camera = new Camera2D({
      center: { x: 0, y: 0 },
      viewSpanAu: 2.0,
      viewportWidth: 1000,
      viewportHeight: 800,
    });
    const listeners = new Map<string, (e: unknown) => void>();
    const fakeCanvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      addEventListener: (ev: string, fn: (e: unknown) => void) => listeners.set(ev, fn),
      removeEventListener: (ev: string) => listeners.delete(ev),
    } as unknown as HTMLElement;

    const controller = new CameraController({ element: fakeCanvas, camera });
    camera.setFollowTarget({ kind: 'body', id: 'earth', label: 'Earth' });
    camera.setCenter({ x: 1.0, y: 0 });
    expect(camera.getFollowTarget()?.id).toBe('earth');

    // Wheel zoom off-center keeps center anchored on (1.0, 0) while tracking
    listeners.get('wheel')!({
      deltaY: -100,
      clientX: 120,
      clientY: 90,
      preventDefault() {},
    });
    expect(camera.getViewSpanAu()).toBeLessThan(2.0);
    expect(camera.getCenter().x).toBeCloseTo(1.0, 6);
    expect(camera.getCenter().y).toBeCloseTo(0, 6);

    // Manual right-button drag pan releases follow target
    listeners.get('pointerdown')!({ button: 2, pointerId: 1, clientX: 500, clientY: 400 });
    listeners.get('pointermove')!({ pointerId: 1, clientX: 540, clientY: 420 });
    listeners.get('pointerup')!({ pointerId: 1 });
    expect(camera.getFollowTarget()).toBeNull();

    // resetOverview also clears follow target
    camera.setFollowTarget({ kind: 'unit', id: 'E-RCN-1', label: 'E-RCN-1' });
    camera.resetOverview();
    expect(camera.getFollowTarget()).toBeNull();
    controller.dispose();
  });

  it('supports one-click circular orbit setting and apsis slider setters in orbit_insertion mode', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false, timeScale: 0.5 });
    expect(provider.getTimeScale()).toBe(0.5);
    provider.setTimeScale(0.25);
    expect(provider.getTimeScale()).toBe(0.25);

    const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);
    const camera = new Camera2D({ viewSpanAu: 5.0, viewportWidth: 1000, viewportHeight: 800 });

    interaction.selectUnit('E-RCN-1');
    interaction.setMode('orbit_insertion');

    // Single click on empty space (~1.52 AU) sets circular orbit
    const clickScreen = camera.worldToScreen({ x: 0, y: 1.52 });
    expect(interaction.beginPointerAction(clickScreen, camera)).toBe(true);
    interaction.endPointerAction();

    const afterClick = interaction.getState();
    expect(afterClick.draftOrbit).not.toBeNull();
    expect(afterClick.apsisHandles!.rp).toBeCloseTo(1.52, 2);
    expect(afterClick.apsisHandles!.ra).toBeCloseTo(1.52, 2);
    expect(afterClick.options).toHaveLength(3);

    // Preset circular orbit & custom apsides setters
    interaction.setCircularDraftOrbit(1.32, Math.PI * 0.5);
    expect(interaction.getState().draftOrbit!.a).toBeCloseTo(1.32, 6);
    expect(interaction.getState().draftOrbit!.e).toBeCloseTo(0, 6);

    interaction.setDraftOrbitApsides(0.9, 1.7, Math.PI * 0.25);
    const customState = interaction.getState();
    expect(customState.apsisHandles!.rp).toBeCloseTo(0.9, 6);
    expect(customState.apsisHandles!.ra).toBeCloseTo(1.7, 6);
    expect(customState.options).toHaveLength(3);

    interaction.dispose();
    provider.dispose();
  });
});
