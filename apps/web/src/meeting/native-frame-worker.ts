/// <reference lib="webworker" />
import { NativeFrameWorkerRuntime, type WorkerRequest } from './worker-pacer.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = new NativeFrameWorkerRuntime(message => scope.postMessage(message));
scope.onmessage = (event: MessageEvent<WorkerRequest>) => runtime.handle(event.data);
