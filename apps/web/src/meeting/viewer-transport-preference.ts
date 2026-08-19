export type ViewerTransportPreference = 'auto' | 'turn' | 'sfu';

export const VIEWER_TRANSPORT_PREFERENCE_KEY = 'babagan.viewer-transport';

export function readViewerTransportPreference(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): ViewerTransportPreference {
  try {
    const value = storage.getItem(VIEWER_TRANSPORT_PREFERENCE_KEY);
    return isViewerTransportPreference(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveViewerTransportPreference(
  storage: Pick<Storage, 'setItem'>,
  preference: ViewerTransportPreference
): void {
  try {
    storage.setItem(VIEWER_TRANSPORT_PREFERENCE_KEY, preference);
  } catch {
    // Keep the selection for this session when browser storage is unavailable.
  }
}

export function viewerTransportPreferenceToIcePolicy(
  preference: ViewerTransportPreference
): RTCIceTransportPolicy {
  return preference === 'turn' ? 'relay' : 'all';
}

function isViewerTransportPreference(value: string | null): value is ViewerTransportPreference {
  return value === 'auto' || value === 'turn' || value === 'sfu';
}
