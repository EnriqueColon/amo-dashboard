// Type-only bridge: the payload shape is defined beside the code that builds it
// on the server; `import type` is erased at build time, so the client bundle
// never pulls server code in. Keeps components and the API in one contract.
export type { PeerIntelPayload } from "../../../../server/intel/peer-intel-service"
