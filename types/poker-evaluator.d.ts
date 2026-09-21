declare module 'poker-evaluator' {
  export interface RawEvaluatedHand {
    handType: number;
    handRank: number;
    value: number;
    handName: string;
  }

  interface PokerEvaluatorModule {
    evalHand(cards: readonly string[]): RawEvaluatedHand;
  }

  const PokerEvaluator: PokerEvaluatorModule;
  export default PokerEvaluator;
}
