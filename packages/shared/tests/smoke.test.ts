import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ } from '../src/index.js';

describe('@space-war/shared scaffold', () => {
  it('exposes baseline protocol and simulation constants', () => {
    expect(PROTOCOL_VERSION).toBe('0.1.0');
    expect(SIM_TICK_RATE_HZ).toBe(10);
  });
});
