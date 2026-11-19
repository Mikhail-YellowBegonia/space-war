import {
  UNIT_CONFIGS,
  getBodyStateAt,
  orbitToState,
  type BingoWarningLevel,
  type CelestialBody,
  type FactionId,
  type KeplerOrbit,
  type LogisticsRoute,
  type MunitionEntity,
  type SensorTrack,
  type UnitEntity,
  type UnitKind,
  type Vec2,
  type WonderSlot,
} from '@space-war/shared';
import type { SemanticZoomTier } from '../camera/index.js';
import type {
  Canvas2DContextLike,
  IRenderer,
  RenderFrameState,
  TransferPreviewRenderData,
} from './IRenderer.js';
import {
  clipSegmentToRect,
  computeScaleBarSpec,
  computeUmbraSectorPolygon,
  sampleOrbitPoints,
} from './orbitGeometry.js';
import {
  computeConeSectorPoints,
  computeEllipseHatchSegments,
  computeJamNoiseArcs,
  computeOcclusionSectorPolygon,
  formatGhostLostTimer,
  sampleErrorEllipsePoints,
} from './situationalAwareness.js';
import {
  MUNITION_PIXEL_SPRITES,
  UNIT_PIXEL_SPRITES,
  getUnitSpritePalette,
  type PixelSpriteDefinition,
  type PixelSpritePalette,
} from './pixelSprites.js';
import { PixelVfxSystem } from './PixelVfxSystem.js';
import { computeCoOrbitalWonderNodes } from './wonderRing.js';

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
  private readonly vfxSystem = new PixelVfxSystem();
  private lastFrameTimeSec: number | null = null;

  constructor(ctx: Canvas2DContextLike) {
    this.ctx = ctx;
  }

  getVfxSystem(): PixelVfxSystem {
    return this.vfxSystem;
  }

  render(frame: RenderFrameState): void {
    const { ctx } = this;
    const { viewportWidth: w, viewportHeight: h, camera } = frame;
    const tier = camera.getSemanticZoomTier();
    const pixelsPerAu = camera.getPixelsPerAu();

    // Update particle & beam VFX simulation
    const dtSec =
      this.lastFrameTimeSec === null
        ? 0.016
        : Math.max(0, Math.min(0.25, frame.gameTimeSec - this.lastFrameTimeSec));
    this.lastFrameTimeSec = frame.gameTimeSec;
    if (frame.vfxEvents && frame.vfxEvents.length > 0 && dtSec > 0) {
      this.vfxSystem.ingestVfxEvents(frame.vfxEvents);
    }
    if (dtSec > 0) {
      this.emitActiveThrusterPlumes(frame);
      this.vfxSystem.step(dtSec);
    }

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

    // 3b. Shadow & Occlusion wedges rendered beneath orbit lines for clear visual layering
    for (const body of frame.bodies) {
      if (!body.orbit || body.umbraLengthAu <= 0) continue;
      const state = bodyStates.get(body.id);
      if (!state) continue;
      this.drawUmbraSector(body, state.pos, frame);
    }

    const selectedUnit = frame.selectedUnitId
      ? frame.units.find((u) => u.id === frame.selectedUnitId)
      : undefined;
    if (selectedUnit) {
      this.drawObserverOcclusionSectors(selectedUnit.pos, frame.bodies, bodyStates, frame);
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

    // 5. Active sensor / EW emission envelopes (LADAR scan cones & RF jammers)
    for (const unit of frame.units) {
      this.drawUnitSensorAndEwOverlays(unit, frame, pixelsPerAu);
    }

    // 5b. Logistics route lanes and detour waypoints
    if (frame.routes && frame.routes.length > 0) {
      this.drawLogisticsRoutes(frame.routes, bodyStates, frame);
    }

    // 5c. 16-slot co-orbital wonder ring nodes
    if (frame.ownWonder && frame.ownWonder.length > 0) {
      const wonderFaction = frame.faction ?? frame.units[0]?.faction ?? 'earth';
      this.drawWonderRingNodes(wonderFaction, frame.ownWonder, frame);
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

    // 7b. 4-tier situational awareness enemy sensor tracks & ECM noise rings
    const selectedTargetSet = new Set(frame.selectedTargetTrackIds ?? []);
    if (frame.tracks) {
      for (const track of frame.tracks) {
        this.drawTrackMarker(track, frame, pixelsPerAu, selectedTargetSet.has(track.trackId));
      }
    }

    // 7b-2. Friendly in-flight munitions
    if (frame.ownMunitions) {
      for (const mun of frame.ownMunitions) {
        if (!mun.intercepted) {
          this.drawMunitionMarker(mun, frame, tier);
        }
      }
    }

    // 7b-3. Direct pixel particles & pulse laser beams
    this.vfxSystem.render(ctx, camera, w, h);

    // 7b-3. Close-range brawl & incoming munition advisories
    if (frame.engagementAdvisories && frame.engagementAdvisories.length > 0) {
      this.drawEngagementAdvisories(frame);
    }

    // 7c. Active transfer preview arcs, draft orbit, and draggable apsis handles
    if (frame.previewTransfer) {
      this.drawTransferPreview(frame.previewTransfer, frame);
    }

    // 7d. Box-selection marquee for anti-missile / target assignment
    if (frame.boxSelectRect) {
      this.drawBoxSelectRect(frame.boxSelectRect);
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

    // Distinct CIC vector glyph in strategic zoom; oriented pixel sprite with thermal radiator glow closer in
    if (tier === 'strategic') {
      this.strokeUnitGlyph(unit.kind, screenPos.x, screenPos.y, size);
    } else {
      const sprite = UNIT_PIXEL_SPRITES[unit.kind];
      const heatRatio = unit.maxHeat > 0 ? unit.heat / unit.maxHeat : 0;
      const palette = getUnitSpritePalette(
        unit.faction,
        heatRatio,
        unit.radiatorsOpen,
        unit.emconSilent,
      );
      const speed = Math.hypot(unit.vel.x, unit.vel.y);
      const heading = speed > 1e-8 ? Math.atan2(unit.vel.y, unit.vel.x) : 0;
      const pxScale = tier === 'tactical' ? 2.5 : 1.75;
      this.drawPixelSprite(sprite, screenPos.x, screenPos.y, heading, pxScale, palette);
    }

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

  private drawObserverOcclusionSectors(
    observerPos: Vec2,
    bodies: readonly CelestialBody[],
    bodyStates: ReadonlyMap<string, { pos: Vec2; vel: Vec2 }>,
    frame: RenderFrameState,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;

    for (const body of bodies) {
      if (body.occlusionRadiusAu <= 0) continue;
      const state = bodyStates.get(body.id);
      if (!state) continue;

      const dist = Math.hypot(state.pos.x - observerPos.x, state.pos.y - observerPos.y);
      if (dist > 2.2) continue;

      const poly = computeOcclusionSectorPolygon(
        observerPos,
        state.pos,
        body.occlusionRadiusAu,
        1.1,
      );
      if (!poly) continue;

      const screenPoly = poly.map((pt) => camera.worldToScreen(pt));
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
        continue;
      }

      ctx.save();
      ctx.fillStyle = 'rgba(46, 28, 72, 0.24)';
      ctx.beginPath();
      ctx.moveTo(screenPoly[0]!.x, screenPoly[0]!.y);
      for (let i = 1; i < screenPoly.length; i++) {
        ctx.lineTo(screenPoly[i]!.x, screenPoly[i]!.y);
      }
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(155, 140, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(screenPoly[0]!.x, screenPoly[0]!.y);
      ctx.lineTo(screenPoly[1]!.x, screenPoly[1]!.y);
      ctx.moveTo(screenPoly[3]!.x, screenPoly[3]!.y);
      ctx.lineTo(screenPoly[2]!.x, screenPoly[2]!.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawUnitSensorAndEwOverlays(
    unit: UnitEntity,
    frame: RenderFrameState,
    pixelsPerAu: number,
  ): void {
    const { ctx } = this;
    const { camera } = frame;
    const unitScreen = camera.worldToScreen(unit.pos);

    // Active LADAR directional scan cone
    if (unit.ladarTargetAngle !== undefined && !unit.emconSilent) {
      const sensorsCfg = UNIT_CONFIGS[unit.kind].sensors;
      if (sensorsCfg.ladarRangeAu > 0 && sensorsCfg.ladarConeRad > 0) {
        const coneWorld = computeConeSectorPoints(
          unit.pos,
          unit.ladarTargetAngle,
          sensorsCfg.ladarConeRad,
          sensorsCfg.ladarRangeAu,
          12,
        );
        const coneScreen = coneWorld.map((pt) => camera.worldToScreen(pt));

        ctx.save();
        ctx.fillStyle = 'rgba(56, 242, 178, 0.14)';
        ctx.beginPath();
        ctx.moveTo(coneScreen[0]!.x, coneScreen[0]!.y);
        for (let i = 1; i < coneScreen.length; i++) {
          ctx.lineTo(coneScreen[i]!.x, coneScreen[i]!.y);
        }
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(56, 242, 178, 0.55)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();

        // Sweeping LADAR beam pulse line inside cone
        const halfCone = sensorsCfg.ladarConeRad * 0.5;
        const sweep = unit.ladarTargetAngle + Math.sin(frame.gameTimeSec * 4.5) * halfCone * 0.85;
        const tipScreen = camera.worldToScreen({
          x: unit.pos.x + Math.cos(sweep) * sensorsCfg.ladarRangeAu,
          y: unit.pos.y + Math.sin(sweep) * sensorsCfg.ladarRangeAu,
        });
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(130, 255, 212, 0.72)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(unitScreen.x, unitScreen.y);
        ctx.lineTo(tipScreen.x, tipScreen.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Active RF jammer effect ring
    if (unit.jammerActive && !unit.emconSilent) {
      const jamRangePx = Math.max(18, 0.35 * pixelsPerAu);
      const arcs = computeJamNoiseArcs(frame.gameTimeSec, 6);
      ctx.save();
      ctx.strokeStyle = 'rgba(204, 130, 255, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      for (const arc of arcs) {
        ctx.beginPath();
        ctx.arc(
          unitScreen.x,
          unitScreen.y,
          jamRangePx * arc.radiusScale,
          arc.startAngle,
          arc.endAngle,
        );
        ctx.stroke();
      }
      ctx.restore();
    }

    // Short-range laser / point-defense envelope circle for selected or escort units
    const laserRangeAu = UNIT_CONFIGS[unit.kind].weapons.laserRangeAu;
    if (laserRangeAu > 0 && (unit.id === frame.selectedUnitId || frame.camera.getSemanticZoomTier() !== 'strategic')) {
      const laserPx = laserRangeAu * pixelsPerAu;
      if (laserPx >= 5) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 96, 128, 0.36)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(unitScreen.x, unitScreen.y, laserPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawTrackMarker(
    track: SensorTrack,
    frame: RenderFrameState,
    pixelsPerAu: number,
    isTargetSelected = false,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h, gameTimeSec } = frame;

    // 1. BEARING: pulsing infinite line-of-bearing ray
    if (track.confidence === 'bearing') {
      if (!track.originPos || track.bearingRad === undefined) return;
      const p1 = camera.worldToScreen(track.originPos);
      const farWorld = {
        x: track.originPos.x + Math.cos(track.bearingRad) * 7.0,
        y: track.originPos.y + Math.sin(track.bearingRad) * 7.0,
      };
      const p2 = camera.worldToScreen(farWorld);
      const clipped = clipSegmentToRect(p1, p2, 0, 0, w, h);
      if (!clipped) return;

      const blinkAlpha = 0.28 + 0.36 * (0.5 + 0.5 * Math.sin(gameTimeSec * 6.0));
      ctx.save();
      ctx.strokeStyle = CIC_COLORS.mars;
      ctx.globalAlpha = blinkAlpha;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(clipped[0].x, clipped[0].y);
      ctx.lineTo(clipped[1].x, clipped[1].y);
      ctx.stroke();

      // Label partway along clipped ray
      const lx = clipped[0].x + (clipped[1].x - clipped[0].x) * 0.28;
      const ly = clipped[0].y + (clipped[1].y - clipped[0].y) * 0.28;
      ctx.globalAlpha = Math.min(0.95, blinkAlpha + 0.25);
      ctx.fillStyle = CIC_COLORS.mars;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`[BRG] ${track.trackId}`, lx + 4, ly - 3);
      ctx.restore();
      return;
    }

    // 2. UNCERTAIN: semi-transparent hatched error ellipse + coarse velocity vector
    if (track.confidence === 'uncertain') {
      if (!track.pos) return;
      const centerScreen = camera.worldToScreen(track.pos);
      const majorAu = Math.max(track.errorRadiusMajorAu ?? 0.06, 12 / pixelsPerAu);
      const minorAu = Math.max(track.errorRadiusMinorAu ?? 0.03, 7 / pixelsPerAu);
      const angleRad = track.errorAngleRad ?? 0;

      const ellipseWorld = sampleErrorEllipsePoints(track.pos, majorAu, minorAu, angleRad, 32);
      const ellipseScreen = ellipseWorld.map((pt) => camera.worldToScreen(pt));
      const hatchesWorld = computeEllipseHatchSegments(track.pos, majorAu, minorAu, angleRad, 7);

      ctx.save();
      ctx.fillStyle = 'rgba(255, 138, 76, 0.14)';
      ctx.beginPath();
      ctx.moveTo(ellipseScreen[0]!.x, ellipseScreen[0]!.y);
      for (let i = 1; i < ellipseScreen.length; i++) {
        ctx.lineTo(ellipseScreen[i]!.x, ellipseScreen[i]!.y);
      }
      ctx.closePath();
      ctx.fill();

      // Diagonal hatch lines inside ellipse
      ctx.strokeStyle = 'rgba(255, 138, 76, 0.34)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const seg of hatchesWorld) {
        const s1 = camera.worldToScreen(seg.from);
        const s2 = camera.worldToScreen(seg.to);
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
      }
      ctx.stroke();

      // Ellipse dashed outline
      ctx.strokeStyle = CIC_COLORS.mars;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ellipseScreen[0]!.x, ellipseScreen[0]!.y);
      for (let i = 1; i < ellipseScreen.length; i++) {
        ctx.lineTo(ellipseScreen[i]!.x, ellipseScreen[i]!.y);
      }
      ctx.closePath();
      ctx.stroke();

      // Coarse velocity arrow
      if (track.vel) {
        const speed = Math.hypot(track.vel.x, track.vel.y);
        if (speed > 1e-8) {
          ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(255, 179, 102, 0.75)';
          ctx.beginPath();
          ctx.moveTo(centerScreen.x, centerScreen.y);
          ctx.lineTo(
            centerScreen.x + (track.vel.x / speed) * 16,
            centerScreen.y + (track.vel.y / speed) * 16,
          );
          ctx.stroke();
        }
      }

      if (track.isJammed) {
        this.drawJammedNoiseRing(
          centerScreen,
          Math.max(18, majorAu * pixelsPerAu + 6),
          gameTimeSec,
        );
      }

      ctx.fillStyle = CIC_COLORS.mars;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const prefix =
        track.suspectedKind === 'munition'
          ? '[MSL]'
          : track.isJammed
            ? '[JAMMED]'
            : '[UNC]';
      ctx.fillText(`${prefix} ${track.trackId}`, centerScreen.x + 12, centerScreen.y);

      if (isTargetSelected) {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ff4d4f';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(centerScreen.x, centerScreen.y, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // 3. CONFIRMED: solid reticle, predicted orbit arc, and velocity vector
    if (track.confidence === 'confirmed') {
      if (!track.pos) return;
      if (track.estimatedOrbit) {
        this.drawOrbitEllipse(
          `trk-conf:${track.trackId}:${track.estimatedOrbit.a.toFixed(4)}:${track.estimatedOrbit.e.toFixed(4)}:${track.estimatedOrbit.omega.toFixed(4)}`,
          track.estimatedOrbit,
          frame,
          'rgba(255, 107, 107, 0.42)',
          1.2,
          [3, 3],
        );
      }

      const screenPos = camera.worldToScreen(track.pos);
      if (screenPos.x < -32 || screenPos.x > w + 32 || screenPos.y < -32 || screenPos.y > h + 32) {
        return;
      }

      ctx.save();
      ctx.strokeStyle = '#ff6b6b';
      ctx.fillStyle = '#ff6b6b';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([]);
      // Solid diamond target lock reticle
      ctx.beginPath();
      ctx.moveTo(screenPos.x, screenPos.y - 8);
      ctx.lineTo(screenPos.x + 8, screenPos.y);
      ctx.lineTo(screenPos.x, screenPos.y + 8);
      ctx.lineTo(screenPos.x - 8, screenPos.y);
      ctx.closePath();
      ctx.stroke();

      if (track.vel) {
        const speed = Math.hypot(track.vel.x, track.vel.y);
        if (speed > 1e-8) {
          ctx.beginPath();
          ctx.moveTo(screenPos.x, screenPos.y);
          ctx.lineTo(
            screenPos.x + (track.vel.x / speed) * 18,
            screenPos.y + (track.vel.y / speed) * 18,
          );
          ctx.stroke();
        }
      }

      if (track.isJammed) {
        this.drawJammedNoiseRing(screenPos, 18, gameTimeSec);
      }

      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lockPrefix = track.suspectedKind === 'munition' ? '[MSL LOCK]' : '[LOCK]';
      ctx.fillText(`${lockPrefix} ${track.trackId}`, screenPos.x + 11, screenPos.y);

      if (isTargetSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    // 4. GHOST: fading dashed inertial extrapolation arc + lost-contact timer
    const lostSec = Math.max(0, gameTimeSec - track.lastObservedSec);
    const fadeAlpha = Math.max(0.25, 0.78 - lostSec * 0.01);
    const ghostWorldPos = track.estimatedOrbit
      ? orbitToState(track.estimatedOrbit, gameTimeSec).pos
      : track.pos;

    if (track.estimatedOrbit) {
      this.drawOrbitEllipse(
        `trk-ghost:${track.trackId}:${track.estimatedOrbit.a.toFixed(4)}:${track.estimatedOrbit.e.toFixed(4)}:${track.estimatedOrbit.omega.toFixed(4)}`,
        track.estimatedOrbit,
        frame,
        `rgba(180, 165, 130, ${(fadeAlpha * 0.5).toFixed(2)})`,
        1.1,
        [5, 6],
      );
    }

    if (!ghostWorldPos) return;
    const screenPos = camera.worldToScreen(ghostWorldPos);
    if (screenPos.x < -32 || screenPos.x > w + 32 || screenPos.y < -32 || screenPos.y > h + 32) {
      return;
    }

    ctx.save();
    ctx.strokeStyle = '#c8b48a';
    ctx.fillStyle = '#c8b48a';
    ctx.globalAlpha = fadeAlpha;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(screenPos.x - 6, screenPos.y - 6, 12, 12);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `[GHOST] ${track.trackId} · ${formatGhostLostTimer(lostSec)}`,
      screenPos.x + 10,
      screenPos.y,
    );
    ctx.restore();
  }

  private drawJammedNoiseRing(centerScreen: Vec2, radiusPx: number, gameTimeSec: number): void {
    const { ctx } = this;
    const arcs = computeJamNoiseArcs(gameTimeSec, 7);
    ctx.save();
    ctx.strokeStyle = '#d08aff';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 3]);
    for (const arc of arcs) {
      ctx.beginPath();
      ctx.arc(
        centerScreen.x,
        centerScreen.y,
        radiusPx * arc.radiusScale,
        arc.startAngle,
        arc.endAngle,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTransferPreview(
    preview: TransferPreviewRenderData,
    frame: RenderFrameState,
  ): void {
    const { ctx } = this;
    const { camera } = frame;
    const { option, draftOrbit, apsisHandles } = preview;

    if (draftOrbit) {
      this.drawOrbitEllipse(
        `draft:${draftOrbit.a.toFixed(5)}:${draftOrbit.e.toFixed(5)}:${draftOrbit.omega.toFixed(5)}`,
        draftOrbit,
        frame,
        'rgba(125, 249, 255, 0.55)',
        1.4,
        [6, 4],
      );
    }

    const previewColor = bingoColor(option.bingoWarning);
    for (let i = 0; i < option.previewOrbitSegments.length; i++) {
      const seg = option.previewOrbitSegments[i]!;
      this.drawOrbitEllipse(
        `preview:${option.mode}:${i}:${seg.a.toFixed(5)}:${seg.e.toFixed(5)}:${seg.omega.toFixed(5)}`,
        seg,
        frame,
        option.feasible ? previewColor : 'rgba(255, 92, 92, 0.45)',
        option.feasible ? 2.1 : 1.2,
        option.feasible ? [] : [3, 5],
      );
    }

    // Ignition node markers along burns
    for (let i = 0; i < option.burns.length; i++) {
      const burn = option.burns[i]!;
      const refOrbit = option.previewOrbitSegments[i] ?? option.previewOrbitSegments[0];
      if (!refOrbit) continue;
      const burnWorld = orbitToState(refOrbit, burn.executeAtSec).pos;
      const burnScreen = camera.worldToScreen(burnWorld);

      ctx.save();
      ctx.fillStyle = burn.isOccludedStart ? '#9b8cff' : previewColor;
      ctx.strokeStyle = '#050a0e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(burnScreen.x, burnScreen.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (apsisHandles) {
      this.drawApsisHandle('P', apsisHandles.periapsis, camera, '#5ce1e6');
      this.drawApsisHandle('A', apsisHandles.apoapsis, camera, '#ffd166');
    }
  }

  private drawApsisHandle(
    label: 'P' | 'A',
    worldPos: Vec2,
    camera: RenderFrameState['camera'],
    color: string,
  ): void {
    const { ctx } = this;
    const screen = camera.worldToScreen(worldPos);
    ctx.save();
    ctx.fillStyle = '#050a0e';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, screen.x, screen.y + 0.5);
    ctx.restore();
  }

  private drawMunitionMarker(
    mun: MunitionEntity,
    frame: RenderFrameState,
    tier: SemanticZoomTier,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const screen = camera.worldToScreen(mun.pos);
    if (screen.x < -16 || screen.x > w + 16 || screen.y < -16 || screen.y > h + 16) {
      return;
    }

    const speed = Math.hypot(mun.vel.x, mun.vel.y);
    const ux = speed > 1e-8 ? mun.vel.x / speed : 1;
    const uy = speed > 1e-8 ? mun.vel.y / speed : 0;

    if (tier !== 'strategic') {
      const heading = Math.atan2(uy, ux);
      const sprite = MUNITION_PIXEL_SPRITES[mun.profileId];
      const palette: PixelSpritePalette = {
        hull: mun.coldCoast ? '#4a7a8c' : '#ffd166',
        accent: '#ff9f1c',
        radiator: '#ff4d4f',
        core: mun.coldCoast ? '#7df9ff' : '#ffffff',
      };
      this.drawPixelSprite(sprite, screen.x, screen.y, heading, tier === 'tactical' ? 2.2 : 1.5, palette);
      return;
    }

    ctx.save();
    ctx.strokeStyle = mun.coldCoast ? '#7df9ff' : '#ffd166';
    ctx.fillStyle = mun.coldCoast ? '#7df9ff' : '#ff9f1c';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(screen.x + ux * 5, screen.y + uy * 5);
    ctx.lineTo(screen.x - ux * 4 - uy * 2.5, screen.y - uy * 4 + ux * 2.5);
    ctx.lineTo(screen.x - ux * 4 + uy * 2.5, screen.y - uy * 4 - ux * 2.5);
    ctx.closePath();
    ctx.fill();

    if (!mun.coldCoast) {
      ctx.beginPath();
      ctx.moveTo(screen.x - ux * 4, screen.y - uy * 4);
      ctx.lineTo(screen.x - ux * 11, screen.y - uy * 11);
      ctx.stroke();
    }
    ctx.restore();
  }

  private emitActiveThrusterPlumes(frame: RenderFrameState): void {
    const t = frame.gameTimeSec;
    for (const unit of frame.units) {
      if (unit.hp <= 0 || unit.deltaV <= 0 || unit.subsystems.propulsion === 'offline') continue;
      const activeBurn = unit.plannedBurns.find(
        (b) => t >= b.executeAtSec - 0.1 && t <= b.executeAtSec + Math.max(0.35, b.durationSec),
      );
      if (!activeBurn) continue;
      const dvLen = Math.hypot(activeBurn.deltaV.x, activeBurn.deltaV.y);
      const exhaustDir =
        dvLen > 1e-8
          ? { x: -activeBurn.deltaV.x / dvLen, y: -activeBurn.deltaV.y / dvLen }
          : { x: -1, y: 0 };
      const heatRatio = unit.maxHeat > 0 ? unit.heat / unit.maxHeat : 0;
      this.vfxSystem.emitThrusterPlume(unit.pos, exhaustDir, unit.propulsion, heatRatio, 1);
    }

    if (frame.ownMunitions) {
      for (const mun of frame.ownMunitions) {
        if (mun.intercepted || mun.coldCoast || mun.deltaV <= 0) continue;
        const speed = Math.hypot(mun.vel.x, mun.vel.y);
        const exhaustDir =
          speed > 1e-8 ? { x: -mun.vel.x / speed, y: -mun.vel.y / speed } : { x: -1, y: 0 };
        this.vfxSystem.emitThrusterPlume(mun.pos, exhaustDir, 'chemical', 0.6, 0.8);
      }
    }
  }

  private drawPixelSprite(
    sprite: PixelSpriteDefinition,
    cx: number,
    cy: number,
    headingRad: number,
    pixelSize: number,
    palette: PixelSpritePalette,
  ): void {
    const { ctx } = this;
    const cosH = Math.cos(headingRad);
    const sinH = Math.sin(headingRad);
    const halfW = (sprite.width - 1) * 0.5;
    const halfH = (sprite.height - 1) * 0.5;
    const block = Math.max(1, Math.round(pixelSize));

    ctx.save();
    for (let row = 0; row < sprite.height; row++) {
      const line = sprite.rows[row];
      if (!line) continue;
      const ly = (row - halfH) * pixelSize;
      for (let col = 0; col < sprite.width; col++) {
        const ch = line[col];
        if (!ch || ch === '.') continue;
        const lx = (col - halfW) * pixelSize;

        if (ch === 'H') ctx.fillStyle = palette.hull;
        else if (ch === 'A') ctx.fillStyle = palette.accent;
        else if (ch === 'R') ctx.fillStyle = palette.radiator;
        else ctx.fillStyle = palette.core;

        const rx = lx * cosH - ly * sinH;
        const ry = lx * sinH + ly * cosH;
        ctx.fillRect(Math.round(cx + rx - block * 0.5), Math.round(cy + ry - block * 0.5), block, block);
      }
    }
    ctx.restore();
  }

  private drawEngagementAdvisories(frame: RenderFrameState): void {
    const { ctx } = this;
    const { camera, engagementAdvisories } = frame;
    if (!engagementAdvisories) return;

    const unitById = new Map(frame.units.map((u) => [u.id, u]));
    const pulse = 0.45 + 0.4 * Math.sin(frame.gameTimeSec * 8);

    for (const adv of engagementAdvisories) {
      const unit = unitById.get(adv.ownUnitId);
      if (!unit) continue;
      const screen = camera.worldToScreen(unit.pos);

      ctx.save();
      ctx.strokeStyle =
        adv.kind === 'close_range_brawl'
          ? `rgba(255, 77, 79, ${pulse.toFixed(2)})`
          : `rgba(255, 183, 3, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, adv.kind === 'close_range_brawl' ? 18 : 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawBoxSelectRect(rect: NonNullable<RenderFrameState['boxSelectRect']>): void {
    const { ctx } = this;
    const x = Math.min(rect.x1, rect.x2);
    const y = Math.min(rect.y1, rect.y2);
    const w = Math.abs(rect.x2 - rect.x1);
    const h = Math.abs(rect.y2 - rect.y1);

    ctx.save();
    ctx.fillStyle = 'rgba(125, 249, 255, 0.10)';
    ctx.strokeStyle = '#7df9ff';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  private drawLogisticsRoutes(
    routes: readonly LogisticsRoute[],
    bodyStates: ReadonlyMap<string, { pos: Vec2; vel: Vec2 }>,
    frame: RenderFrameState,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h } = frame;
    const unitById = new Map(frame.units.map((u) => [u.id, u]));

    for (const route of routes) {
      const src = bodyStates.get(route.sourceBodyId)?.pos;
      const dstUnit = unitById.get(route.targetId)?.pos;
      const dstBody = bodyStates.get(route.targetId)?.pos;
      const dst = dstUnit ?? dstBody;
      if (!src || !dst) continue;

      const ptsWorld = route.detourWaypoint ? [src, route.detourWaypoint, dst] : [src, dst];
      const ptsScreen = ptsWorld.map((p) => camera.worldToScreen(p));

      ctx.save();
      ctx.strokeStyle = route.paused
        ? 'rgba(150, 165, 175, 0.25)'
        : route.transferMode === 'stealth'
          ? 'rgba(155, 140, 255, 0.32)'
          : 'rgba(92, 225, 230, 0.28)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash(route.paused ? [2, 6] : [6, 5]);
      ctx.beginPath();
      for (let i = 0; i < ptsScreen.length - 1; i++) {
        const clipped = clipSegmentToRect(ptsScreen[i]!, ptsScreen[i + 1]!, 0, 0, w, h);
        if (clipped) {
          ctx.moveTo(clipped[0].x, clipped[0].y);
          ctx.lineTo(clipped[1].x, clipped[1].y);
        }
      }
      ctx.stroke();

      if (route.detourWaypoint) {
        const wpScreen = ptsScreen[1]!;
        ctx.setLineDash([]);
        ctx.fillStyle = '#050a0e';
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(wpScreen.x, wpScreen.y - 5);
        ctx.lineTo(wpScreen.x + 5, wpScreen.y);
        ctx.lineTo(wpScreen.x, wpScreen.y + 5);
        ctx.lineTo(wpScreen.x - 5, wpScreen.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffd166';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`WP:${route.id}`, wpScreen.x + 7, wpScreen.y);
      }
      ctx.restore();
    }
  }

  private drawWonderRingNodes(
    faction: FactionId,
    wonderSlots: readonly WonderSlot[],
    frame: RenderFrameState,
  ): void {
    const { ctx } = this;
    const { camera, viewportWidth: w, viewportHeight: h, gameTimeSec } = frame;
    const nodes = computeCoOrbitalWonderNodes(faction, wonderSlots, gameTimeSec);
    const baseColor = factionColor(faction);

    ctx.save();
    for (const node of nodes) {
      const screen = camera.worldToScreen(node.pos);
      if (screen.x < -16 || screen.x > w + 16 || screen.y < -16 || screen.y > h + 16) {
        continue;
      }

      const { status, progressOre, requiredOre } = node.slot;
      if (status === 'empty') {
        ctx.strokeStyle = baseColor;
        ctx.globalAlpha = 0.28;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 3.2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (status === 'building') {
        const ratio = requiredOre > 0 ? Math.max(0.1, Math.min(1, progressOre / requiredOre)) : 0.5;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 4.5, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * ratio);
        ctx.stroke();
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(screen.x - 1.5, screen.y - 1.5, 3, 3);
      } else if (status === 'complete') {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = baseColor;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - 5);
        ctx.lineTo(screen.x + 5, screen.y);
        ctx.lineTo(screen.x, screen.y + 5);
        ctx.lineTo(screen.x - 5, screen.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // damaged_halted
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = '#ff4d4f';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(screen.x - 4, screen.y - 4);
        ctx.lineTo(screen.x + 4, screen.y + 4);
        ctx.moveTo(screen.x + 4, screen.y - 4);
        ctx.lineTo(screen.x - 4, screen.y + 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function bingoColor(warning: BingoWarningLevel): string {
  switch (warning) {
    case 'red':
      return '#ff4d4f';
    case 'amber':
      return '#ffb703';
    case 'safe':
      return '#4ade80';
  }
}
