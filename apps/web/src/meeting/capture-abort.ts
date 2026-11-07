export function captureAborted(): DOMException {
  return new DOMException('Screen sharing was cancelled.', 'AbortError');
}

/** Discard late capture results even when the browser picker cannot be dismissed. */
export function abortableCapture<T>(operation: () => Promise<T> | T, signal?: AbortSignal,
  discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => { aborted = true; reject(captureAborted()); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => signal?.removeEventListener('abort', onAbort);
    try {
      Promise.resolve(operation()).then(value => {
        detach();
        if (aborted) discard?.(value); else resolve(value);
      }, error => { detach(); reject(error); });
    } catch (error) { detach(); reject(error); }
  });
}

export function stopCaptureStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
