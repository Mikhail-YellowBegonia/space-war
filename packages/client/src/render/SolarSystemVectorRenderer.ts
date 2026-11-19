import {
  getBodyStateAt,
  type CelestialBody,
  type FactionId,
  type KeplerOrbit,
  type UnitEntity,
  type UnitKind,
  type Vec2,
} from '@space-war/shared';
import type { SemanticZoomTier } from '../camera/index.js';
import type { Canvas2DContextLike, IRenderer, RenderFrameState } from './IRenderer.js';
import {
  clipSegmentToRect,
  computeScaleBarSpec,
  computeUmbraSectorPolygon,
  sampleOrbitPoints,
} from './orbitGeometry.js';

const CIC_COLORS = {
  background: '#050a0e',
  gridRing: 'rgba(92, 225, 230, 0.10)',
  gridAxis: 'rgba(92, 225, 230, 0.08)',
  orbitDefault: 'rgba(110, 175, 200, 0.22)',
  orbitHighlighted: 'rgba(125, 249, 255, 0.48)',
  umbraFill: 'rgba(14, 28, 46, 0.62)',
  umbraBorder: 'rgba(110, 155, 195, 0.28)',
  sunCore: '#ffe28a',
  sunGlow: 'rgba(255, 196, 80, 0.22)',
  earth: '#5ce1e6',
  mars: '#ff8a4c',
  neutralBody: '#9fb6c8',
  erosHighlight: '#ffd166',
  labelMuted: 'rgba(180, 215, 230, 0.72)',
  labelBright: '#d7f9ff',
  selectedRing: '#ffffff',
  velVector: 'rgba(125, 249, 255, 0.55)',
} as const;

const BODY_PALETTE: Readonly<Record<string, string>> = {
  sun: '#ffe28a',
  mercury: '#b8a898',
  venus: '#e3c07d',
  earth: '#5ce1e6',
  eros: '#d8b46a',
  mars: '#ff8a4c',
  vesta: '#9aa7b2',
  ceres: '#7aa6b8',
  pallas: '#8c99a8',
  psyche: '#b5b8c2',
  hygiea: '#6d94a8',
};

const RANGE_RINGS_AU = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];

function factionColor(faction: FactionId): string {
  return faction === 'earth' ? CIC_COLORS.earth : CIC_COLORS.mars;
}

function propulsionCode(propulsion: UnitEntity['propulsion']): string {
  if (propulsion === 'nuclear') return 'N';
  if (propulsion === 'electric') return 'E';
  return 'C';
}

/**
 * Pure Canvas2D vector renderer for the inner solar system CIC map.
 * Computes all world->screen projections in float64 before issuing Canvas2D draw calls.
 */
export class SolarSystemVectorRenderer implements IRenderer {
  private readonly ctx: Canvas2DContextLike;
  private readonly orbitCache = new Map<string, Vec2[]>();

  constructor(ctx: Canvas2DContextLike) {
    this.ctx = ctx;
  }

  render(frame: RenderFrameState): void {
    const { ctx } = this;
    const { viewportWidth: w, viewportHeight: h, camera } = frame;
    const tier = camera.getSemanticZoomTier();
    const pixelsPerAu = camera.getPixelsPerAu();

    // 1. Background
    ctx.save();
    ctx.fillStyle = CIC_COLORS.background;
    ctx.fillRect(0, 0, w, h);

    // 2. Heliocentric reference rings & axes
    this.drawReferenceGrid(frame, pixelsPerAu);

    // 3. Body positions at current simulation time
    const bodyStates = new Map<string, { pos: Vec2; vel: Vec2 }>();
    for (const body of frame.bodies) {
      bodyStates.set(body.id, getBodyStateAt(body, frame.gameTimeSec));
    }

    // 4. Orbital ellipses (clipped in screen space after float64 transform)
    for (const body of frame.bodies) {
      if (!body.orbit) continue;
      const highlighted =
        body.id === 'earth' ||
        body.id === 'mars' ||
        body.id === 'eros' ||
        body.id === frame.focusedBodyId;
      this.drawOrbitEllipse(
        `body:${body.id}`,
        body.orbit,
        frame,
        highlighted ? CIC_COLORS.orbitHighlighted : CIC_COLORS.orbitDefault,
        highlighted ? 1.25 : 1,
      );
    }

    // 5. Anti-sunward umbra shadow sectors
    for (const body of frame.bodies) {
      if (!body.orbit || body.umbraLengthAu <= 0) continue;
      const state = bodyStates.get(body.id);
      if (!state) continue;
      this.drawUmbraSector(body, state.pos, frame);
    }

    // 6. Celestial bodies (Sun + 10 planets/asteroids)
    for (const body of frame.bodies) {
      const state = bodyStates.get(body.id);
      if (!state) continue;
      this.drawCelestialBody(body, state.pos, frame, tier, pixelsPerAu);
    }

    // 7. Units with semantic-zoom vector symbology
    for (const unit of frame.units) {
      const isSelected = unit.id === frame.selectedUnitId;
      if (isSelected || tier === 'tactical') {
        this.drawOrbitEllipse(
          `unit:${unit.id}:${unit.orbit.a}:${unit.orbit.e}:${unit.orbit.omega}`,
          unit.orbit,
          frame,
          isSelected ? 'rgba(125, 249, 255, 0.35)' : 'rgba(125, 249, 255, 0.14)',
          1,
          [4, 4],
        );
      }
      this.drawUnitSymbol(unit, frame, tier, pixelsPerAu, isSelected);
    }

    // 8. Scale bar overlay
    this.drawScaleBar(w, h, pixelsPerAu);
    ctx.restore();
  }

  private getCachedOrbitPoints(key: string, orbit: KeplerOrbit): Vec2[] {
    let pts = this.orbitCache.get(key);
    if (!pts) {
      pts = sampleOrbitPoints(orbit, 192);
      // Keep cache bounded for dynamic unit orbits.
      if (this.orbitCache.size > 256) {
        this.orbitCache.clear();
      }
      this.orbitCache.set(key, pts);
    }
    return pts;
  }

  private drawReferenceGrid(frame: RenderFrameState, pixelsPerAu: number): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const sunScreen = camera.worldToScreen({ x: 0, y: 0 });

    ctx.save();
    ctx.strokeStyle = CIC_COLORS.gridRing;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);

    for (const radiusAu of RANGE_RINGS_AU) {
      const radiusPx = radiusAu * pixelsPerAu;
      // Skip rings that don't intersect the viewport at all.
      if (
        sunScreen.x + radiusPx < 0 ||
        sunScreen.x - radiusPx > w ||
        sunScreen.y + radiusPx < 0 ||
        sunScreen.y - radiusPx > h
      ) {
        continue;
      }
      // Avoid giant arc calls when zoomed deeply into a tight 0.05 AU patch.
      if (radiusPx > Math.max(w, h) * 8) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(sunScreen.x, sunScreen.y, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.strokeStyle = CIC_COLORS.gridAxis;
    if (sunScreen.y >= 0 && sunScreen.y <= h) {
      ctx.beginPath();
      ctx.moveTo(0, sunScreen.y);
      ctx.lineTo(w, sunScreen.y);
      ctx.stroke();
    }
    if (sunScreen.x >= 0 && sunScreen.x <= w) {
      ctx.beginPath();
      ctx.moveTo(sunScreen.x, 0);
      ctx.lineTo(sunScreen.x, h);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawOrbitEllipse(
    cacheKey: string,
    orbit: KeplerOrbit,
    frame: RenderFrameState,
    strokeStyle: string,
    lineWidth: number,
    dash: number[] = [],
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const worldPoints = this.getCachedOrbitPoints(cacheKey, orbit);

    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();

    let prevScreen = camera.worldToScreen(worldPoints[0]);
    for (let i = 1; i < worldPoints.length; i++) {
      const nextScreen = camera.worldToScreen(worldPoints[i]);
      const clipped = clipSegmentToRect(prevScreen, nextScreen, -16, -16, w + 16, h + 16);
      if (clipped) {
        ctx.moveTo(clipped[0].x, clipped[0].y);
        ctx.lineTo(clipped[1].x, clipped[1].y);
      }
      prevScreen = nextScreen;
    }

    ctx.stroke();
    ctx.restore();
  }

  private drawUmbraSector(
    body: CelestialBody,
    bodyPos: Vec2,
    frame: RenderFrameState,
  ): void {
    const polygon = computeUmbraSectorPolygon(
      bodyPos,
      body.occlusionRadiusAu,
      body.umbraLengthAu,
    );
    if (!polygon || polygon.length < 4) {
      return;
    }

    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const screenPoly = polygon.map((pt) => camera.worldToScreen(pt));

    // Bounding-box cull against viewport
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of screenPoly) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    if (maxX < -32 || minX > w + 32 || maxY < -32 || minY > h + 32) {
      return;
    }

    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = CIC_COLORS.umbraFill;
    ctx.beginPath();
    ctx.moveTo(screenPoly[0].x, screenPoly[0].y);
    for (let i = 1; i < screenPoly.length; i++) {
      ctx.lineTo(screenPoly[i].x, screenPoly[i].y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = CIC_COLORS.umbraBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(screenPoly[0].x, screenPoly[0].y);
    ctx.lineTo(screenPoly[1].x, screenPoly[1].y);
    ctx.moveTo(screenPoly[3].x, screenPoly[3].y);
    ctx.lineTo(screenPoly[2].x, screenPoly[2].y);
    ctx.stroke();
    ctx.restore();
  }

  private drawCelestialBody(
    body: CelestialBody,
    bodyPos: Vec2,
    frame: RenderFrameState,
    tier: SemanticZoomTier,
    pixelsPerAu: number,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const screenPos = camera.worldToScreen(bodyPos);

    const physicalRadiusPx = body.visualRadiusAu * pixelsPerAu;
    const minRadiusPx = body.id === 'sun' ? 6 : 3.5;
    const radiusPx = Math.max(minRadiusPx, physicalRadiusPx);

    if (
      screenPos.x + radiusPx * 2 < -24 ||
      screenPos.x - radiusPx * 2 > w + 24 ||
      screenPos.y + radiusPx * 2 < -24 ||
      screenPos.y - radiusPx * 2 > h + 24
    ) {
      return;
    }

    ctx.save();

    if (body.id === 'sun') {
      ctx.fillStyle = CIC_COLORS.sunGlow;
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, radiusPx * 1.85, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = CIC_COLORS.sunCore;
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const fill = BODY_PALETTE[body.id] ?? CIC_COLORS.neutralBody;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, radiusPx, 0, Math.PI * 2);
      ctx.fill();

      // Subtle night-side terminator shading when disc is large enough
      if (radiusPx >= 8) {
        const sunAngle = Math.atan2(-bodyPos.y, -bodyPos.x);
        ctx.fillStyle = 'rgba(5, 10, 14, 0.45)';
        ctx.beginPath();
        ctx.arc(
          screenPos.x,
          screenPos.y,
          radiusPx,
          sunAngle + Math.PI * 0.5,
          sunAngle + Math.PI * 1.5,
        );
        ctx.closePath();
        ctx.fill();
      }

      // Faction / contested tactical ring
      if (body.ownerSlot || body.id === 'eros' || body.id === frame.focusedBodyId) {
        ctx.strokeStyle = body.ownerSlot
          ? factionColor(body.ownerSlot)
          : CIC_COLORS.erosHighlight;
        ctx.lineWidth = body.id === frame.focusedBodyId ? 1.8 : 1.1;
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, radiusPx + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Label
    ctx.font =
      tier === 'strategic'
        ? '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = body.ownerSlot ? CIC_COLORS.labelBright : CIC_COLORS.labelMuted;

    const labelText =
      tier === 'tactical' && body.orbit
        ? `${body.name} (${body.orbit.a.toFixed(2)} AU)`
        : body.name;
    ctx.fillText(labelText, screenPos.x + radiusPx + 6, screenPos.y);

    ctx.restore();
  }

  private drawUnitSymbol(
    unit: UnitEntity,
    frame: RenderFrameState,
    tier: SemanticZoomTier,
    pixelsPerAu: number,
    isSelected: boolean,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const screenPos = camera.worldToScreen(unit.pos);

    if (
      screenPos.x < -32 ||
      screenPos.x > w + 32 ||
      screenPos.y < -32 ||
      screenPos.y > h + 32
    ) {
      return;
    }

    const color = factionColor(unit.faction);
    const size = tier === 'strategic' ? 5.5 : tier === 'operational' ? 7.5 : 10;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = isSelected ? 2 : 1.4;

    // Velocity heading vector tick in operational / tactical tiers
    if (tier !== 'strategic') {
      const speed = Math.hypot(unit.vel.x, unit.vel.y);
      if (speed > 1e-8) {
        const tickLen = tier === 'tactical' ? 20 : 14;
        const ux = unit.vel.x / speed;
        const uy = unit.vel.y / speed;
        ctx.save();
        ctx.strokeStyle = CIC_COLORS.velVector;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenPos.x, screenPos.y);
        ctx.lineTo(screenPos.x + ux * tickLen, screenPos.y + uy * tickLen);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Active radar ring indicator
    if (unit.radarActive && tier !== 'strategic') {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.25;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, size + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Distinct CIC vector glyph by UnitKind
    this.strokeUnitGlyph(unit.kind, screenPos.x, screenPos.y, size);

    if (isSelected) {
      ctx.strokeStyle = CIC_COLORS.selectedRing;
      ctx.lineWidth = 1.25;
      ctx.strokeRect(
        screenPos.x - size - 4,
        screenPos.y - size - 4,
        (size + 4) * 2,
        (size + 4) * 2,
      );
    }

    // Semantic labels & tactical status bars
    if (tier !== 'strategic' || isSelected) {
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;

      const label =
        tier === 'tactical'
          ? `${unit.id} [${propulsionCode(unit.propulsion)}]`
          : unit.id;
      ctx.fillText(label, screenPos.x + size + 5, screenPos.y - size);

      if (tier === 'tactical') {
        const barW = 28;
        const barX = screenPos.x + size + 5;
        const barY = screenPos.y + 3;
        const hpRatio = unit.maxHp > 0 ? Math.max(0, Math.min(1, unit.hp / unit.maxHp)) : 0;
        const dvRatio =
          unit.maxDeltaV > 0 ? Math.max(0, Math.min(1, unit.deltaV / unit.maxDeltaV)) : 0;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fillRect(barX, barY, barW, 2);
        ctx.fillRect(barX, barY + 4, barW, 2);

        ctx.fillStyle = color;
        ctx.fillRect(barX, barY, barW * hpRatio, 2);
        ctx.fillStyle = dvRatio < 0.2 ? '#ff5c5c' : '#ffd166';
        ctx.fillRect(barX, barY + 4, barW * dvRatio, 2);
      }
    }

    // Unused pixelsPerAu lint guard: keep signature extensible for tactical scale cues.
    void pixelsPerAu;
    ctx.restore();
  }

  private strokeUnitGlyph(kind: UnitKind, cx: number, cy: number, s: number): void {
    const { ctx } = this;
    ctx.beginPath();

    switch (kind) {
      case 'home_base': {
        // Double diamond / citadel
        ctx.moveTo(cx, cy - s * 1.25);
        ctx.lineTo(cx + s * 1.25, cy);
        ctx.lineTo(cx, cy + s * 1.25);
        ctx.lineTo(cx - s * 1.25, cy);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        return;
      }
      case 'mining_outpost':
      case 'relay_depot': {
        // Box station
        ctx.rect(cx - s * 0.75, cy - s * 0.75, s * 1.5, s * 1.5);
        ctx.stroke();
        return;
      }
      case 'freighter':
      case 'tanker': {
        // Elongated diamond
        ctx.moveTo(cx, cy - s * 0.8);
        ctx.lineTo(cx + s * 1.1, cy);
        ctx.lineTo(cx, cy + s * 0.8);
        ctx.lineTo(cx - s * 1.1, cy);
        ctx.closePath();
        ctx.stroke();
        return;
      }
      case 'cruiser': {
        // Heavy double-wing chevron
        ctx.moveTo(cx, cy - s * 1.15);
        ctx.lineTo(cx + s * 1.05, cy + s * 0.9);
        ctx.lineTo(cx, cy + s * 0.35);
        ctx.lineTo(cx - s * 1.05, cy + s * 0.9);
        ctx.closePath();
        ctx.stroke();
        return;
      }
      case 'drone_recon':
      case 'drone_ew': {
        // Compact cross-dot
        ctx.moveTo(cx - s * 0.65, cy);
        ctx.lineTo(cx + s * 0.65, cy);
        ctx.moveTo(cx, cy - s * 0.65);
        ctx.lineTo(cx, cy + s * 0.65);
        ctx.stroke();
        return;
      }
      default: {
        // Recon corvette, escort frigate, raider: crisp tactical triangle
        ctx.moveTo(cx, cy - s);
        ctx.lineTo(cx + s * 0.85, cy + s * 0.85);
        ctx.lineTo(cx - s * 0.85, cy + s * 0.85);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  private drawScaleBar(w: number, h: number, pixelsPerAu: number): void {
    const { ctx } = this;
    const spec = computeScaleBarSpec(pixelsPerAu);
    const marginRight = 18;
    const marginBottom = 18;
    const x2 = w - marginRight;
    const x1 = x2 - spec.pixels;
    const y = h - marginBottom;

    ctx.save();
    ctx.strokeStyle = CIC_COLORS.labelBright;
    ctx.fillStyle = CIC_COLORS.labelBright;
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(x1, y - 5);
    ctx.lineTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.lineTo(x2, y - 5);
    ctx.stroke();

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(spec.label, x2, y - 6);
    ctx.restore();
  }
}
