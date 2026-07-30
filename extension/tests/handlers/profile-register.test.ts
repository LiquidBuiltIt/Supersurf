import { describe, it, expect, vi } from 'vitest';
import { applyProfileRegister } from '../../src/handlers/profile-register';

describe('applyProfileRegister', () => {
  it('persists supersurf_profile and does not close the registration tab', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    await applyProfileRegister('684f7687', 42, { local: { set } }, { remove });

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
    expect(remove).not.toHaveBeenCalled();
  });
});
