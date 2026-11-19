import { PROTOCOL_VERSION } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { getClientBootBanner } from '../src/app.js';

describe('@space-war/client scaffold', () => {
  it('renders boot banner with shared protocol version and tick rate', () => {
    const banner = getClientBootBanner();
    expect(banner).toContain(PROTOCOL_VERSION);
    expect(banner).toContain('10Hz');
  });
});
