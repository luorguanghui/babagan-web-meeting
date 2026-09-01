export type ScreenShareTurnProviderPreference = 'auto' | 'coturn' | 'cloudflare';

export const SCREEN_SHARE_TURN_PROVIDER_PREFERENCE_KEY = 'babagan.screen-turn-provider';

export function readScreenShareTurnProviderPreference(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): ScreenShareTurnProviderPreference {
  try {
    const value = storage.getItem(SCREEN_SHARE_TURN_PROVIDER_PREFERENCE_KEY);
    return isScreenShareTurnProviderPreference(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveScreenShareTurnProviderPreference(
  storage: Pick<Storage, 'setItem'>,
  preference: ScreenShareTurnProviderPreference
): void {
  try {
    storage.setItem(SCREEN_SHARE_TURN_PROVIDER_PREFERENCE_KEY, preference);
  } catch {
    // Keep the in-session selection when browser storage is unavailable.
  }
}

function isScreenShareTurnProviderPreference(value: string | null): value is ScreenShareTurnProviderPreference {
  return value === 'auto' || value === 'coturn' || value === 'cloudflare';
}
