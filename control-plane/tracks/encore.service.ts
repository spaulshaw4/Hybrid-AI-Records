import { Service } from "encore.dev/service";

// Track job lifecycle: client API, Postgres state, worker dispatch + callbacks.
export default new Service("tracks");
