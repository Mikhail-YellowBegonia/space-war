import { PROPULSION_CONFIGS, type PropulsionType, type Vec2, type VfxEvent } from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';
import type { Canvas2DContextLike } from './IRenderer.js';
import { getPlumeColor } from './pixelSprites.js';

export interface PixelParticle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ageSec: number;
  maxLifeSec: number;
  sizePx: number;
  color: string;
}

export interface PixelBeamEffect {
  from: Vec2;
  to: Vec2;
  ageSec: number;
  maxLifeSec: number;
  color: string;
  intensity: number;
}

const MAX_POOL_PARTICLES = 1024;
const MAX_ACTIVE_BEAMS = 64;

/**
 * Fixed-pool pixel particle and pulse-laser VFX engine designed to sustain >= 50fps
 * with 50+ in-flight munitions and 20+ ships without per-frame allocations.
 */
export class PixelVfxSystem {
  private readonly particles: PixelParticle[] = [];
  private writeCursor = 0;
  private readonly beams: PixelBeamEffect[] = [];
  private activeParticleCount = 0;
  private rngState = 0x12345678;

  constructor() {
    for (let i = 0; i < MAX_POOL_PARTICLES; i++) {
      this.particles.push({
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        ageSec: 0,
        maxLifeSec: 1,
        sizePx: 2,
        color: '#ffffff',
      });
    }
  }

  getActiveParticleCount(): number {
    return this.activeParticleCount;
  }

  getActiveBeamCount(): number {
    return this.beams.length;
  }

  private nextRand(): number {
    // Deterministic fast LCG so VFX tests and frame render times stay predictable
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0xffffffff;
  }

  private spawnParticle(
    x: number,
    y: number,
    vx: number,
    vy: number,
    maxLifeSec: number,
    sizePx: number,
    color: string,
  ): void {
    const slot = this.particles[this.writeCursor]!;
    this.writeCursor = (this.writeCursor + 1) % MAX_POOL_PARTICLES;

    if (!slot.active) {
      this.activeParticleCount += 1;
    }
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.vx = vx;
    slot.vy = vy;
    slot.ageSec = 0;
    slot.maxLifeSec = maxLifeSec;
    slot.sizePx = sizePx;
    slot.color = color;
  }

  /**
   * Emits thrust- and thermal-coupled exhaust plume pixels behind a burning ship or munition.
   */
  emitThrusterPlume(
    worldPos: Vec2,
    exhaustDir: Vec2,
    propulsion: PropulsionType,
    heatRatio: number,
    thrustFraction = 1,
  ): void {
    const irFactor = PROPULSION_CONFIGS[propulsion].irFactor;
    const count = irFactor >= 50 ? 2 : 1;
    const color = getPlumeColor(propulsion, heatRatio);
    const baseSpeed = (0.008 + Math.min(0.03, irFactor * 0.00025)) * Math.max(0.25, thrustFraction);
    const sizePx = irFactor >= 50 ? 3 : 2;
    const life = propulsion === 'electric' ? 0.25 : 0.42;

    for (let i = 0; i < count; i++) {
      const jitterAngle = (this.nextRand() - 0.5) * 0.35;
      const cosJ = Math.cos(jitterAngle);
      const sinJ = Math.sin(jitterAngle);
      const dx = exhaustDir.x * cosJ - exhaustDir.y * sinJ;
      const dy = exhaustDir.x * sinJ + exhaustDir.y * cosJ;

      this.spawnParticle(
        worldPos.x,
        worldPos.y,
        dx * baseSpeed * (0.7 + this.nextRand() * 0.6),
        dy * baseSpeed * (0.7 + this.nextRand() * 0.6),
        life,
        sizePx,
        color,
      );
    }
  }

  /**
   * Converts simulation `VfxEvent[]` into pixel beams, CIWS sparks, explosions, and ignition flashes.
   */
  ingestVfxEvents(events: readonly VfxEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'laser': {
          if (ev.to) {
            if (this.beams.length >= MAX_ACTIVE_BEAMS) {
              this.beams.shift();
            }
            this.beams.push({
              from: { ...ev.from },
              to: { ...ev.to },
              ageSec: 0,
              maxLifeSec: 0.24,
              color: '#ff5c8a',
              intensity: ev.intensity,
            });
            for (let i = 0; i < 4; i++) {
              const ang = this.nextRand() * Math.PI * 2;
              const spd = 0.01 + this.nextRand() * 0.02;
              this.spawnParticle(
                ev.to.x,
                ev.to.y,
                Math.cos(ang) * spd,
                Math.sin(ang) * spd,
                0.28,
                2,
                '#ff9ebb',
              );
            }
          }
          break;
        }

        case 'ciws': {
          const sparkCount = 10;
          for (let i = 0; i < sparkCount; i++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 0.015 + this.nextRand() * 0.035;
            this.spawnParticle(
              ev.from.x,
              ev.from.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd,
              0.36,
              2,
              i % 2 === 0 ? '#fff3b0' : '#ff9f1c',
            );
          }
          break;
        }

        case 'explosion': {
          const debrisCount = 20;
          for (let i = 0; i < debrisCount; i++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 0.008 + this.nextRand() * 0.04;
            const palette = ['#ffffff', '#ffd166', '#ff6b6b', '#8d99ae'];
            this.spawnParticle(
              ev.from.x,
              ev.from.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd,
              0.55 + this.nextRand() * 0.3,
              i % 3 === 0 ? 3 : 2,
              palette[i % palette.length]!,
            );
          }
          break;
        }

        case 'burn_flash': {
          for (let i = 0; i < 4; i++) {
            const ang = this.nextRand() * Math.PI * 2;
            const spd = 0.006 + this.nextRand() * 0.015;
            this.spawnParticle(
              ev.from.x,
              ev.from.y,
              Math.cos(ang) * spd,
              Math.sin(ang) * spd,
              0.25,
              2,
              ev.intensity >= 0.8 ? '#fff2b2' : '#7df9ff',
            );
          }
          break;
        }
      }
    }
  }

  /**
   * Advances particle positions and ages by `dtSec`.
   */
  step(dtSec: number): void {
    if (dtSec <= 0) return;

    let activeCount = 0;
    for (let i = 0; i < MAX_POOL_PARTICLES; i++) {
      const p = this.particles[i]!;
      if (!p.active) continue;
      p.ageSec += dtSec;
      if (p.ageSec >= p.maxLifeSec) {
        p.active = false;
        continue;
      }
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      activeCount += 1;
    }
    this.activeParticleCount = activeCount;

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]!;
      b.ageSec += dtSec;
      if (b.ageSec >= b.maxLifeSec) {
        this.beams.splice(i, 1);
      }
    }
  }

  /**
   * Renders active pulse laser beams and pixel particles onto Canvas2D.
   */
  render(
    ctx: Canvas2DContextLike,
    camera: Camera2D,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    // 1. Pulse laser lines
    for (const beam of this.beams) {
      const p1 = camera.worldToScreen(beam.from);
      const p2 = camera.worldToScreen(beam.to);
      const alpha = Math.max(0.1, 1 - beam.ageSec / beam.maxLifeSec);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = beam.color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    }

    // 2. Pixel particles (snapped to integer coordinates for crisp retro look)
    if (this.activeParticleCount === 0) {
      return;
    }

    ctx.save();
    for (let i = 0; i < MAX_POOL_PARTICLES; i++) {
      const p = this.particles[i]!;
      if (!p.active) continue;

      const s = camera.worldToScreen({ x: p.x, y: p.y });
      if (s.x < -8 || s.x > viewportWidth + 8 || s.y < -8 || s.y > viewportHeight + 8) {
        continue;
      }

      const alpha = Math.max(0.1, 1 - p.ageSec / p.maxLifeSec);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(s.x - p.sizePx * 0.5), Math.round(s.y - p.sizePx * 0.5), p.sizePx, p.sizePx);
    }
    ctx.restore();
  }
}
