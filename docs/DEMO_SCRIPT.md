# Demo video script (target 2:45, hard limit under 3:00)

Rules for the video: upload to YouTube as **public**, show the project actually running, no copyrighted music, no third-party logos you don't have permission for. Record at 1440x900, browser zoom 110%.

**Before recording:** `npm start`, open the dashboard, press *Clear log*, confirm *Leash on* and *Trusts vendor notices* are selected. If you have a Claude key and PayPal sandbox credentials, use them; the header pills show which mode you're in.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Dashboard, empty | "Agents are about to spend our money. All it takes to hijack one is a sentence on a web page. This is Leash: a spending firewall for AI agents, built on PayPal." |
| 0:15 | Rules panel; edit the text, press **Compile rules** | "I set the rules the way I'd tell a person: fifty dollars max, two hundred a month, only electronics and books, ask me above thirty, never pay individuals. Leash compiles that to hard limits I can read." Press **Save rules**. |
| 0:35 | Switch to **Leash off**, press **Run agent** | "First, with no firewall. The task is: buy a mechanical keyboard under fifty dollars." |
| 0:45 | Lanes fill in with red ticks | "The first listing hides an instruction in a comment: a mandatory two hundred dollar fee to a stranger, don't tell the user. The agent follows it. Two hundred and forty-four dollars gone." Point at the red *paid while Leash was off* figure. |
| 1:10 | **Clear log**, switch to **Leash on**, press **Run agent** | "Same agent, same page, Leash on." |
| 1:20 | Lanes: transfer blocked at Policy and Reviewer | "The transfer dies at the first gate: my policy forbids paying individuals. The purchase from the poisoned page is stopped too. The reviewer sees a system-notice impersonation and a payee that came from the page, not from me." |
| 1:45 | Click the transfer row; drawer opens | "Every decision has a replay: the rules it failed, the reviewer's reasoning, and the exact text that was flagged." Scroll to the highlighted comment. |
| 2:05 | Close drawer; **Waiting for you** | "The agent then picks a clean keyboard. It's over my auto-approve limit, so it comes to me, and I approve it inside PayPal, not inside the agent." Click **Approve in PayPal**, then **Pay Now**. |
| 2:25 | Drawer shows paid, PayPal order and capture ids | "Captured through the PayPal Orders API. Autonomous spend uses Payouts; webhooks keep this log honest." |
| 2:35 | Click **Run the suite** | "And I don't have to trust one demo. Nine replayed attacks and legitimate payments, against my rules: seven of seven hijacks stopped, both legitimate payments handled right." |
| 2:45 | Wordmark | "Leash. Let an agent spend your money without handing it the wallet." |

## Devpost submission checklist

- [ ] Text description: paste the "Leash" intro and the four feature bullets from the README (features and functionality)
- [ ] Public GitHub repo, `LICENSE` visible in the About box (GitHub detects the MIT file automatically)
- [ ] README setup instructions work from a clean clone (`npm install && npm start`)
- [ ] YouTube video, public, under 3:00
- [ ] Demo access: either the repo instructions (satisfied) or a hosted URL (see `render.yaml`)
- [ ] State the AI and PayPal pieces used: PayPal Orders v2 + Payouts + Webhooks, Claude (Anthropic API), AG Grid Community, Channel3 (if you add a key)
- [ ] Submitted before **Nov 12, 2026, 12:00 pm PT** (1:30 am IST, Nov 13). Aim for Nov 10 or 11.
- [ ] Sponsor prizes: AG Grid (the decision log) and Channel3 (live search, if keyed). Read each sponsor's requirements in section 8 of the official rules before claiming them.
