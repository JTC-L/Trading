# Options Market-Making Sim

A single-player options market-making practice tool. No backend, no build step — plain HTML/CSS/JS.

## Running it

Easiest: double-click `index.html` to open it in your browser.

If your browser blocks local scripts from loading (some do), serve the folder instead:

```bash
python -m http.server 8000
```

then open `http://localhost:8000`.

## Layout

- **Stock** (top middle) and **R/C** (top right, fixed reversal/conversion carry — never changes) sit above the board.
- Main row, left to right: **P+S** (put + stock combo) | *call spreads* | **Calls** | **Strikes** (with call delta beneath each) | **Puts** | *put spreads* | **B/W** (stock − call).
- **Spread Book** and **IDB** sit below the board.
- **Position** panel (right side, if enabled) shows a payoff-at-expiration chart and total Greeks for whatever you've traded.

## How it works

- Black prices are indicative (reference marks, not tradeable). Blue prices are live and tradeable via **Mine** (buy the offer) / **Yours** (sell the bid).
- Cells periodically get "asked for a market" — type a bid, ask, and a whole-number size, then **Set market**. A simulated customer will then decide whether to trade on it (some are informed, some are noise).
- An **IDB** request freezes the Mine/Yours buttons on the board until you've quoted it and the simulated counterparty has responded — board RFQs (the ones on the board/spread book) never freeze anything.
- Fair values are computed with Black-Scholes off a fixed 30-day-to-expiration assumption; only the stock price and/or volatility drift during the session (per a randomly generated theme, at most one turning point per 3 minutes), depending on which certainty toggle (if any) is on.
- All displayed prices round to the nearest $0.05.

## Config

Spreads on/off, spread book on/off, IDB on/off, show position on/off, trade pace (5–120s), simulation length (5–20 min), difficulty (controls how much of the board starts filled: ~10/25/50%), and certainty mode (neither / high stock certainty / high vol certainty — mutually exclusive).
