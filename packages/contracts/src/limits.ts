// The limits a client has to know to use the API well. They are here, away
// from the schemas, so that a client which only needs the numbers, such as a
// page in a browser, doesn't carry the validator along with them.

/** The longest one request may wait for an event, in seconds. Clients loop. */
export const MAX_WAIT_SECONDS = 20;

/** The most tasks one write creates. A longer plan takes several. */
export const MAX_TASKS_PER_WRITE = 15;
