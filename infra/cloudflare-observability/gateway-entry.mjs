import original, { MeetingRoom } from './legacy-room-worker.mjs';
import { observeFetch } from './diagnostics.mjs';
import { secureGateway } from './sfu-gateway.mjs';

export { MeetingRoom };
export default observeFetch(secureGateway(original));
