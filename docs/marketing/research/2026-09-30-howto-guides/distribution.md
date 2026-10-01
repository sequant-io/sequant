# Sequant distribution research (2026-09-30)

Scope: where Claude Code / agentic-coding users congregate, comparables and how they got traction, handle availability, current listings, and a 30-day plan. These strategy decisions were taken as fixed and not relitigated: research-led content, no cadence promise, site = archive + cross-post, HN/PH held until demo GIF + 3 findings + vouching users, milestone = 10 humans who ran it twice. Nothing was registered, posted, or submitted.

---

## 0. Headline findings (read these first)

1. **The 2026-08-30 directory submission is probably stranded, not slow.** Around 2026-09-28 Anthropic moved plugin submission to a developer portal at `claude.ai/directory/manage`. The docs say "The earlier Claude Console form for plugin submissions is no longer supported." Submissions made through that form must be moved:
   - Open **platform.claude.com/plugins/submissions**.
   - If the submission has a **Withdraw** button, withdraw it, then resubmit from a claude.ai account at claude.ai/directory/manage.
   - If it has no Withdraw button, email **directory@anthropic.com** and ask for it to be moved. Until then the portal can refuse the new submission with "Already submitted by another organization".
   - Supporting evidence: the public mirror `anthropics/claude-plugins-community` was last pushed **2026-08-25**, five days *before* sequant's submission, so nothing submitted after that date could have appeared there. Another author's form submission sat in "pending review" for over five weeks with no reply (issue #1716).
   - Sources: https://claude.com/docs/directory/publish (section "Move an earlier submission to the developer portal"), https://code.claude.com/docs/en/plugins/publish, https://mixed-news.com/en/anthropic-claude-directory-plugin-submission-portal-safety-scan/ (dated 2026-09-28), https://github.com/anthropics/claude-plugins-community/issues/1716
2. **A directory listing does not bring traction by itself.** Two listed community plugins are direct "GitHub issue → PR" competitors: `dev-squad` (briannaworkman/dev-squad-plugin, **0 stars**) and `forgeproof` (ryanjmichie-git/forgeproof-plugin, **2 stars**). The community marketplace holds **2,282 plugins**, many of them pipeline or spec-driven-development kits. Getting listed is basic hygiene and makes install easier. It is not a growth channel.
3. **The comparable tools that took off did it with a narrative post on their own site, which then got amplified.** Your research-led strategy is the right fit.
   - superpowers: Jesse Vincent's blog post "How I'm using coding agents in October 2025" → Simon Willison wrote about it the next day → Hacker News front page (435 points, 231 comments) → Simon posted it on X.
   - ccpm, the closest comparable (GitHub Issues + worktrees): a problem→solution blog post plus a Show HN the same day (175 points, 112 comments).
   - **Warning from the ccpm thread:** commenters called the README numbers ("89% less context switching", "3x faster") LLM-hallucinated, and that damaged trust. See section 5, gate G0.
4. **Sequant is not listed anywhere I could check** (section 4). The only outside mentions are automated scrapers and digests.

---

## 1. Where the audience is

Effort: S = under 1 h, M = half a day, L = needs a new content piece.

| Channel | Size / signal | Audience fit | Self-promo rules (what I could verify) | Effort | Format that works |
|---|---|---|---|---|---|
| **r/ClaudeCode** | ~428k members, +1,234% in a year (GummySearch, data as of 2026-10-01) | Highest: people building with Claude Code, frequent "Tips & Workflows" posts | **Undetermined.** Reddit blocked WebFetch, old.reddit JSON, a redlib mirror and the browser tool. A "Showcase" flair exists (seen in a posting-skill README), and "Built with Claude" is the most common flair. Read the sidebar yourself before posting. | M | Text post with a finding, a repo link at the end, and a reply to every comment. Avoid link-only posts. |
| **r/ClaudeAI** | Official Anthropic community page lists it as the Reddit hub | High, but broader (chat users too) | **Undetermined** (same block). It has run "Built with Claude" contests whose posts required what you built, how, screenshots/demo, and a prompt. Expect a similar showcase structure. | M | "What I built + how + demo + what I learned" |
| r/ChatGPTCoding, r/vibecoding, r/AI_Agents | Not measured | Medium; vibecoding skews non-engineer | Undetermined | M | Cross-post only after the post has worked in r/ClaudeCode |
| **Claude Discord** (official) | 130k+ members; discord.com/invite/anthropic | Medium-high; includes a project-sharing area | Channel rules not visible without joining | S | Short showcase post linking the research post; answer questions |
| **Anthropic Project Showcase** form | Typeform linked from claude.com/community | Wide reach if featured on Claude's social channels; low odds | Official submission route | S | One paragraph + demo GIF. Needs the GIF first. |
| **Claude Community meetups** (Luma: luma.com/claudecommunity, 67 cities / 33 countries, run by ambassadors) | In-person | Very high for the "10 humans who ran it twice" goal: you meet people who can later vouch | Ask the organizer for a demo or lightning slot | M | 5-minute live demo: issue → PR |
| **hesreallyhim/awesome-claude-code** | 54.9k stars; pushed 2026-10-01 | High; this is *the* list. Relevant sections: "Agent Orchestration", "Dynamic Workflows" | **Web issue form only.** No PRs, and `gh` CLI submissions are not accepted. Eligible if the repo is 14+ days old with ongoing commits (sequant qualifies) **or** has 100+ stars. Recommendations "must be created by human beings", so **you** must fill in the form yourself, not an agent. One-line objective description, no addressing the reader, no emoji. No guaranteed response. | S | One factual line |
| jqueryscript/awesome-claude-code | 521 stars; pushed 2026-09-20; ~540 PRs | Medium. Its "Agents & Orchestration" section lists oh-my-claudecode, agent-orchestrator, etc. | Fork → PR | S | One line |
| ComposioHQ (composio-community)/awesome-claude-plugins | ~2.0k stars; last pushed 2026-07-26 (slowing) | Medium | Fork, add a plugin folder in the template structure, update README, PR. Must "address a real use case, not duplicate". | S–M | Template entry |
| buildwithclaude.com (davepoon/buildwithclaude) | 3.6k stars; active | Medium | Repo-based PR (check its CONTRIBUTING) | S | Entry |
| davila7/claude-code-templates (aitmpl.com) | 32k stars; active | Medium | PR | S | Entry |
| claudepluginhub.com, claudemarketplaces.com | Auto-indexers (claim ~31.7k marketplaces) | Low on their own | Listing seems to come from crawling `.claude-plugin/marketplace.json`; sequant's page currently 404s | S | Nothing to write |
| **Official MCP registry** (registry.modelcontextprotocol.io), Glama, Smithery, mcp.so | sequant has 0 results on the registry; Glama 404 | Low-medium. Sequant has an MCP server, so this is cheap extra surface. | Registry publishes via the `mcp-publisher` CLI with a namespace (e.g. `io.github.sequant-io/sequant`) | S–M | server.json metadata |
| **Simon Willison** (simonwillison.net, tags `claude-code`, `coding-agents`) | Biggest single amplifier in this niche (superpowers precedent) | Very high *if* the post is a real, measured finding | No submission route. He finds things through HN, Mastodon, Bluesky and blogs. Don't cold-pitch. Publish something worth linking. | L | Narrative + data + honest caveats |
| Hacker News (Show HN) | ccpm 175 pts; superpowers 435 pts | Very high | **On hold per your strategy.** Show HN must be something people can try without signup; blog posts don't count. The author must be in the thread. Asking for upvotes is banned. | L | Held |
| **console.dev** newsletter | Weekly, 2–3 devtools reviewed | Medium-high. Its criteria (built for developers, self-serve, good docs, part of the regular dev loop, security impact) favour a CLI. | Editorially selected, never sponsored. Submit through the site. | S | Docs quality decides it |
| **Node Weekly / JavaScript Weekly** (Cooperpress) | Large | Medium (npm CLI) | Free: reply to the newsletter or send a short paragraph + link | S | Short paragraph |
| Changelog News | Large dev audience | Medium | "Submit News" on changelog.com | S | Link + one-liner |
| Agentic Coding Weekly (agenticcodingweekly.com, @Agentic_Coding) | Unknown size | High | No submission form; contact via X | S | Research post link |
| AI Coding Daily (aicodingdaily.substack.com) | Covers spec-driven development | Medium-high | Unknown; reply or email | S | Research post link |
| dev.to `#claudecode` tag | Active. "I built X to stop that" posts and agent-failure stories do well (e.g. an agent changed `toBe(10)` to `toBe(9)` and called it done). | High for practitioner content | Cross-posting allowed; set the canonical URL to sequant.io | S per post | Cross-post the research post with canonical_url |
| Hashnode / Medium | Not measured | Low for a solo maintainer | Canonical URLs supported | S | Skip for now |
| X | Main amplification network for comparables (task-master: 250+ stars and 200k impressions on launch weekend) | High, but needs an active account | n/a | M ongoing | Thread: finding → screenshot → link |
| Bluesky | Simon Willison and many devtools people are active | Medium | n/a | S | Same as X, shorter |
| Mastodon | Jesse Vincent announced superpowers on Metasocial | Low-medium | n/a | S | Optional |
| **YouTube creators** | IndyDevDan (agentic engineering; 2M+ views; weekly on Mondays; Aider → Claude Code), Cole Medin (context engineering; his context-engineering-intro repo has 13.9k stars) | High fit for workflow tools. Nick Saraev and Nate Herk are bigger but business/automation-focused, so a weak fit. | Pitch only once a demo exists. These creators cover tools that make a visual story. | L | 3–5 min unedited screen recording, issue → PR |

Sources: https://gummysearch.com/r/ClaudeCode/ · https://claude.com/community · https://discord.com/invite/anthropic · https://raw.githubusercontent.com/hesreallyhim/awesome-claude-code/main/CONTRIBUTING.md · https://github.com/jqueryscript/awesome-claude-code · https://github.com/ComposioHQ/awesome-claude-plugins · https://buildwithclaude.com/ · https://www.aitmpl.com/plugins/ · https://www.claudepluginhub.com/marketplaces · https://claudemarketplaces.com/marketplaces · https://registry.modelcontextprotocol.io · https://console.dev/selection-criteria · https://nodeweekly.com/ · https://changelog.com/ · https://www.agenticcodingweekly.com/ · https://aicodingdaily.substack.com/p/claude-cowork-spec-driven-development · https://dev.to/t/claudecode · https://simonwillison.net/tags/jesse-vincent/ · https://news.ycombinator.com/newsfaq.html · https://syften.com/blog/hacker-news-marketing/ · https://thesearchsherpa.com/best-youtube-creators-claude-code-2026/ · https://agenticengineer.com/tactical-agentic-coding · https://claudelog.com/claude-reddit-contest/ · https://github.com/cskwork/reddit-skill

---

## 2. Comparables and how they got traction

Star counts are from the GitHub API on 2026-09-30.

| Tool | Stars | Created | What it is | How the first wave came (from launch reports; time-to-100 stars not measured, see note) |
|---|---|---|---|---|
| **automazeio/ccpm** | 8.4k | 2025-08-18 | GitHub Issues + worktrees + parallel agents. **Closest analogue.** | Two days after creation: a blog post ("How we fixed the context problem…", problem→solution narrative ending with a `git clone` call to action) **plus a Show HN the same day**: 175 pts, 112 comments. Critiques: LLM-written README metrics, "waterfall", "unsupervised agents go haywire". The OP promised demo videos. |
| **obra/superpowers** | 293k | 2025-10-09 | Skills framework / method | Personal blog post → Simon Willison wrote it up the next day → HN 435 pts → Simon's X post. A credible practitioner voice and a "how I work" narrative. |
| **eyaltoledano/claude-task-master** | 28k | 2025-03-04 | PRD → tasks for Cursor / Claude Code | X launch thread: 250+ stars, 200k impressions and 4.5k bookmarks on the first weekend. Later #1 GitHub repo of the day. Big readme plus "how to get started" threads. |
| gsd-build/get-shit-done | 64k | 2025-12-14 | Meta-prompting / spec-driven, clean context per phase (plan/execute/review, close to sequant's model) | `npx` one-line install. Spread through X/Reddit and secondary blog coverage (MindStudio, GeekNews). Launch specifics not found. |
| github/spec-kit | 140k | 2025-08-21 | Spec-driven-development toolkit | GitHub's own distribution; not comparable for a solo project |
| Fission-AI/OpenSpec | 71k | 2025-08 | Spec-driven development | Not researched in depth |
| Yeachan-Heo/oh-my-claudecode | 39k | 2026-01-09 | Multi-agent orchestration | Top of jqueryscript's orchestration list; launch not researched |
| Chachamaru127/claude-code-harness | 3.1k | 2025-12-12 | Plan → Work → Review loop | In the community marketplace; Japanese-language author, so likely Japan dev communities (unverified) |
| coleam00/context-engineering-intro | 13.9k | 2025-07-02 | Template + method | Author's own YouTube channel |
| SWE-agent | 20k | 2024 | Issue → fix (research) | Academic paper + benchmark (SWE-bench) |
| OpenHands | 90k | 2024 | Autonomous dev agent | Funded company, benchmarks, Discord/Slack community |
| Sweep | 7.7k | 2023 | Was an issue → PR bot; pivoted to a JetBrains assistant | A reminder that "issue → PR bot" alone did not hold a position |
| anthropics/claude-code-action | 9.3k | 2025-05 | `@claude` in an issue/PR → changes, in GitHub Actions | **The default answer to "issue → PR with Claude".** Sequant should position against it explicitly: local worktrees, spec and QA gates, a fresh-session reviewer, verified PRs. |
| GitHub Copilot coding agent, Devin, Codex cloud, Cursor background agents | n/a | n/a | Hosted issue → PR | Sequant's angle: local, open, inspectable gates. Not researched further. |
| dev-squad / forgeproof (community marketplace) | 0 / 2 | 2026-03 / 04 | Issue → PR plugins | Listed in the directory, no traction. Listing alone ≠ adoption. |

**Note on "first 100 stars":** GitHub's stargazers endpoint returned 404 for every repo I tried, so I could not measure days-to-100. The table relies on launch anecdotes (task-master's first weekend, ccpm's Show HN, superpowers' HN/Simon chain). Treat them as qualitative.

**The pattern across the winners:**
1. A practitioner's narrative post on their own site (the "how I work" / "how we fixed X" format), not a feature list.
2. One high-signal amplifier: Simon Willison, an HN front page, or a large X account.
3. An install of one or two lines (`npx …`, `/plugin install …`), right in the post.
4. Demo assets came *after* critics asked for them (ccpm promised videos). Having one at launch avoids the "show me" objection.
5. Hype numbers backfire on HN. Precise numbers with caveats are what Simon links to.

**How-to formats comparables publish:**
- Docs recipes / quickstarts: task-master's "fat readme" plus getting-started threads; GSD's one-line npx.
- "How I use agents in <month>" narrative posts (superpowers).
- Problem→solution posts with a workflow diagram (ccpm).
- YouTube walkthroughs, by the author (Cole Medin) or creators (IndyDevDan, Nick Saraev covering worktrees and agent teams).
- Short X threads with a screenshot or GIF per step (task-master).
- Benchmarks / papers (SWE-agent, OpenHands): heavy, but a research angle fits sequant's "research log".

Sources: https://news.ycombinator.com/item?id=44960594 · https://aroussi.com/post/ccpm-claude-code-project-management · https://blog.fsck.com/mentions/source/2025-10-09-superpowers-launch/ · https://simonwillison.net/tags/jesse-vincent/ · https://emelia.io/hub/claude-task-master-ai-project-management · https://x.com/ykxventures/status/2013042581920268661 · https://www.mindstudio.ai/blog/gsd-framework-claude-code-clean-context-phases · https://github.com/anthropics/claude-code-action · https://github.com/anthropics/claude-plugins-community (marketplace.json via GitHub API)

---

## 3. Handles

Checked without registering. Method: GitHub API, Bluesky public API (`getProfile`), mastodon.social lookup API, fxtwitter API for X, HTTP status for dev.to and YouTube (both calibrated against known-existing handles).

| Platform | `sequant` | `sequantdev` | `sequant_io` / `sequant-io` | `sequantio` | Recommendation |
|---|---|---|---|---|---|
| GitHub | **Taken**: "SeQuant Capital" org (2018, 6 trading-bot repos, inactive since 2020) | free | `sequant-io` = yours | free | Keep `sequant-io`. Done. |
| X | **Taken, dormant**: @SeQuant, joined 2009, 0 posts, 11 followers | free | `sequant_io` free | free | **Worth having:** `@sequant_io` (matches the domain and GitHub org). Getting @sequant through X's inactive-account process isn't worth the time. |
| Bluesky | `sequant.bsky.social` not found (likely free) | not found | not found | not found | **Worth having:** use the **domain handle `sequant.io`** (DNS TXT record; free and verifies itself). Better than any bsky.social name. |
| Mastodon (mastodon.social) | free | free | free | free | Noise for now. Optional, later. |
| YouTube | `@sequant` 404 (likely free) | free | free | free | **Worth claiming `@sequant`** only once the demo video exists. An unlisted upload can sit on a personal channel until then. |
| dev.to | `/sequant` 404 (free) | free | free | free | Worth it (cheap; cross-posts with canonical URL). An org page is possible later. |
| Reddit | **Undetermined** (Reddit blocked all automated access) | — | — | — | Post from your personal account. Reddit distrusts brand accounts. |
| Hashnode / Medium | **Undetermined** (single-page app returned 200 for everything; Medium returned 403) | — | — | — | Noise for a solo maintainer. Skip. |
| npm | `sequant` package = yours | — | — | — | Done |

Worth having: X `@sequant_io`, Bluesky `sequant.io`, dev.to `sequant`, later YouTube `@sequant`. Everything else is noise until there are users. Post as yourself (the maintainer) wherever possible. Comparables grew through personal accounts (Jesse Vincent, Eyal Toledano, aroussi), not brand accounts.

Sources: GitHub API `users/sequant`; https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile; https://mastodon.social/api/v1/accounts/lookup; https://api.fxtwitter.com/

---

## 4. Is sequant listed anywhere?

| Place | Listed? | How checked |
|---|---|---|
| anthropics/claude-plugins-official (315 plugins) | No | marketplace.json via GitHub API |
| anthropics/claude-plugins-community (2,282 plugins) | No (mirror frozen since 2026-08-25) | marketplace.json via GitHub API |
| claude.com/plugins (~340 shown) | No | WebFetch |
| hesreallyhim/awesome-claude-code | No | README grep |
| jqueryscript/awesome-claude-code | No | README grep |
| ComposioHQ/awesome-claude-plugins | No | README grep |
| davepoon/buildwithclaude | No (README); site search renders client-side, so inconclusive | README grep + curl |
| davila7/claude-code-templates | No | README grep |
| claudepluginhub.com | No (`/plugins/sequant-io-sequant` is a 404 page) | WebFetch |
| Official MCP registry | No (count 0) | API |
| Glama MCP | No (404) | curl |
| claudemarketplaces.com, Smithery, mcp.so | Not found / inconclusive (client-rendered) | curl |
| Other GitHub code mentions | Only automated: `linny006/mcp-servers-live` (scraped MCP page) and `rxmna8502/vybe-intelligence-vault` (daily auto-digests, dozens of `sequant.md` files from 2026-07 to 2026-10). This supports the bot/mirror theory for npm downloads. | `gh search code` |

---

## 5. The 5 highest-leverage moves for the next 30 days

**Gate G0, before any public amplification:** reconcile the fresh-session QA headline ("44% of second looks found a would-ship bug", in https://sequant.io/research/fresh-session-qa/) with the #1067 reconstruction. Project memory records that this number was never tabulated, that most catches were human follow-up, and that the headline is expected to shrink. The ccpm Show HN shows what happens next: a number that looks inflated gets called hallucinated, and the whole launch loses trust. A smaller, precise, well-caveated number is *more* linkable (Simon Willison links caveated measurements). Do this before moves 3–5. Moves 1–2 don't depend on it.

### Move 1: Rescue the directory submission (portal migration)
- **Why:** near-zero effort, and it explains the "uncatalogued" mystery. A listing reaches claude.ai, Cowork and Claude Code, gives install/usage numbers (useful for counting real humans), and updates automatically when you merge to the tracked branch.
- **First action:** open https://platform.claude.com/plugins/submissions → **Withdraw** if the button is there, otherwise email directory@anthropic.com asking to move it → run `claude plugin validate --strict` (the portal adds rules the CLI doesn't check) → resubmit at https://claude.ai/directory/manage from a paid claude.ai account. Needs the user (paid-plan login); I did not do it.
- **Content it needs:** the listing's description and README section. Keep it factual: "Takes a GitHub issue through spec → implement → QA in isolated worktrees and opens a PR". Also a short "What sequant adds over `@claude` in GitHub Actions" paragraph.
- **Expectation:** hygiene, not growth (dev-squad and forgeproof are listed with 0–2 stars).

### Move 2: Get onto the three lists people actually read
- **First action:** file the **hesreallyhim/awesome-claude-code** web issue form yourself (target section: "Agent Orchestration"; one-line objective description; human-written, as the list requires). The same week, open PRs to jqueryscript/awesome-claude-code (Agents & Orchestration), buildwithclaude and claude-code-templates. Publish the MCP server to the official MCP registry.
- **Content it needs:** one canonical one-liner, reused everywhere, e.g. "CLI and Claude Code plugin that takes a GitHub issue through spec, implementation and fresh-session QA in isolated git worktrees, then opens a PR." Plus a README "Quickstart in 3 commands" block at the top so visitors from the lists can try it.

### Move 3: The demo GIF + "Your first issue → PR in 10 minutes" recipe
- **Why:** it is the missing piece in every later channel (showcase form, Reddit, YouTube pitches, and eventually HN/PH). It also clears one of your three HN/PH preconditions. ccpm had to promise a demo after launch. Ship one before.
- **First action:** record one unedited run on a small public sample repo: `/plugin install` → `/fullsolve <issue>` → spec comment → worktree → QA verdict → PR. Cut a 20–40 s GIF for the README and the post. Keep the full 3–5 min recording for YouTube later.
- **Content it needs:** a docs recipe at `sequant.io/docs/guides/first-issue` (the site has quickstart / workflow / git-workflows / mcp-integrations guides, but no end-to-end walkthrough with real output). Show the actual spec comment, the QA verdict and the PR, and include a "what it costs / how long it takes" box with your measured numbers.

### Move 4: Cross-post the (reconciled) research finding where Claude Code users are
- **First action:** after G0, post a text post to **r/ClaudeCode** framed as a finding: "I recorded N agent transcripts; a fresh-session reviewer caught X% would-ship bugs; here's what de-anchoring costs". Repo and post link at the end. Check the subreddit's showcase/self-promo rules in the sidebar first, because I couldn't retrieve them. Same week: dev.to `#claudecode` cross-post with canonical URL → sequant.io, and a share in the Claude Discord project-sharing channel. Post from your personal account and reply to every comment. This is the main route to the "10 humans who ran it twice".
- **Content it needs:** the research post (reconciled) plus a short "try it on your repo" footer linking the Move 3 recipe. No cadence promise needed; each finding is a standalone post.

### Move 5: Seed two high-signal, low-volume channels with the same assets
- **First action:** (a) submit the demo GIF + post to the **Anthropic Project Showcase** form (https://form.typeform.com/to/VIUAjxNi); (b) send a 2-line note to **console.dev** (their criteria match: self-serve, docs, dev loop) and a paragraph to **Node Weekly** (reply to an issue); (c) ask a nearby **Claude Community meetup** organizer (luma.com/claudecommunity) for a 5-minute demo slot. In-person attendees who run it are the most likely "users who can vouch".
- **Content it needs:** the GIF (Move 3), the reconciled finding (Move 4), and a 5-minute live-demo script (the same run as the recording).
- **Deliberately not in the 30 days:** HN / Product Hunt (held per your strategy), YouTube creator pitches (after the full recording exists and at least one finding has landed), Medium / Hashnode / Mastodon (noise for now).

### Handles to claim alongside (10 minutes, no posting required)
X `@sequant_io`, Bluesky domain handle `sequant.io`, dev.to `sequant`. YouTube `@sequant` when the video exists.

---

## Not verified / limits
- Reddit subreddit rules and member counts (except GummySearch's r/ClaudeCode figure), plus Reddit handle availability: Reddit blocked every access path (WebFetch, old.reddit JSON, redlib mirror, browser tool).
- Days-to-100-stars for comparables: GitHub stargazers API returned 404, so only launch anecdotes are used.
- Newsletter subscriber counts: not published.
- Hashnode / Medium handle availability: undetermined.
- Whether sequant's 08-30 submission went through the old Console form specifically: inferred from the date (before the portal launched around 09-28). Check the Console page to confirm.
