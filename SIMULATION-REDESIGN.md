# Simulation redesign: scripted, arbitrage-driven sessions

Status: **design only, nothing here is built yet.** This replaces the current simulation (same interface: step-by-step and timed modes, the board, the position panel) with sessions that follow a story and a ladder of puzzles. The drills are unchanged.

Small changes already made and not part of the redesign: the order-book view is **off by default**, and **Pull** removes only the level you pull.

## 1. What makes a session interesting

Taken from a hand-written example session.

1. **Every decision has one exact right answer, worked out from the screen.** The right market is the tightest one where every fill can be hedged at a profit against what is showing. The skill is finding the replicating package, not estimating vol.
2. **Relationships get harder each step:** a put from a call and the future (1:1), a put from a straddle and the future (2:1, so bigger size), a box, a strangle priced through a box, a butterfly.
3. **Customers create the chances and the user has to notice them:** a bid crossing fair, a lifted offer leaving a one-sided market, a bid creeping up so an arbitrage appears. The user either asks "what can I improve now?" or it is a missed opportunity.
4. **The story decides which way customers trade.** If vol is going up, customers buy puts, bid straddles and lift offers. Prices drift with the story; they don't jump.
5. **A mistake teaches rather than just costing points.** The user is picked off, must flatten, sees the loss, and gets another go.
6. **A missed opportunity gets a bigger hint if it comes round again,** and is marked down in the feedback.

### Counterparties

Not one customer, but several kinds: **informed** parties (trade with the story), **uninformed** parties (random), and **market makers** (pick off mispricings, and trade against the user to flatten their own positions).

## 2. Session setup

- **Story:** pick at most **two** of: the underlying moves, vol moves, skew changes. At most **one turning point** per session (e.g. futures up then flat, never up then down then up).
  - Vol up with no skew story: the whole surface rises.
  - A skew story: vol changes spread through the strikes to fit it. A skew-only story leaves at-the-money vol unchanged.
- **Constraint (constant for the whole session):** either the user must make markets where they can **scratch** out, or they must have an **arbitrage** on the board. The first version uses the arbitrage rule.
- **Opening board:** the future plus about four markets, possibly with an early mispricing the user should trade away; the markets retreat when they do.
- **Example numbers (from the script):** tick 0.01; future 96.99 / 97.01, 10,000 up, held constant; strikes 92, 94, 96, 98, 100; vol varies by strike with put skew; standard size 500 lots; opening markets e.g. 96 calls 5.87 / 5.93, 98 straddles 9.90 / 10.10 in 1,000, 92/94 call spread 1.54 / 1.56, 94 puts 4.36 / 4.40. Sensible widths: 0.04 on 500 options, 0.2 on straddles, 0.02 on verticals and the future.
- **Max market width:** 0.3 at a 0.01 tick, scaling to **1.5 at 0.05** and **3 at 0.10**.
- **Sessions are generated**, not hand-written: step templates build their prices backwards from the intended answer so the perfect market comes out as clean numbers.

## 3. Pace and difficulty

- **Step by step:** a 5-step session climbs the ladder at the example's pace.
- **Longer sessions:** climb at half that pace up to step 10, then **reset**: a batch of new markets in some instruments, let the user pick off any trades, treat the new markets as the foundation and start again from the beginning difficulty.
- **Timed:** measured in **steps per minute**, default 0.5 (a 10-minute session is 5 steps). The first step comes immediately; later steps about every 2 minutes ± 10 seconds.

## 4. The standard pattern

For a requested market (the first step, and any later one with a counterparty who wants to trade it):

1. Ask for a market in the instrument.
2. If the bid is at or below the best bid, or the offer at or above the best offer (tighter is possible), ask once more for a tighter one.
3. If they reach the best market on the **first try, trade with them** ("standard pattern with instant reward"): a customer trades in the story's direction and the user completes the other legs of the arbitrage.
4. **Second try:** ask again; trade only if they reach the best market on the first or second try. After a **third** miss, stop asking.
5. If the market is valid but wrong, a customer trades the mistake, the order is refreshed in the same size, and if the user trades it again it comes back at **5×** the size. Then the user must flatten, with the payoff chart **hidden**, and then says how much they lost (points per lot). The chart is shown afterwards. The original markets are then refreshed (same price, same size) and the user gets another chance to make the market, without being traded with.
6. If the customer can't trade against the user's wrong side (it's the wrong way for the story), another customer trades it, and the user flattens and gives the loss.
7. A **very wide** market (more than 5 ticks per lot per arbitrage): don't trade with them, even if we would have, and say so in the feedback.

Rules that apply everywhere:

- Hedges must be **integer lots**: a reversal from calls, straddles and futures is buy 2 calls, sell 1 straddle, sell 1 future.
- **Flat** means no difference in payoff at expiry.
- **Any strictly positive profit** counts as an arbitrage.
- Trading is done by clicking **Mine / Yours** on the board with the size dropdown.
- A client request for a size larger than the user's usual (e.g. 2,000 where they would show 500) is encouraged, and quoting the standard size is a missed opportunity.
- **The size a user may show scales with the square of the width**: half the width, a quarter of the size. A 0.1-wide market that gives an arbitrage on 500 lots means 0.2 wide is fine when asked for 2,000 lots two-way.
- **Off-script trades:** the user may insert orders freely and they are never rewarded with a trade. If something is mispriced a customer picks it off and re-inserts at the level they traded, same size. If the user takes a market off script, it is refreshed and the user must flatten; a profitable flatten is rewarded, and one they can't flatten is wrong.
- **"Refresh"** with nothing else said means same price, same size.
- **Pushing:** only push the user on the first market, or where a counterparty wants to trade that instrument.

## 5. The worked example (five steps)

Vol goes up; futures flat. Customers buy puts.

1. **96 puts, arbitrage required.** Best market 4.85 / 4.95. The user buys a call and sells a future to flatten against the call market. The customer buys puts from the user.
2. **98 puts, standard pattern.** Customer wants 2,000 (1,000 straddles + 1,000 futures flatten it). The best market is 5.44 / 5.56. Instead of being traded with, the customer bids 5.53, crossing the user's fair. Then ask for any markets to improve: the user should bid the straddle up to 10.04 (10.00 to 10.04 gets the trade, then flatten). Any other improvement is a missed opportunity. The customer then lifts the 5.56s and rests a 5.56 bid for 2,000, so there is no offer. The user flattens, the straddle offer comes back at **10.2** in 1,000, and the user may try to improve the straddle bid (to 10.10 at most) without being given the trade.
3. **92 puts.** Customer makes 3.90 / 4.04 in 500; the user can't trade without giving up edge. The customer bids 3.96; the user should bid the 94 puts up to 4.39 (any improvement in 4.37 to 4.39 gets the trade), then buy the 94 put, sell the 92 put and buy the 92/94 call spread: a box bought for less than 2. If they don't, bid 3.98 and ask again; no response is a miss. The call spread offer refreshes (same price, same size). Then the standard pattern for the 92/94 put spread: the best market is 0.43 / 0.47, flattened with the box.
4. **98/100 call spread 1.19 / 1.23; 96 calls refreshed to 5.92 / 5.98.** Ask for a market in the 96/100 strangle. Fair 4.58 for the 98 call (from a 5.56 put bid and 10.2 straddle offer), 100 calls 3.37, 96 puts 4.95, strangle 8.32. Best market **8.24 / 8.40**. The hardest step. The customer buys it. No hints.
5. **96/98/100 call butterfly,** fair 0.16. The customer *offers* the fly at a price where tightening another market (the 98 puts or the 96 calls) gives the user an arbitrage against it. The best market, if only profitable flattening counts: 0.08 / 0.25.

Beyond step 5 (not part of the first version): massive orders in the inter-dealer broker (IDB), more spreads, updated call and put markets, and new markets in new instruments.

## 6. Scoring

- **Scored only at the end.** During the session the user sees they are losing money, or is prompted to improve.
- The end-of-session review has a **summary per node**: the best decision, whether they made it, missed opportunities, anything wrong.
- The score is a percentage: **full marks** for something done perfectly on the first try, **half** on the second, **zero** after that. Everything is scored, including "no trade was right".
- The existing 0–10 review is replaced.

## 7. Deferred: the IDB / "scratch" mode

Without an arbitrage constraint, the user must adjust their fairs after being traded with (bought call spreads → sell call spreads synthetically or on screen; sold straddles → buy calls) and edge requirements come from the instrument's fair value, hedging cost and volatility. Size scales with the square of the width. This is much harder to specify, and **will be done after the arbitrage version**, by questioning the author to build the rulebook rather than guessing.

## 8. Clarifications already given

| Topic | Answer |
|---|---|
| Straddle-bid reward band (step 2) | The floor is 10.00, the old fair. A 9.99 bid also makes money (11.06 − 9.99 − 1.01 = +0.06 per straddle), but nobody would sell to the user there. Open: what sets the floor in general, since step 3 accepts 4.37 to 4.39 (below the 4.38 mid). |
| Step 3 reward band | Anything from 4.37 to 4.39. |
| Step 2 straddle offer | **10.2** (the script said 10.28 in one place, that was a mistake). |
| Last straddle-bid improvement in step 2 | Scored, but not pushed. |
| P&L question | Points per lot. |

## 9. Open questions

1. **Reward floor:** how is the lowest rewarded price decided in general (see section 8)?
2. **P&L tolerance:** with 2:1 hedges, losses come in half ticks. Is exactly the true loss required, or are neighbours (such as 0.005 off) accepted? Is "per lot" always per lot of the instrument quoted, even when the hedge is in straddles?
3. **Request size:** does the customer's request show a size (e.g. "98 puts, 2,000"), or does the user choose it, with a nudge toward the hedgeable size?
4. **Size per side:** can the user quote each side's size separately, and is the "correct size" judged per side?
5. **Showing too much:** if the user shows more than they can hedge and is filled, is that a mistake, with them flattening what they can and holding the rest?
6. **Scratch mode:** is it just the arbitrage rule with zero profit allowed (step 1 would then be 4.86 / 4.94), and is it distinct from the IDB mode in section 7?
7. **Ramp for 5 to 10 steps:** is "ramp across all the steps if there are 10 or fewer, reset every 10 after that" right for, say, 7 steps?
8. **The reset:** do the new markets replace the old board, or get added to it?
9. **Prompts in timed mode:** if the user is mid-prompt (flattening, a P&L question) when the next step is due, does the clock pause, or does the step wait?
10. **Tick size:** at 0.05 or 0.10 should every price scale up 5× or 10× so the puzzles look the same, or keep the future near 97 and make the markets coarser?
11. **Instruments:** should generated sessions also use risk reversals, combos and boxes, and can butterflies and strangles sit in the existing spread book?
12. **Story variants:** when skew widens, do puts rise while calls fall, or do puts rise more than calls?
