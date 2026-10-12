/**
 * The words of "How it works", kept apart from the scroll's sprites so tests
 * can hold them to what the buy and sell flows really do (the time limit,
 * the fees, needing a computer to prove a payment).
 */

export interface StepText {
  /** Bold first words ("Make an offer."). */
  lead: string;
  body: string;
}

/** Buying USDC, in order. */
export const BUY_STEP_TEXT: readonly StepText[] = [
  {
    lead: "Make an offer.",
    body: "Talk to a banker or use a booth. Pick your currency, payment app and amount; the best live offer is shown first.",
  },
  {
    lead: "The seller's USDC is held for you.",
    body: "When you confirm, the Peer contract on Base reserves the seller's USDC for your order until it expires. Peer's fee and RampRidge's 0.5% fee come out of the USDC you receive; every confirm screen lists them.",
  },
  {
    lead: "Pay the seller directly.",
    body: "Send the exact amount to the handle shown, from your own account, with your usual app.",
  },
  {
    lead: "Prove it privately.",
    body: "Using the Peer extension in Chrome or Brave on a computer, pick that payment from your account within 6 hours. Peer checks it inside a secure enclave.",
  },
  {
    lead: "Collect your USDC.",
    body: "Once the proof checks out, the contract releases the USDC to your wallet.",
  },
];

/** Selling USDC, in order. */
export const SELL_STEP_TEXT: readonly StepText[] = [
  {
    lead: "Deposit USDC.",
    body: "Open the bank and choose Deposit. Pick how you want to be paid and enter your handle; your USDC is locked in the Peer contract.",
  },
  {
    lead: "Buyers pay you directly.",
    body: "They send fiat to your handle. A buyer only receives your USDC once Peer proves their payment.",
  },
  {
    lead: "Withdraw what is left.",
    body: "Unsold USDC stays yours to withdraw from the bank. USDC reserved for a buyer unlocks if their order expires.",
  },
];
