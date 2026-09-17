// Only what is imported through this file. `unionOf`, `mayDisplaceSlowPeer`,
// `URGENCY_ORDER`, `nearestFirst`, `piecesNeededFor` and `piecesWithin` were
// re-exported here and taken by nobody; each is still where it is declared, and
// still used there.
export { DemandRegister } from "./DemandRegister.js";
export { Window } from "./Window.js";
export { isConditional, selectionPriority, Urgency, urgencyName } from "./Urgency.js";
export { bytesOf, piecesOf } from "./pieces.js";
