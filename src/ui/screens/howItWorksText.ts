/**
 * The words of the title screen's "How it works" scroll (screens/HowItWorks),
 * which shows until the in-game version (interfaces/info) has loaded. Kept in
 * a plain module, with no imports, so it stays on the title screen's small
 * download, and so howItWorks.test.ts can hold its time limit, computer
 * requirement and fees to the in-game words.
 */

export interface HowItWorksStep {
  title: string;
  body: string;
}

export const HOW_IT_WORKS_STEPS: readonly HowItWorksStep[] = [
  {
    title: "Pick an offer.",
    body: "At a bank booth, open the Exchange, choose how much USDC you want and how you will pay. The best live offer is shown first.",
  },
  {
    title: "Send fiat directly to the seller.",
    body: "Pay the exact amount on Revolut, Wise, Venmo or the method you picked. Your money goes straight to the seller, never to RampRidge.",
  },
  {
    title: "Prove the payment privately.",
    body: "Using the Peer extension in Chrome or Brave on a computer, pick that payment from your account within 6 hours. Peer checks it inside a secure enclave.",
  },
  {
    title: "The contract releases your USDC.",
    body: "Once the proof checks out, the Peer contract on Base sends the seller's escrowed USDC to your wallet. Peer's fee and RampRidge's 0.5% fee come out of the USDC you receive; every confirm screen lists them.",
  },
  {
    title: "Sellers deposit USDC and get paid.",
    body: "Sellers lock USDC in the contract with their payout details. Buyers pay them in fiat, and USDC only moves when a payment is proven.",
  },
];
