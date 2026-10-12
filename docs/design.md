# RampRidge design spec

The product is one room: Varrock West Bank, Old School RuneScape (2007 era
look, fixed 600 ms tick), run as numbered worlds like the original's (301,
302, ...), each a full copy of the bank with its own players and chat. The
bank is the exchange. Every Peer protocol step
is expressed through an interface a player of the original game would
recognise. The original game is the reference for every visual and
interaction decision; when in doubt, do what the 2007 client did.

## The player's job

1. Arrive, see a living bank: other players walking and chatting, bankers
   behind booths, merchants shouting live offers.
2. Buy USDC with fiat, or sell USDC for fiat, without leaving the world.
3. Always know what state their money is in and what to do next.

Success signals: a completed purchase lands USDC in the inventory with the
coins sound and a world announcement; a sell order shows in the bank as a
"stall" with live fill progress.

## Screens

1. **Loading**: black background, the classic orange loading bar with
   "Loading - please wait." and a percentage while assets stream.
2. **Title screen**: the RampRidge logo in the gold bevelled RuneScape
   wordmark style over a dark scene of the bank (rendered from the real
   scene, slowly orbiting). Buttons: "Play now" (enter as a guest with a
   generated name) and "Existing user" (opens Privy). A one-line explanation
   under the logo: "Buy and sell USDC for cash with real players. Settled
   on-chain by Peer." Footer links: How it works, Peer, Terms.
3. **Character design** (first visit only, skippable): the original
   "Welcome to RampRidge" design interface with arrows for head, jaw, torso,
   arms, hands, legs, feet, colour swatches, male/female, and a display-name
   field with "Check availability". "Accept" enters the world.
4. **Game**: resizable layout.
   - 3D viewport fills the window.
   - Top-left: mouseover text ("Bank Banker / 3 more options").
   - Top-right: minimap (circular, rendered from the region's floor colours
     and walls, with white dots for players, yellow dots for NPCs, a
     compass that resets the camera to north on click) and orbs: Run energy
     (toggles run; run is on by default, and the choice is remembered on the
     device), and a USDC orb showing wallet balance (click opens the
     inventory).
   - Bottom-left: chatbox with tabs All / Game / Public / Trade, input line
     "Name: *" with the blinking asterisk; Enter sends.
   - Bottom-right: side panel with tabs: Inventory (wallet), Account
     (wallet address, Send USDC and Receive, verify, logout of wallet),
     Emotes, Settings (sound, music volume, roof/brightness if cheap), Logout
     (with the World Switcher, below).
   - Mobile (< 768 px): same elements scaled; chatbox collapses to one line
     until tapped; side panel opens as a sheet from tab icons; long-press is
     right-click; two-finger drag rotates; pinch zooms. A touch screen gets
     "Tap to walk. Hold for options. Pinch to zoom." once per device.
5. **First visit in the world**: the door banker's welcome opens in the
   chatbox dialogue, two pages long. Page one: what the bank is (a
   peer-to-peer exchange for USDC and cash) and where to trade (a banker, a
   booth, or a merchant's live offer). Page two: the safety rule in red
   ("Never send money to anyone outside the bank interfaces. Trades only
   settle through the bank.") and how to log in, or that the player is already
   logged in. Then "Show me how it works" or "Got it". A yellow **hint arrow**
   bobs over the banker nearest the player, as the original did for new
   players, until their first banker or booth interaction (Talk-to, Bank,
   Exchange, Collect); the dismissal is remembered on the device. The arrow
   never blocks clicks on the banker under it.

## Worlds

- The server places each arrival (Play now, a returning player): the busiest
  open world still below 70% of its cap, then the quietest with room, never a
  full one; a player still standing in a world goes back to it. A link with
  `?world=302`, a shared trade's link (the trade's world) and "Invite a
  friend" (the inviter's world) ask for that world, honoured when it has
  room. Every world full: "The bank is full right now. Try again in a few
  minutes." on the title, or in red under Accept on the character designer
  (its own lines, inside the window, on phones too).
- The first chatbox line names the world: "Welcome to RampRidge. You are on
  World 302." ("You followed a trade to the Bank of RampRidge. You are on
  World 302." for a shared trade), then "Trades only settle through the bank.
  Never send money to a player directly." When a link's world had no room:
  "Welcome to RampRidge. World 302 has no room, so you are on World 303." and
  "Use the World Switcher in the Logout tab to try it again."
- **Logout tab**: the original text, "You are on World 302.", a "World
  Switcher" button and "Click here to logout".
- **World Switcher** (in the Logout tab, as the original): "Current World"
  over the number, a close button back to the logout view, then the list of
  open worlds in number order, "World" and "Players" columns, rows
  alternating in tint, the current world highlighted in orange, a full world
  greyed with "FULL" in red. Clicking another world hops: the list gives way
  to "Please wait..." and "Switching to World 301" for at least one tick,
  then the other players, chat and stalls are the new world's, the player
  stands on the same tile, and the chatbox (which starts afresh) says
  "Welcome to RampRidge. You are on World 301." and the safety line again.
  The list counts the hop at once (one more in the new world, one fewer in
  the old) and then shows the server's fresh count. A refused hop says why in
  the chatbox ("World 302 is full."), that row turns FULL, and nothing else
  changes. A "Logout" button sits at the bottom. On a touch screen the rows
  are 36px tall, the kit's touch target.
- What is shared between worlds: world news (verified trades are announced
  in every world), the merchants and their offers, mutes and bans.

## In-world entities and their menus

Right-click (or long-press) opens "Choose Option". Left-click performs the
first option. Colours: NPC names yellow, objects cyan, players white,
items orange.

| Entity | Options | Result |
|---|---|---|
| Banker (behind each booth) | Talk-to, Bank, Exchange, Examine | Dialogue / Bank / Exchange |
| Bank booth | Bank, Exchange, Collect, Examine | Bank / Exchange / Collection box |
| Merchant NPC (live Peer liquidity) | Trade, Examine | Trade window for that platform and currency |
| Player with a stall | Trade with, Follow, Examine | Trade window against their deposit |
| Player | Follow, Examine | |
| Floor tile | Walk here | |

The player always walks to the target first (adjacent tile, facing it),
then the interface opens: exactly like the original.

## Interfaces

All interfaces are drawn with the original sprites: brown stone frames,
orange titles (#ff981f), the close button top-right. Text uses the RuneScape
fonts. Numbers use the original stack formatting in the inventory (white
under 100K, white "100K" up to 10M, green "10M" above; for USDC use whole
dollars as the stack size and show exact cents on hover/examine).

### Exchange (buy and sell offers, modelled on the Grand Exchange)

- 8 offer slots. Empty slot shows "Buy" and "Sell" buttons.
- **Buy**: choose currency (flag item), payment method (platform item; a
  currency's home method first, Alipay for CNY and UPI for INR; beta methods
  tagged; a method with nothing to fill says why, see
  [Currencies and payment methods](#currencies-and-payment-methods)),
  enter the fiat amount with the original amount buttons (+10, +100, +1K,
  custom "..."), see "Guide price" = best live rate and "You will receive
  ~X USDC". "Confirm" requests quotes; the best quote shows the seller (maker
  short address), rate, fees, and USDC received. Fees are itemised on
  every buy confirm screen: Peer's fee and the RampRidge fee (0.5%), both
  already taken from the USDC shown. "Confirm offer" signals the
  intent (wallet prompt or sponsored, invisible gas). A wallet that pays its
  own gas and has no ETH on Base is stopped before anything is sent: add a
  little and try again, or log in with email or Google, where the bank pays
  gas.
- **Proving needs a computer**: on a browser that can't run the Peer
  extension (a phone, an iPad, Safari, Firefox) and doesn't already have it,
  the buy screen says in red, before any order exists: "To finish, you must
  prove this payment with the Peer extension in Chrome or Brave on a
  computer, within 6 hours." Placing the order stays disabled until the
  player ticks "I will verify on a computer". Their order then waits in the
  Grand Exchange for them to log in on a computer with the same account.
- The slot then shows the order with a progress bar: orange while waiting
  for payment, green when completed, red when cancelled or expired. Clicking
  an active buy slot opens the **Payment scroll**.
- **Sell** opens the Bank's sell flow (deposit USDC with a payout method).

### Payment scroll (buy order after signalling)

A parchment clue scroll with one job per section, every fact said once:

- **The trade at a glance:** "Send £101.50" large, then "to @revtag on
  Revolut" (the handle only once the rules are ticked), "You get 125.40 USDC"
  and a small "Expires in" that turns bold dark red in the last 15 minutes.
- **1. Before you pay:** the platform's rules as a checklist (✓ do, ✗ don't,
  ! the platform warning, said once), then "I have read these rules" in its
  own box. The tick gates the payee, QR, pay link and "I have paid" per order.
- **2. Pay the seller:** label / value / Copy rows (handle, amount, note or
  bank), the QR (desktop) or a full-width "Open Revolut" (phone), and one calm
  safety line: "Pay exactly this amount, to this handle, from your own
  account." Zelle's bank choice and a missing pay code live here too.
- **3. Prove your payment:** the PeerAuth step (Add to Chrome, waiting,
  update, or "PeerAuth is installed"), or "verify on a computer" on phones.
- Footer: "I have paid" and a quiet "Cancel offer", then the fees already
  taken and the help line, all quieter than the steps.

Ink is dark brown on lightened parchment; warnings are deep ink red (no
bright red on parchment), every text colour at least 4.5:1 on the paper.

### Help on the money screens

"Get help" opens the RampRidge help account on X in a new tab (`HELP_URL` in
`src/ui/interfaces/shared/help.tsx`).

- Buy screens (Payment scroll, Verify payment): "Problem with this order? Get
  help", "Copy order details" (so a buyer never retypes an intent hash) and
  "We will never DM you first or ask you to send money." A buy error panel
  says "Stuck? Get help" with the same copy option.
- Bank and collection box: "Get help" beside every error and failed
  transaction, beside an unconfirmed transaction the player can release
  ("Nothing is pending"), and among the sell dialogue's recovery options.
- The Account tab has a "Get help" link; the Terms name the account and repeat
  the never-DM line.

### Verify payment

- If the Peer extension is missing: "You need the Peer extension to prove
  your payment." with an install button; detect install on focus.
- If it needs connection: "Connect the Peer extension" button
  (requestConnection).
- Then "Verify with Peer" opens the provider tab via the extension. When
  payments come back, show them as a list of rows (amount, recipient, date);
  the player must click the one that matches. Never auto-select.
- Fulfilling shows the original "Please wait..." style message, then on
  success: level-up style fireworks around the player, coins sound, the
  message "You bought 125.40 USDC." in the chatbox, inventory updates, and
  a world announcement.

### Bank (sell, and your open sell orders)

- The original bank interface: "The Bank of RampRidge", tabs, item grid.
- Your USDC wallet balance appears in the inventory beside it as Coins.
- Items in the bank are your live sell orders (each a stack of USDC with
  the platform as a note-style overlay); examine shows state, filled amount
  and buyer track record. Right-click options: Withdraw-All, Withdraw-X,
  Top-up, Advertise (shows your stall to players in your world; it follows
  you when you hop).
- "Deposit" (or using coins on the booth) opens the **Sell** dialogue:
  amount, payout method(s) and currency(ies), payout handle with live
  checks. "Handle found" appears only when Peer actually confirmed the
  handle (Venmo, Cash App, Revolut and Monzo are checked live); other
  platforms show a yellow "We can't check this handle. Check every
  character." Wise, PayPal and Alipay handles that Peer hasn't seen need a
  one-time verification through the Peer extension, which the leg offers to
  install if it is missing. A Zelle handle needs the seller to confirm it is
  enrolled with Zelle. Then the market (oracle) rate as the guide price, the
  seller's spread (0% by default, -5% to +5%) and rate, and the estimated
  payout. Every rule is under
  [Currencies and payment methods](#currencies-and-payment-methods).
- "Deposit" opens a **review** of the amount, every payout handle in full,
  the spread, the effective rate and the estimated payout (Confirm stays
  disabled briefly so a double-click can't pass through). Confirm runs
  approve + createDeposit (+ the buyer-access policy for Venmo and PayPal)
  with step progress in the chatbox.
- Bank items never act on a single click: left-click or tap opens the
  options menu, and Withdraw-All asks for confirmation.

### Trade window (merchants and player stalls)

The original two-screen trade:
1. "Trading with: Revolut GBP merchant". Left: "Your offer" (fiat amount
   input as an item: "£100 (Revolut)"). Right: "Their offer" (USDC). Buttons
   "Accept" / "Decline". Status line: "Other player has accepted." once a
   quote is ready.
2. Second screen: "Are you sure you want to make this trade?", the two
   offers listed in text, fees, and a red warning if the rate is worse than
   the market best. "Accept" signals the intent, then opens the Payment
   scroll.

On a browser that can't prove payments, the first screen carries the same
red "prove this payment ... on a computer, within 6 hours" notice as the
Exchange, and the second screen's Accept waits for "I will verify on a
computer".

### Send and Receive (USDC on and off the platform)

RampRidge is only peer-to-peer: USDC a player buys lands in their own wallet,
and they can move it anywhere on Base. Entry points: the Coins in the
inventory have "Send" in their options (after Examine and Sell; left-click
stays Examine), and the Account tab has "Send USDC" and "Receive" buttons in
place of "Copy address". Without a wallet both show "Log in to trade."

- **Send USDC** (stone window, keyboard and touch friendly; with a mouse and
  keyboard it opens in the amount box, and focus returns there after Back
  and the quick amounts, so typing never falls through to the chatbox): an
  amount box
  (decimal keypad, up to 6 decimals, a comma reads as the decimal point) with
  "All", "+10" and "+100" and "You have 125.40 USDC" under it; "All" is the
  exact on-chain balance. A recipient box with "Paste" (where the clipboard
  can be read), checked as it is typed: a well-formed 0x address in any case,
  shown EIP-55 checksummed once valid; a mixed-case address with a wrong
  checksum is refused as a likely typo; the zero address, the player's own
  address, USDC, every Peer contract (`PEER_CONTRACTS`), the ERC-4337
  EntryPoints, Multicall3 and WETH are refused because USDC sent there is
  stuck; names like .eth are not supported ("Enter a 0x address on Base.").
  A recipient with contract code (not an EIP-7702 delegated wallet) gets the
  note "This is a contract address. Make sure it can receive USDC on Base."
- **Review** ("Are you sure you want to send this?"): the amount, the full
  address in 4-character groups, "Network: Base", the network fee ("Free (the
  bank pays it)" for sponsored smart wallets, otherwise the estimated ETH,
  blocked with a plain reason when the wallet has too little ETH or the
  transfer would revert), and in bold red on a dark band "Sends can't be
  undone. Only send to an address that accepts USDC on Base." Confirm stays
  off for 1.5 s so a double-click can't pass through, and only Confirm itself
  sends (Enter elsewhere on the review does nothing); Back returns with the
  inputs kept. Tapping or clicking a grouped address selects all of it, and
  copying gives the plain address.
- **Sending**: "Sending 25.00 USDC to 0x1234…abcd" with "Please wait...".
  The balance is read again just before sending and a lower balance is
  refused. One send at a time. It is one attributed `USDC.transfer` through
  the same TxSender as every other transaction (sponsored for smart wallets;
  the wallet label is "Send 25.00 USDC to 0x1234…abcd"; Peer-account wallets
  get the click-to-continue prompt when the browser blocks their window).
- **Success**: "You sent 25.00 USDC to 0x1234…abcd." in the chatbox, the
  coins sound, the balance refreshes, and a "Sent!" screen with "View on
  Basescan" and "Done". Sends are never announced to the room.
- **Errors**, each with the next step: wallet rejection goes quietly back to
  the review; too little USDC goes back to the amount; no ETH for gas and a
  paymaster refusal ("try again later, or log in with your own wallet")
  offer Try again; anything that may have reached the chain (a timeout, a lost
  answer, an unknown wallet error) becomes **unconfirmed**: the send is kept
  as a record (in this browser, written before the wallet is asked, with the
  transaction hash or, for a smart wallet, the user operation's hash) and
  checked on Base every 15 s: by its transaction, by asking the smart
  wallet's bundler about the user operation, and by the USDC Transfer history
  (read through an RPC that serves eth_getLogs, continuing where the last
  check stopped). Found: success. Failed on-chain: nothing moved. Until then
  no other send can start, even after a reload. The screen links "View on
  Basescan" or, with no transaction yet, "Your USDC history on Basescan" (no
  wallet app is assumed). Only on evidence that it didn't happen (10 minutes
  passed, the whole history since searched with no such transfer, the
  balance not down by the amount, and the bundler holding nothing) may the
  player press "Let me send again".
- **Receive**: the wallet address in full (checksummed, grouped), "Copy
  address", a QR code of the address, "Send only USDC on Base to this
  address. Other tokens or networks may be lost." and what kind of wallet it
  is (a smart wallet for email and Google logins needs no ETH).

### Dialogue

Banker "Talk-to" uses the original chat-head dialogue box: "Good day, how
may I help you?" with options "I'd like to access my bank account, please."
(Bank), "I'd like to buy some coins." (Exchange buy), "I'd like to sell my
coins." (Sell), "What is this place?" (explains Peer in two short lines,
links "How it works").

Every dialogue line shows the speaker's **chathead**, drawn from the real
character model: head and shoulders, facing front, held still. NPC lines
show the banker the player is talking to (or the NPC or merchant speaking)
on the left; the player's own lines show their own look on the right, as in
the original. Without WebGL, or if the model fails, the line shows without a
head.

## Currencies and payment methods

Selling offers 11 platforms and the 11 major currencies, all priced by the
live oracle (see [Selling](#selling)). The buy side's matrix is defined in
`src/peer/platforms.ts` (see [Buying](#buying)). `bun run ops:matrix` checks
the matrix live against Curator, the attestation service, the SDK catalogue
and the Peer Cash oracles (`docs/runbook.md`). Argentine pesos are not
offered: Mercado Pago has no buyer verifier, and Peer web offers it for
neither buying nor selling. Monobank Business is not offered either: it
only takes UAH, which is not a major currency. No platform takes BRL. N26,
Luxon, Mercado Pago and Monobank stay in `src/peer/platforms.ts` as entries
that are never live.

### Buying

Quotes use Curator mode `eligible`, so a player only sees offers a brand-new
buyer can fill. Many currencies have few sellers or none at a given size. A
method with nothing to fill stays in the picker with its reason, because
liquidity comes and goes. Each platform offers only the major currencies
(`shared/currencies.ts`) that Peer lists for it.

| Platform | Currencies | PeerAuth | How the buyer pays |
|---|---|---|---|
| Revolut | USD EUR GBP SGD NZD AUD CAD MXN CHF CNY | 0.6.3 | Revolut app balance; a computer gets only the QR (revolut.me takes cards) |
| Wise | USD CNY EUR GBP AUD NZD CAD CHF SGD MXN INR | 0.6.3 | wise.com pay link or QR |
| Zelle | USD | 0.6.3 | The buyer's bank, chosen before paying: Chase, Bank of America or Citi |
| Cash App | USD | 0.6.3 | Cash App; QR on a computer |
| Chime | USD | 0.6.3 | Chime; QR on a computer |
| Monzo | GBP | 0.6.3 | Monzo app; QR on a computer |
| X Money (beta) | USD | 0.7.1 | x.com pay link or QR |
| Alipay (beta) | CNY | 0.6.7 | Alipay app, QR only |
| UPI via Amazon Pay (beta) | INR | 0.6.8 | Amazon Pay app, standard UPI, QR only |
| Venmo | USD | 0.6.3 | Venmo link or QR with a note; usually nothing to fill |
| PayPal | USD EUR GBP SGD NZD AUD CAD | 0.6.3 | paypal.me link or QR, personal or business picked at verification; usually nothing to fill |

The PeerAuth column is the oldest Peer extension that can capture the
platform's payment. An older one is told to update before verifying.

- **Alipay**: the QR is
  `alipays://platformapi/startapp?appId=20000116&actionType=toAccount&userId=<pid>&amount=<amt>`.
  `<pid>` is the maker's 16-digit `metadata.alipayPid` from Curator
  (`GET /v2/makers/alipay/{payeeDetailsHash}`, the SDK's
  `apiGetPayeeDetails`, no auth). It is read before signalling. A seller
  without one is never signalled, because the buyer would have nothing to
  pay. Peer's capture reads only the buyer's latest Alipay payment, so the
  rules say not to pay anyone else before verifying.
- **UPI**: Amazon Pay only (`upi/transfer_upi_amazonpay`). The smallest order
  is 1 INR. The QR is `upi://pay?pa=<vpa>&cu=INR&am=<amt>`. Before ordering,
  the buyer sees Peer's notice, which doesn't block: "Pay with standard UPI in
  the Amazon Pay app, not UPI Lite and not a merchant payment. To verify,
  sign in on a computer to the same amazon.in account you paid from." The
  capture keeps only `SUCCESS` `DEBIT` rows with an amazon.in
  `/pay/transaction-details` link and use case `p2p_outgoing_pay` or
  `p2p_outgoing_scan_pay` (Peer's filter).
- **Venmo and PayPal**: on 2026-10-12 every Venmo deposit (139) and every
  PayPal deposit (23) was Peer Pay. A Peer Pay deposit makes the buyer stake
  at least the order's value in USDC, locked for the risk window. Someone
  buying their first USDC can't do that, so RampRidge doesn't quote them.
  Instead the picker says "Every Venmo seller on Peer only sells to Peer Pay
  members right now." (PayPal likewise). An unrestricted deposit would still
  fill normally. RampRidge's own Venmo and PayPal stalls carry the Peer Pay
  policy too, so players can't fill each other's.

### Selling

Selling offers only the major currencies: `MAJOR_CURRENCIES` in
`shared/currencies.ts` (USD, EUR, GBP, CAD, AUD, NZD, CHF, SGD, MXN, CNY,
INR), the most-traded currencies (BIS top 15) that Peer prices with a live
on-chain oracle. `shared/currencies.test.ts` checks that every one has an
oracle. `sellCapabilities()` (`src/peer/sell/cash.ts`) is `@zkp2p/cash`
0.7.2's production capabilities narrowed to those currencies, and a platform
left with none is not offered. That leaves 11 platforms and 11 currencies:

| Platform | Currencies | Payout handle |
|---|---|---|
| Alipay | CNY | Alipay email |
| Cash App | USD | $Cashtag |
| Chime | USD | $ChimeSign |
| Monzo | GBP | Monzo.me username |
| PayPal | AUD CAD EUR GBP NZD SGD USD | PayPal.Me username or email |
| Revolut | AUD CAD CHF CNY EUR GBP MXN NZD SGD USD | Revtag |
| UPI | INR | UPI ID |
| Venmo | USD | Venmo username |
| Wise | AUD CAD CHF CNY EUR GBP INR MXN NZD SGD USD | Wisetag or Wise email |
| X Money | USD | X username |
| Zelle | USD | Zelle email or US phone |

Peer Cash also sells Revolut and Wise TRY and ZAR, and Wise IDR and PHP;
RampRidge leaves them out. Peer Cash prices only currencies with a live
oracle, so nothing else can be sold.

- **Rate**: only `@zkp2p/cash`'s market-rate (oracle) path, as Peer's own web
  app does. Every currency of a deposit gets Peer Cash's spread-oracle tuple
  (`buildMarketRateCurrencyOverride`): the SDK's Chainlink adapter config for
  the currency, `spreadBps` 0, `minConversionRate` 1 wei (the oracle
  sentinel, so no floor) and the oracle's `maxStaleness`. A spread order
  changes only `spreadBps` (below). The deposit is priced at the oracle when
  a buyer signals, so the order follows the market. The Sell dialogue's
  guide price is the live oracle reading and its payout an estimate.
- **Spread**: the seller sets one spread for the whole order, as Peer's web
  app offers when a deposit is created. The default is 0% ("Market rate"),
  Peer web's default too: `@zkp2p/cash` 0.7.2 hard-codes
  `MARKET_SPREAD_BPS = 0` in `buildMarketRateCurrencyOverride`, and Peer web
  (zkp2p-clients
  `clients/web/src/components/Deposits/NewDeposit/useContractInputSync.ts`)
  starts every oracle-supported currency of a new deposit at `spreadBps` 0,
  with the same 1-wei floor (`helpers/depositRateConfig.ts`,
  `toOracleBackedMinConversionRateUnits`). The seller may choose -5% to +5%
  (Peer web's `CREATE_SPREAD_MIN_BPS` and `CREATE_SPREAD_MAX_BPS`, -500 and
  +500 bps): 0.1% step buttons (the rate must be granular) or a
  typed value to 0.01% (1 bps), refused with Peer web's
  messages ("Enter a valid premium or discount.", "Premium or discount must
  be between -5.00% and +5.00%."). A buyer pays oracle x (1 + spreadBps /
  10000) fiat per USDC (Peer web's `computeEffectiveRate`), so a positive
  spread pays the seller more and fills slower, and a negative one fills
  faster for less.
  - A 0% order is Peer Cash's own `prepare()`, unchanged.
  - A non-zero spread is built in `src/peer/sell/spread.ts` with
    `@zkp2p/cash`'s exported `prepareCashDepositParams` (the same Curator
    `makers/create` registration and error mapping, payment-method hashes,
    gating service, intent range including Alipay's single-order range, and
    `retainOnEmpty`), then `oracleRateConfig.spreadBps` is set on every
    currency tuple. Adapter, adapter config, `maxStaleness` and the 1-wei
    `minConversionRate` stay as they are, as in Peer web's
    `buildSpreadOracleRateConfig`. The approve + createDeposit batch, the
    ERC-8021 codes (`peer-cash`, `peer-ref-TOFIAT`, `rampridge`) and the Peer
    Pay access-policy step are the same.
  - Peer Cash 0.7.2's order reads refuse a deposit with a non-zero spread
    (`isCashPayoutSet` needs `marketRate` and `spreadBps` 0), so
    `getCashClient()` wraps Peer Cash with `withSpreadOrders`
    (`src/peer/sell/spreadOrders.ts`). Its `orders()`, `order()`, `watch()`,
    `prepareWithdraw()` and `prepareTopUp()` also cover deposits whose
    payouts are all oracle-priced with a spread: they read the same indexer
    rows with Peer Cash's `derivePayouts` and `deriveCashOrder` and build the
    same attributed calls. Zero-spread orders still go through Peer Cash
    itself.
  - The Sell form ("Price per USDC", Grand Exchange style) shows the
    seller's rate in the value box with -0.1% and +0.1% buttons and "..." for
    a typed spread, and under it the market (oracle) rate as the guide price
    with the spread beside it. Rates show to about five significant figures
    (`preciseRate`: 0.7554 GBP, 7.1234 CNY, 84.123 INR) so every 0.1% step
    visibly moves them; payouts show to the cent. The review and listed
    screens state the spread, the effective rate and the estimated payout.
    The bank's order details show the order's pricing as "Market rate
    +1.00%".
  - Switch: `SELL_SPREAD_ENABLED` in `src/peer/sell/spreadRate.ts`. False
    hides the control and lists every order at 0% (`docs/runbook.md`);
    spread orders already listed stay readable, withdrawable and
    top-up-able, because `getCashClient()` always wraps Peer Cash with
    `withSpreadOrders`.
- **Default currency**: a new leg picks the player's regional currency when
  it is a major one (`preferredCurrency` and `REGION_CURRENCY` in
  `src/peer/sell/cash.ts`), otherwise USD, then EUR, then GBP, whichever the
  platform offers.

### Registrations

What has to exist with Peer before money moves. Buyers register nothing with
Curator or the extension.

| Side | What | Platforms | When |
|---|---|---|---|
| Seller | Curator `makers/create`: the payee record the deposit's hashed payee id points at | every leg | At the payee check, then again at listing, inside Peer Cash's `prepare()` (or `prepareCashDepositParams` for a spread order), which maps errors to `PAYEE_VERIFICATION_REQUIRED` and `PAYEE_REGISTRATION_FAILED`. |
| Seller | Live payee check | Venmo, Cash App, Revolut, Monzo: Curator looks the account up ("Handle found"). Zelle, Chime, UPI, X Money: any well-formed handle is accepted, so it is unconfirmed (yellow warning). | As the handle is typed. |
| Seller | PeerAuth identity attestation (one time per handle, `register_<platform>`) | Wise and PayPal (PeerAuth 0.6.3+), Alipay (0.6.7+) | When Curator answers "identityAttestation is required" for a handle it hasn't seen. |
| Seller | PeerAuth seller credential (one time) | Cash App (PeerAuth 0.6.4+) | When Curator doesn't know the $Cashtag. |
| Seller | Enrolment confirmation | Zelle | A checkbox with Peer web's `PayeeEnrollmentConfirmation` text adapted to email or phone ("I have enrolled this email address or phone number with Zelle and can receive payments at it"), bound to the exact normalised handle; editing the handle clears it. Never sent to Curator. |
| Seller | Single-order rule (Peer's `calculateSingleOrderLimits`, `src/peer/sell/singleOrder.ts`) | Alipay | Deposit at least 10 USDC. The intent range is max = the amount, min = the amount minus 1 USDC, passed to Peer Cash's `prepare()` as `intentAmountRange`, so the deposit fills in one order. The seller is warned that Alipay risk control (风控) can block an account that several buyers pay in one day: create no more than 3 a day. |
| Seller | Peer Pay access policy | Venmo and PayPal legs | One transaction after the deposit (`prepareAccessPolicy`). |
| Buyer | PeerAuth minimum version | per platform (Buying table) | Before verifying. |
| Buyer | Alipay PID read (`GET /v2/makers/alipay/{hash}`, read-only) | Alipay | Before signalling; no PID, no order. |
| Buyer | UPI notice | UPI | Before ordering; doesn't block. |

When a leg's handle needs one of the one-time PeerAuth registrations and the
extension isn't installed, the leg offers the install there and then, as
Peer web does (`SarIntroModal` in install mode,
`useHeadlessExtensionRegistration`'s "Install PeerAuth"). "Install Peer
extension" opens the Chrome Web Store (`openExtensionInstallPage` in
`src/peer/extension.ts`) and "I've installed it" checks again. After the
store opens, the flow also checks when the window regains focus and every
2 s for up to 10 minutes, and offers registration as soon as PeerAuth is
found. If it still isn't found, the player reloads the page. On a phone, or
a browser that can't install it (`canInstallPeerExtension` false), the leg
says registration needs Chrome or Brave on a computer and links to Peer's
web app to register the handle once there instead.

Seller Automated Release ("Autopilot") connections are not offered. Peer
Express doesn't require them.

### Deferred, and why

- **A stake gate for Venmo and PayPal buying.** Peer Pay deposits need a
  buyer stake at least the order's size in StakeVault. A player buying their
  first USDC has none, Curator's admission of a staked taker can't be
  fork-tested, and it breaks the "no taker stake" rule. The picker explains
  the empty rows instead.
- **Zelle Capital One.** It adds no currency. It needs SDK 0.14.8 and an
  email proof (a Gmail OAuth client for this origin, or an `.eml` upload)
  with no PeerAuth capture. It also couldn't be tested end to end with a real
  Capital One email before launch, and a broken proof strands the buyer's
  fiat. The SDK stays on 0.14.7, whose catalogue matches 0.14.8's.
- **Revolut business payees' no-QR policy.** It adds no currency.
- **ARS (Mercado Pago).** There's no buyer verifier, and Peer web offers it
  on neither side.

## Chat and world messages

- Public chat: overhead yellow text for 5 s with the effects (wave, scroll,
  shake, colours); chatbox shows "Name: message" in blue.
- Game messages in black in the chatbox, e.g. "Welcome to RampRidge.",
  "Trades only settle through the bank. Never send money to a player
  directly.", "Your offer has been placed.".
- World events (verified on-chain) in the chatbox as "News:" lines in the
  original broadcast style, in every world, and as a firework on the player
  when they are in the same world.
- Merchant NPCs (up to 8, 6 on a phone) shout their price only: "Selling
  USDC @ 0.7554 GBP on Revolut!", and on a phone the short "0.7554 GBP
  Revolut!". The price is Curator's quote for an order of about 100 USDC
  (kept inside the best offer's limits), rounded in the buyer's disfavour, and
  the merchant's trade window opens at that amount, so it never shows worse
  than the shout. Shouts never show the size of the book: that is not what a
  buyer gets at that price. Wave effects in varying colours. Shouts are
  staggered so no more than three are up at once and a new one starts about
  every 2 s across the hall; a phone or portrait view shows at most two at
  once, those nearest the middle of the view.
- After a verified trade, the merchant nearest the trader (and a second
  within 6 tiles) says "gz!" or "Nice trade!" overhead. Local to each
  client; nothing is sent. Reduced motion skips it, like the fireworks.

## Sound

Original sound effects where available from the cache (bank open, coins,
level up, click); a quiet ambient track or none. Sound on by default after
the first click (browser autoplay rules), toggle in Settings.

## States every flow must render

Loading, empty (no orders, no liquidity for a method), error (plain-English
cause and the next action), success, disabled (no wallet: "Log in to trade"),
expired or cancelled orders, extension missing, insufficient USDC, external
wallet with no gas, a send whose outcome is not known yet.

## Accessibility and robustness

- The page opts out of browser translation (`translate="no"` and Google's
  `notranslate`). Chrome's translator swaps the text nodes React renders for
  its own, and React then crashes the first time it removes one: on the
  payment scroll that is the rules tick, right after an order is placed.
  Another language would need its own strings in the app, not the browser's.

- All interfaces work with keyboard (Esc closes, Enter confirms, Tab moves).
  An irreversible confirm (Send's review) answers only to its own button.
- Focus rings visible on interface buttons.
- Respect prefers-reduced-motion for chat motion effects and fireworks.
- Never block the world on network errors; show a game message and retry.
