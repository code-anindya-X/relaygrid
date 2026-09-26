# Agents That Act — Hackathon scrape

**Requested page:** <https://hackculture.io/hackathons/agents-that-act>  
**Event:** TrueFoundry × Polaris “Agents That Act”  
**Scraped:** 25 September 2026 (Asia/Kolkata)

## Source and coverage note

The requested HackCulture URL was not directly retrievable in the web fetch/browser tools used for this scrape. The event details below were cross-checked against the organizer's matching [TrueFoundry event page](https://www.truefoundry.com/es/truefoundry-hackathon) and HackCulture's [LinkedIn event announcement](https://in.linkedin.com/company/hackculture). Treat the organizer page as the detailed source; this file is a structured extraction and summary, not a verbatim mirror of the entire HTML/CSS or page source.

## At a glance

- **Date:** Saturday, 26 September 2026
- **Location:** Polaris campus, Bengaluru, India; shortlisted participants attend in person
- **Format:** Free, one-day, on-site build event; online individual application followed by shortlist
- **Capacity:** Approximately 350–400 builders
- **Prize pool:** ₹3,00,000 cash
- **Core stack requirement:** Agent must run on TrueForge
- **Theme:** Build an agent that acts on real systems, executes generated code safely, and pauses for human approval before consequential or irreversible actions
- **Registration close:** Friday, 18 September 2026 at 23:59 IST. As of this scrape (25 September), the stated deadline has passed.
- **Shortlist announcement:** Monday, 21 September 2026

## What the challenge is asking for

Build an end-to-end agent for a real task in any domain. It must demonstrate all three of these:

1. **Reach a real system:** e.g. a database, code repository, cloud account, or ticket queue, preferably through MCP. A mocked function or fixture-only demo does not meet the stated intent.
2. **Run what it writes:** generated code should execute in an isolated, disposable sandbox so a bad result cannot damage the real system.
3. **Know when to stop:** before a consequential action such as sending an email, deleting data, revoking a key, applying a production migration, or publishing a release, show the proposed action and wait for a human approval.

The expected demo is a working agent using TrueForge, reaching a real tool, executing code in the sandbox, and pausing at a clearly explained approval checkpoint.

## Suggested project directions

These are examples, not exclusive tracks; any domain is allowed.

| Idea | What it does | System reached | Human approval gate |
|---|---|---|---|
| Cloud cost janitor | Finds idle resources, estimates monthly cost, drafts a cleanup plan | Cloud billing and infrastructure APIs | Delete a resource |
| Migration rehearsal agent | Restores a database copy, runs a schema migration in a sandbox, compares changed rows | Database | Apply to production |
| Release captain | Reviews commits, runs tests, drafts release notes | GitHub and package registry | Tag/publish a release |
| Ticket resolver | Reproduces a bug, proposes a patch and customer reply | Linear, Jira, or Zendesk | Send the customer response |
| Access reviewer | Finds unused permissions and proposes least-privilege changes | Identity provider / IAM | Revoke access |
| Runbook executor | Carries out reversible infrastructure steps and pauses at dangerous ones | Infrastructure systems | Each destructive step |

## Submission requirements

- Run the agent on TrueForge and make the harness's role visible in the demo.
- Finish one narrow job end to end; a working focused build is preferred over several incomplete features.
- Show where code ran and the point where the agent requests approval.
- Provide a public repository with a README that lets someone else run the project.
- Disclose AI coding assistants used and be able to explain the architecture.
- Use only systems, data, and credentials the team is authorized to connect. Do not put secrets in the repository or demo video.
- Build the project on the event day. Pre-built projects are ineligible; research and reading documentation beforehand are allowed.

## Eligibility and participation

- Anyone aged 18 or older who can attend in person in Bengaluru is eligible; it is not student-only.
- Individual online application; teams of up to four can form beforehand in Discord or at the venue. Solo entries are allowed.
- Round 1 is online; Round 2 is in-person by invitation.
- TrueForge is mandatory. Other languages, frameworks, and model providers are open.
- Prior TrueFoundry experience is not required.
- Free entry and attendance. Food, power, and Wi-Fi are provided. Participants cover travel to Bengaluru.
- Bring a laptop, charger, backup phone hotspot, preferred API keys if needed, and government photo ID for campus entry.
- Participants keep the intellectual property in their projects. The organizers request permission to reference/showcase the demo.
- Code of conduct applies; harassment can result in removal.

## Application flow

1. Submit an individual online application explaining who you are, why you want to participate, and what you plan to build. No prototype is needed for Round 1; the form is described as taking about five minutes.
2. Applications are reviewed on a rolling basis. The organizers say idea specificity and technical plausibility matter more than résumé polish.
3. Shortlisted applicants receive an email invitation with venue details and logistics; check spam.
4. Build in person on 26 September, submit a repo link and short write-up, then demo to judges.
5. For the separate community prizes, Round 1 registrants can post a public build story on LinkedIn or X, tag `@truefoundry` and `@polariscodes`, and include `#agentsthatact`.

## Agenda (provisional, IST)

The organizer says timings may shift by up to 30 minutes; final details are sent with shortlist invitations.

| Time | Activity |
|---|---|
| 09:00 | Check-in and setup |
| 10:00 | Kickoff and problem brief |
| 10:30 | TrueForge + AI Gateway technical walkthrough; MCP, sandbox, approval gate |
| 12:00 | Build starts; lunch; mentors available |
| 16:00 | Optional mentor checkpoint |
| 19:00 | Submission deadline: code and short write-up |
| 19:30 | Live demos and judging |
| 21:00 | Results and prize announcements |

## Prizes

All amounts are INR cash, reportedly paid after the event.

| Category | Award |
|---|---:|
| Build — first place | ₹1,00,000 |
| Build — second place | ₹75,000 |
| Build — third place | ₹50,000 |
| Community — best build story | ₹50,000 |
| Community — runner-up build story | ₹25,000 |
| **Total** | **₹3,00,000** |

Build prizes are judged at the venue. Community prizes are for public write-ups, threads, blog posts, or demo videos explaining the job delegated to the agent, how it was connected, and what the builder learned. Community prizes are open to all Round 1 registrants, even if they are not shortlisted. Organizer page says partner credits or category awards may be added.

## Judging rubric

Scores total 100 points:

| Criterion | Weight | What judges look for |
|---|---:|---|
| Harness does real work | 30 | TrueForge reaches a real tool, runs generated code in a sandbox, and pauses for a person; a prompt with a thin UI does not qualify well |
| Working software | 25 | Cloneable and runnable project; focused working scope beats broad incomplete scope |
| Safety boundary | 20 | Clear, justified actions the agent cannot take alone; sandboxing, approval gate, and limited blast radius |
| Worth delegating | 15 | A real, useful chore that a person would actually hand off |
| Demo clarity | 10 | In five minutes, show the task, agent execution, and harness; team can explain architecture |

## Tooling notes

- TrueForge is described as open source under MIT license, runnable locally with Node.js 22+ using `npx @truefoundry/trueforge`.
- Listed capabilities include 40+ built-in tools, MCP servers with OAuth, sandboxed code execution, approval checkpoints, subagents, git-backed skills, and persistent sessions.
- Model provider is open: OpenAI, Anthropic, Gemini, or an OpenAI-compatible endpoint.
- TrueFoundry's AI Gateway is optional; it offers budgets, rate limits, and traces.
- OpenAI API credits and AWS cloud credits are mentioned as event support.

## Hosts, judges, and support

- **Hosts:** TrueFoundry and Polaris; Polaris provides the Bengaluru campus and mentors.
- **Judges listed:** Rahul Bhattacharya (CTO, Adopt.AI), Ramakant Yadav (Founder, Scalar Field), Abhishek (CTO, TrueFoundry), Rivu Chakraborty (Sarvam.ai), and Suhas Motwani (Co-founder, The Product Folks).
- **Community:** Discord is described as the place to find teammates, ask TrueForge questions, get schedule updates, and hear shortlist news.

## Source links

- [HackCulture event page (requested)](https://hackculture.io/hackathons/agents-that-act)
- [TrueFoundry organizer page](https://www.truefoundry.com/es/truefoundry-hackathon)
- [HackCulture LinkedIn announcement](https://in.linkedin.com/company/hackculture)
- [TrueForge GitHub](https://github.com/truefoundry/trueforge)

