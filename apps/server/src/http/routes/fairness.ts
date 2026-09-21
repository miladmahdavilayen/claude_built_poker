import type { FastifyInstance } from 'fastify';
import type { Store } from '../../db/store.js';
import { verifyHand } from '../../rng/commitReveal.js';

export function registerFairnessRoutes(app: FastifyInstance, store: Store): void {
  app.get('/fairness/:handId', async (req, reply) => {
    const { handId } = req.params as { handId: string };
    const hand = await store.getHandForVerification(handId);
    if (!hand) return reply.code(404).send({ code: 'HAND_NOT_FOUND', message: 'Hand not found.' });
    if (!hand.rngCommit.serverSeed || !hand.rngCommit.deckOrder) {
      return {
        handId,
        revealed: false,
        commitment: hand.rngCommit.commitment,
        message: 'Server seed has not been revealed for this hand yet.',
      };
    }
    const result = verifyHand({
      serverSeedHex: hand.rngCommit.serverSeed,
      commitment: hand.rngCommit.commitment,
      clientSeeds: hand.rngCommit.clientSeeds,
      handNumber: hand.handNumber,
      dealtDeck: hand.rngCommit.deckOrder,
    });
    return {
      handId,
      revealed: true,
      valid: result.valid,
      commitmentMatches: result.commitmentMatches,
      deckMatches: result.deckMatches,
      commitment: hand.rngCommit.commitment,
      serverSeed: hand.rngCommit.serverSeed,
      clientSeeds: hand.rngCommit.clientSeeds,
      handNumber: hand.handNumber,
      dealtDeck: hand.rngCommit.deckOrder,
      derivedDeck: result.derivedDeck,
    };
  });
}
