# Mock Options Trading Games

Options market-making practice: a live **Simulation** and a put-call-parity **Drill**. No backend, no build step — plain HTML/CSS/JS.

## Running it

Easiest: double-click `index.html` to open it in your browser.

If your browser blocks local scripts from loading (some do), serve the folder instead:

```bash
python -m http.server 8000
```

then open `http://localhost:8000`.

## Delta-1 instrument

Both modes let you choose the **Future** (default) or the **Stock** as the delta-1 instrument.

- **Future:** no r/c, no buy-writes, no puts+stock, no combos. Options are priced undiscounted, so `C − P = F − K` exactly. The board is *Future* on top, then **Calls | Strikes | Puts | Straddles**.
- **Stock:** as before — r/c, **P+S | Calls | Strikes | Puts | B/W**, straddles and combos in the spread book.

## Simulation

- **1–5 strikes** (default 2). Call/put verticals sit in the gutters beside the calls and puts. The spread book (and IDB) also trade strangles, risk reversals, wide verticals, **butterflies** (3+ strikes) and **condors** (4+ strikes).
- **Order-book view** (toggle in config): the future/stock, calls, puts, straddles (and P+S / B/W) are drawn exactly like the drills' books — offers stacked on the right of a thick centre divider, bids on the left, a size bar growing out from the divider, square **Yours** / **Mine** buttons — with 2 levels a side and an empty level in the middle. Press **Mine** / **Yours** on the best price to take it (a ticket asks how many). To quote, type a price into the empty middle level's bid or offer box (at the best price or better), press Enter, then choose a size. A new best price rolls its own side's levels (bids roll down, offers roll up) and the lowest level drops off; trades and size changes don't animate.
- Anything without a full book (the call/put verticals and the spread book) shows just its top prices, `(x100) 10.50 - 10.60 (x150)`, with Yours / Mine underneath.
- The timer sits in the middle of the top bar, as in the drills.
- **A session has two phases.**
  - **Setup (clock paused):** a few opening markets are already trading, so you have anchors. With the **delta-1 fixed** (or neither fixed) that's the future/stock, the vertical spreads and one option/straddle (the ATM straddle, or the ATM call in stock mode). With **vol fixed** it's the ATM straddle and the verticals. You then make a market in every other box of the main board, **one request at a time** — each gets a big red border until you've made it — working out from the money so each can be worked out from what's already there (e.g. the ATM call and put from the future and the straddle, then each neighbouring strike from the verticals). No customers trade until the board is complete, and the clock (and so every fair value) holds still until then. IDB requests join the queue later, in the flow phase.
  - **Flow (clock running):** the customers arrive. They share a hidden **theme** — with a fixed delta-1 it's a view on vol (rising or falling vol, and the vol path really does move that way); with fixed vol it's a view on the market (rising or falling). They take liquidity in that direction (long-vol buyers lift offers in calls, puts, straddles and strangles — about 70% of the time taking the whole best price, otherwise part of it; a bullish crowd buys calls, call spreads and risk reversals and sells puts) — at prices that are sensible, so a market far off fair doesn't get hit — and after a trade they often put in more orders in similar markets (the neighbouring strikes, or the same strike's other options), leaning the same way. The theme is revealed when the session ends.
- **Customers never pull** their own prices. Prices only leave the book by trading (or by being pushed past the visible levels). When a side is traded out it either settles to an indicative mark at the traded price or is asked of you again. Now and then a customer improves a price in size, sometimes against what parity says other markets are worth, so look for trades you can take.
- **Flow panel:** a log of everything that happens — red = a trade with you, yellow = a trade between others, blue = you took a price, green = a customer improved or posted a price. The panel and the market involved flash a coloured border for 3 seconds.
- **Position panel:** P&L at expiration (blue) and P&L if marked at today's Black-Scholes value (orange), plus total Greeks. The chart is centred on the strikes and reaches only 10 beyond the outermost ones on each side. Every trade — including customers trading against markets you made — is tracked.

## Drill

- **Order book view** (default) — a banner (score, timer), the question type centred beneath it, then a bold header per instrument ("95 Call") over a 3-level order book: offers stacked on the right of a thick centre divider (worst on top), bids on the left (best on top). Every level shows its size, e.g. `(x50)`, and a bar growing out from the divider in proportion to it (full at double the typical size: 200 for options and the underlying, 100 for straddles). **Yours** (sell the bid) and **Mine** (buy the offer) sit next to the divider on every level. Three types, in random order (on the drill config screen, *Arbitrage* and *Take liquidity* can each be switched off; *Make a market* is always on — in the single-price view there are no books to trade against, so the only question is working out a price):
  - *Make a Market*: only two other instruments' books are shown — enough to work the answer out — and the third is blank. Enter a two-way market: 1 point if the midpoint of the best market the shown books allow is inside yours (at most 1.00 wide), 2 if you have exactly the right bid and offer (an option's best bid is never below 0, since you'd always buy one for nothing).
  - *Arbitrage Opportunity*: tick the best prices that make an arbitrage and press **Make Trades**, or press **No Arbitrage**. 1 point for any arbitrage, 2 for the best one (or for correctly spotting there is none).
  - *Take Liquidity*: some best prices are off fair value (a stray quote in front of an otherwise normal book) — take those only; trading anything else gives the edge away, and you stay on the question. Strays are only somewhat smaller than normal quotes, so size helps but isn't a giveaway (about half the single-leg questions can only be solved from prices). About 10% of questions have **nothing** worth taking (press *Nothing to Take*). About half come with a **print** in a blue box above the books — e.g. "Customer bought 1000 of the 120 Call for 1.80" — priced inside that instrument's market. Size is how much to believe it: about 75% of the time the clip is **massive** (5-10x a typical quote), so its price is that instrument's fair value and settles ties between ways of lining the books up; about 25% of the time it's only about the size of the books, so it's noise to be discounted — and it can point the wrong way. 1 point for a right leg, 2 for all the right legs (or for correctly calling nothing). A selection that
    is a best price that is one leg of a **riskless package** in the books (e.g. the straddle bid, when the call and
    put offers cost less) also scores 1 — it can be hedged for a locked-in profit, even though it isn't the best
    trade (which builds a bigger position, with more edge but more risk).
  - You always take a price's entire size, and each price is independent. Only best prices count toward an arbitrage or a right leg; deeper levels are depth, and ticking one is wrong. Wrong answers clear your picks and keep the question.
- **Single price view:** one price is missing — work it out and type it.

All prices are on a $0.05 tick.
