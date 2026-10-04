const prisma = require('../config/prisma');
const logger = require('../config/logger');

/**
 * Idempotency wrapper for mutating inventory operations.
 *
 * booking-service retries every POST (lock / unlock / confirm / cancel) up to three
 * times on any 5xx or network error. Without a key, a request that succeeded but
 * whose response was lost to a timeout gets applied a second time — on the segment
 * path that meant duplicate seat_segment_locks rows, and the retry then tripped its
 * own overlap check and failed the booking with a spurious 409.
 *
 * Usage:
 *   return withIdempotency(eventKey, (key) =>
 *        retryTransaction(() => prisma.$transaction(async (tx) => {
 *             ...do the work...
 *             await recordIdempotency(tx, key, result);   // same transaction
 *             return result;
 *        }))
 *   );
 *
 * Recording inside the caller's transaction is what makes this atomic: if the work
 * rolls back, the key rolls back with it and a retry re-runs cleanly.
 */

const isUniqueViolation = (error) =>
     error?.code === 'P2002' ||
     error?.code === '23505' ||
     (typeof error?.message === 'string' && error.message.includes('idempotency_records_eventKey_key'));

const withIdempotency = async (eventKey, operation) => {
     // No key supplied — caller opted out (or is an older client). Behave as before.
     if (!eventKey) return operation(null);

     const existing = await prisma.idempotencyRecord.findUnique({ where: { eventKey } });
     if (existing) {
          logger.info(`Idempotent replay: ${eventKey}`);
          return existing.response;
     }

     try {
          return await operation(eventKey);
     } catch (error) {
          // A concurrent duplicate committed while we were working. Its result is the
          // authoritative one — return that rather than surfacing a constraint error.
          if (isUniqueViolation(error)) {
               const winner = await prisma.idempotencyRecord.findUnique({ where: { eventKey } });
               if (winner) {
                    logger.info(`Idempotent replay after concurrent commit: ${eventKey}`);
                    return winner.response;
               }
          }
          throw error;
     }
};

/**
 * Persist the idempotency record inside the operation's own transaction.
 * No-op when the caller supplied no key.
 */
const recordIdempotency = async (tx, eventKey, response) => {
     if (!eventKey) return;
     await tx.idempotencyRecord.create({ data: { eventKey, response } });
};

module.exports = { withIdempotency, recordIdempotency };
