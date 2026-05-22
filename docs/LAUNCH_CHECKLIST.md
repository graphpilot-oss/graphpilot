# Launch Checklist — Engineering + GTM Status (2026-05-22)

**TL;DR:** 93% engineering ready, 90% GTM ready. **14 tasks left, ~12 hours total work**. Ship Day 0 morning (Tuesday 7am PT).

---

## Engineering Readiness (See `.notes/engineering-readiness.md`)

### What's Done ✅ (70 items)

- ✅ Core engine: parser, indexer, 5 MCP tools, watch mode, evidence anchors, differential impact, worktree-aware indexing
- ✅ Quality: TypeScript strict, ESLint, Prettier, tests (239 passing), linting, type safety
- ✅ Security: T1-T12 threat model (9/12 shipped, 3 optional pre-launch)
- ✅ CI/CD: matrix testing (6 platforms), lint gates test, audit job
- ✅ Hooks: pre-commit (typecheck + lint + format), commit-msg (Conventional), pre-push (test)
- ✅ Documentation: README, quickstart, mcp-setup, architecture, limitations, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT
- ✅ Benchmarks: Tier-A (F1 0.89 vs grep 0.42), Tier-B (7/13 vs 4/13), methodology docs

### What's Left ⏳ (7 items)

**Critical (must have):**

1. **release.yml workflow** (1 hr) — publish to npm on `v*` tag
   - Template: in engineering-readiness.md §5.4
   - After: users can `npm install graphpilot`

**Nice-to-have (improve credibility, all non-blocking):** 2. **CodeQL workflow** (10 min) — free SAST 3. **dependency-review workflow** (10 min) — fail CVE-introducing PRs 4. **Branch protection on main** (2 min web UI) — prevent bad merges 5. **examples/ configurations** (30 min) — Cursor, Cline, Continue configs 6. **Hero GIF** (1-2 hr) — 30-sec terminal demo for README 7. **Domain + landing page** (2 hr) — graphpilot.dev, email forwarding

**Effort summary:**

- Must-have: **1 hour** (release.yml)
- Nice-to-have: **5 hours** (can ship after launch)

---

## GTM Readiness (See `.notes/gtm-strategy.md`)

### What's Done ✅ (60% of assets)

- ✅ Positioning: one-liner, 30-second elevator, competitive differentiation
- ✅ Messaging: headline benchmark (75% more success, 98% fewer hallucinations)
- ✅ Drafts: Show HN post, Twitter thread (8 tweets), Reddit posts (3 angles) — all in gtm-strategy.md appendices
- ✅ README v2: with benchmark proof, quickstart, features
- ✅ Distribution channels: HN, Twitter, Reddit, Discord, MCP registries, newsletters pre-planned
- ✅ Community: Discord server ready, GH Discussions ready to enable, Sponsors ready

### What's Left ⏳ (7 items)

**Before Day 0:**

1. **Customize Show HN post** (30 min) — gtm-strategy.md Appendix A, add your voice
2. **Schedule Twitter thread** (15 min) — Appendix B in Buffer, schedule 07:15–10:15 PT

**Day 0 (execution):** 3. **Create GraphPilot Discord** (15 min) — set up server + channels 4. **Post to distribution channels** (30 min) — HN, Reddit, Discord (copy-paste from drafts) 5. **Monitor + reply to HN comments** (2 hr over 48h) — critical for ranking + users

**Day 1-3 (nice-to-have):** 6. **Produce hero GIF** (1-2 hr) — 30-sec demo of `graphpilot index` + query 7. **Domain + landing page** (2 hr) — graphpilot.dev single-pager

**Effort summary:**

- Must-have (Day 0): **1 hour** (customize drafts + post)
- Day 0 attention: **2 hours** (replies to HN)
- Nice-to-have: **5 hours** (GIF, domain, logo)

---

## Pre-Launch Checklist (Next 48 Hours)

### Engineering

- [ ] `release.yml` written + tested (push dummy `v0.0.1-test` tag, delete after testing)
- [ ] NPM_TOKEN set in GitHub repo secrets
- [ ] `pnpm ci` green on clean clone
- [ ] `npx graphpilot@0.1.0` works post-npm-publish (test after tag)
- [ ] All docs reviewed (README, quickstart, mcp-setup, architecture, limitations)
- [ ] Tier-B benchmark numbers in README + bench/results/
- [ ] Security email (security@graphpilot.dev) forwarding confirmed

### GTM

- [ ] Show HN post customized (gtm-strategy.md Appendix A)
- [ ] Twitter thread scheduled (Appendix B in Buffer, 07:15–10:15 PT slots)
- [ ] Reddit drafts ready (Appendix C, 3 subreddits)
- [ ] Discord templates ready (Appendix D, 4 communities)

---

## Day-0 Launch Sequence (Tuesday, 7am PT)

```
06:55  pnpm ci — green
07:00  git push origin main
07:01  git tag -a v0.1.0 -m "v0.1.0 — initial release"
07:02  git push --tags (triggers release.yml)
       ↓
07:05  release.yml publishes to npm
07:08  npm view graphpilot (confirm v0.1.0 live)
07:10  Flip GitHub repo public (Settings → Visibility)
07:11  Enable security features (CodeQL, Dependabot, Secret Scanning)
07:15  Post to HN (from Appendix A)
07:16  Post Twitter thread (from Appendix B, 30 min apart slots)
07:30  Post to r/programming (from Appendix C)
07:45  Post to r/typescript (from Appendix C)
08:00  Post to r/ClaudeAI (from Appendix C)
08:15  Paste into Discord communities (from Appendix D)
08:30  **Start replying to HN comments** ← critical for ranking
09:00  Create GraphPilot Discord, post invite link
10:00  Check HN ranking, GitHub stars, npm downloads
12:00  Break. You've done the hard part.

Day 1-2: Reply to every HN comment (target: 100% within 48h)
```

**Your time:** ~2 hours Day 0 (mostly copy-paste + reading), 2 hours Day 1 (HN replies).

---

## Success Metrics (30-Day Goals)

| Metric                  | Target | Threshold                  |
| ----------------------- | ------ | -------------------------- |
| GitHub stars            | 500    | 300 (ship if you hit this) |
| npm downloads (Day 30)  | 2k     | 1k                         |
| Discord members         | 100    | 50                         |
| HN upvotes (Day 0)      | 200    | 100 (makes front page)     |
| Reddit combined upvotes | 500    | 300                        |
| Comments on HN Day 0    | 100    | 50                         |
| External PRs            | 1+     | 0 (any is a win)           |

**If you hit the thresholds by Day 30, the launch is successful.** Beyond that is scaling.

---

## Blockers & Dependencies

### Critical Path (Cannot skip)

1. ✅ Differentiation features (evidence anchors, differential impact, worktree) — SHIPPED
2. ✅ Benchmarks (Tier-A + Tier-B proof) — SHIPPED
3. ✅ Drafts (Show HN, Twitter, Reddit copy) — SHIPPED (in gtm-strategy.md)
4. 🟡 **release.yml** — blocks npm install (1 hr work, next priority)

### Non-Blocking Luxuries

- CodeQL, dependency-review, branch protection, logo, GIF, domain, examples — all nice-to-have, can ship in Week 1

---

## Quick-Reference: What to Work On Today

**If you have 1 hour:**

- [ ] Write release.yml (template in engineering-readiness.md §5.4)
- [ ] Add NPM_TOKEN to GitHub secrets

**If you have 3 hours:**

- [ ] Above + customize Show HN post (30 min, gtm-strategy.md Appendix A)
- [ ] Above + schedule Twitter thread (15 min, Appendix B)

**If you have 5 hours:**

- [ ] All of the above + CodeQL + dependency-review workflows (20 min total)
- [ ] All of the above + build hero GIF (1-2 hr)

**If you have 8 hours:**

- [ ] All of the above + buy domain (graphpilot.dev, 15 min) + build landing page (1.5 hr)

**Launch is go-ready after the 1-hour mark (release.yml). Everything else is polish.**

---

## Cross-References

- **Full engineering readiness playbook:** `.notes/engineering-readiness.md` (§0 checklist, §5.4 release.yml template, §13 pre-launch checklist)
- **Full GTM strategy:** `.notes/gtm-strategy.md` (§8-10 launch mechanics, Appendices A-E with draft copy)
- **Project guide (easy explanation):** `.notes/PROJECT_GUIDE.md`
- **Launch roadmap (week-by-week):** `.notes/LAUNCH_ROADMAP.md`

---

**Status:** Ready to ship. The question is not "are we ready?" but "what day?"

**Recommendation:** Ship Day 0 morning (Tuesday 7am PT). You have all the pieces.
