// Generates public/data/answers.json from src/persona.js so the offline tier can
// never drift from what the live model is told. Run after editing the persona.
import { PROFILE } from "../src/persona.js";
import { writeFileSync, readFileSync } from "node:fs";

const a = PROFILE.answers;

const entries = [
  { id: "story", keys: ["life story", "about yourself", "tell me about you", "background", "who are you", "your story", "introduce"], q: "What should we know about your life story?", a: a.lifeStory },
  { id: "superpower", keys: ["superpower", "super power", "best at", "strength", "strongest", "number one", "#1", "what are you good at"], q: "What's your #1 superpower?", a: a.superpower },
  { id: "growth", keys: ["grow", "growth", "improve", "weakness", "weaknesses", "develop", "get better", "learning", "areas"], q: "What are the top 3 areas you'd like to grow in?", a: a.growthAreas },
  { id: "strengths", keys: ["strengths", "strength", "good at", "best qualities", "what do you bring", "why are you good"], q: "What are your main strengths?", a: a.strengths },
  { id: "weaknesses", keys: ["weakness", "weaknesses", "shortcoming", "not good at", "struggle with", "biggest weakness", "work on", "ask for help", "asking for help", "hard to ask", "overcommit", "saying no", "say no"], q: "What's your biggest weakness?", a: a.weaknesses },
  { id: "misconception", keys: ["misconception", "misunderstand", "wrong about you", "coworkers think", "colleagues think", "get you wrong"], q: "What misconception do your coworkers have about you?", a: a.misconception },
  { id: "limits", keys: ["push", "boundaries", "limits", "challenge yourself", "out of your comfort", "stretch", "hard things"], q: "How do you push your boundaries and limits?", a: a.pushingLimits },
];

const projectBlurb = PROFILE.projects
  .map((p) => `${p.name} — ${p.what.split(".")[0]}.`)
  .join(" ");

const extra = [
  { id: "projects", keys: ["project", "proud of", "built", "portfolio", "what have you made", "show me your work"],
    q: "What project are you most proud of?",
    a: `MCP-Hardener, easily. It's a seven-package TypeScript monorepo that turns an OpenAPI spec into a hardened MCP server for AI agents — read-only by default, writes held behind a single-use approval bound to a hash of the exact arguments, tenant IDs stripped from anything the agent can see. There's a gateway that enforces the same rules on third-party servers, and a scanner that fails the build on high-severity findings. About 350 tests. It's live at hardened-mcp.mcphardener.workers.dev.` },
  { id: "experience", keys: ["where have you worked", "work experience", "previous roles", "past jobs", "innov8", "adnoc", "internship", "employment history", "your experience"],
    q: "Where have you worked?",
    a: `Two places that mattered. ADNOC Refining in Abu Dhabi, Dec 2025 into Jan 2026, where I built Python ETL pipelines that pulled legacy refinery logs into a warehouse and cut about twenty hours a week of manual work. Then Innov8 Soft Technologies in Dubai, September to October 2026, where I owned payroll, notifications and access control on a multi-tenant HR SaaS — including a 299-permission layer across 380-plus endpoints.` },
  { id: "sport", keys: ["football", "play sport", "play any sport", "sport", "sports", "exercise", "fitness"],
    q: "Do you play any sport?",
    a: `Football, mostly — I've played it since I was a kid and I still do. I watch a lot of sport generally. Beyond that I read about whatever's coming next in tech, which is less of a hobby and more of a problem. Long term I'd like to start a business of my own that solves something real.` },
  { id: "research", keys: ["research", "paper", "published", "lung cancer", "deep learning", "academic", "thesis"],
    q: "Tell me about your research paper.",
    a: `At SRM I published a comparative study of five deep learning architectures — AlexNet, VGG16, ResNet, DenseNet and U-Net — for detecting lung cancer in CT scans. It's what pulled me properly into AI rather than just backend work. The code is on my GitHub under Lung-Cancer-Analysis.` },
  { id: "stack", keys: ["stack", "technologies", "languages", "skills", "tech", "tools", "what do you use",
      "do you know", "have you used", "experience with", "familiar with", "comfortable with",
      "typescript", "javascript", "python", "node", "nestjs", "fastapi", "flask", "react", "next.js", "nextjs",
      "postgres", "postgresql", "mysql", "sqlite", "typeorm", "sqlalchemy", "pydantic", "redux", "vite",
      "tailwind", "docker", "kubernetes", "k8s", "aws", "cloudflare", "jest", "pytest",
      "bash", "opencv", "pandas", "plotly", "mlflow", "ollama", "pgvector", "chromadb", "faiss",
      "langgraph", "rag", "mcp", "backend", "frontend", "database", "devops"],
    q: "What's your stack?",
    a: `TypeScript and Python are home. On the backend, NestJS and FastAPI with PostgreSQL, TypeORM or SQLAlchemy, and a lot of attention to access control and multi-tenancy. React and Next.js on the front. Docker everywhere, Kubernetes where it earns it. And on the AI side, provider APIs, RAG and LangGraph.` },
  { id: "education", keys: ["education", "degree", "college", "university", "studied", "srm", "cgpa", "school", "grew up"],
    q: "What did you study?",
    a: `B.Tech in Computer Science at SRM in Chennai, 2022 to 2026, CGPA 8.13. Before that I was in Abu Dhabi — Asian International School in Ruwais, CBSE all the way through twelfth.` },
  { id: "why", keys: ["why should we hire", "why you", "fit", "hire you", "good fit", "value"],
    q: "Why should we hire you?",
    a: `Because I learn fast and I finish. Drop me into something I've never used and I'll be shipping in it within a day — that's how I went from zero NestJS to owning a payroll system. And I ship the part most people skip: the migration that's safe to run twice, the permission that can't be bypassed, the tests that prove it.` },
  { id: "ai", keys: ["llm", "llms", "genai", "machine learning", "gpt", "experience with ai", "experience with llms", "ai work", "ai experience", "language models"],
    q: "What's your experience with AI?",
    a: `Mostly the engineering around models. At Innov8 I co-built a multi-provider layer across OpenAI, Anthropic, Gemini, Mistral and DeepSeek with streaming and schema-structured output, plus per-tenant cost metering so no tenant could spend against another. On my own: KubeMedic, a five-node LangGraph agent that turns Kubernetes crash logs into remediation guides, and MCP-Hardener, which is about making agent tooling safe by construction.` },
  { id: "location", keys: ["where are you", "based", "location", "live", "city", "remote", "timezone", "time zone", "relocate", "relocation", "overlap", "us hours", "working hours", "where do you work from", "hybrid", "onsite", "on site", "in the office", "from the office", "office full time", "work from office", "only remote", "only looking for remote", "remote work", "work remotely", "willing to move", "days a week"],
    q: "Where are you based, and are you open to remote?",
    a: `I'm in Bangalore, India. I grew up in Abu Dhabi, did my degree in Chennai, and worked in Dubai and Abu Dhabi, so I've moved around a fair bit and I'm genuinely flexible — remote, hybrid or in an office all work for me, and I'm happy to overlap with whatever hours the team needs.` },
  { id: "earlylife", keys: ["born", "grow up", "growing up", "childhood", "school", "schooling", "where are you from", "hometown", "12th", "10th", "cbse", "originally"],
    q: "Where did you grow up?",
    a: `I was born in Ranchi, in Jharkhand, and moved to the UAE when I was five, so I grew up in Abu Dhabi. All my schooling was at Asian International School in Ruwais, CBSE, right through 12th — 82.4 in 10th and 75.4 in 12th. Then I came back to India for my B.Tech at SRM Kattankulathur. Football and technology were the two things that stuck the whole way through.` },
  { id: "status", keys: ["available", "availability", "notice period", "notice", "when can you join", "when can you start", "current job", "working now", "employed", "joining", "salary", "compensation", "expectations", "ctc", "package", "how much are you", "how much do you expect", "other offers", "interviewing elsewhere", "situation", "are you working", "currently working", "out of work", "between jobs"],
    q: "What's your current situation and notice period?",
    a: `I'm looking for work at the moment, so there's no notice period — I can start immediately. I'm flexible on the arrangement too: remote, hybrid or onsite all work for me. On compensation, I'd happily discuss that with you personally.` },
  { id: "whyleft", keys: ["why did you leave", "left innov8", "leave your job", "why leave", "short stint", "two months", "quit", "only a couple of months"],
    q: "Why did you leave Innov8?",
    a: `It was a contractual role, and when it came up for renewal the next contract required signing a two-year bond. I wasn't willing to tie myself down for two years, so I finished the contract and moved on. The work itself went well — I owned payroll, notifications and access control end to end while I was there.` },
  { id: "failure", keys: ["failure", "failed", "fail", "mistake", "went wrong", "biggest mistake", "setback", "regret", "time you failed", "screwed up"],
    q: "Tell me about a time you failed.",
    a: `On the payroll work I shipped the month-lock on creating records but not on editing them, so a processed payroll month was closed to new entries and still quietly editable. The frozen payslips meant no money was wrong, but the live records and the snapshot could drift — exactly the class of bug I'd said I was there to prevent. I found it by probing a processed run rather than by reading the code, and that's the real lesson: I assume a guard I haven't attacked isn't a guard yet.` },
  { id: "conflict", keys: ["conflict", "disagree", "disagreement", "pushback", "difficult conversation", "difficult teammate", "argument"],
    q: "How do you handle disagreement?",
    a: `I try to turn it into a question about consequences rather than taste. On the HR product I wanted platform-admin accounts creatable only by hand, against the database — no endpoint, no seeder — and that's less convenient, so it needed defending. The argument that worked wasn't "it's safer", it was "any code path in the running app that can mint a super admin is an escalation path for anyone who reaches it". When someone pushes back and they're right, I'd rather change my mind fast and say so.` },
  { id: "criticism", keys: ["handle criticism", "take feedback", "receive feedback", "criticised", "criticized", "harsh feedback", "code review", "feedback", "give difficult feedback", "difficult feedback", "giving feedback", "give feedback", "giving criticism", "give criticism", "tough conversation"],
    q: "How do you handle criticism of your work?",
    a: `I try to treat it as data rather than a verdict — if someone's right, changing my mind quickly is cheaper than defending a position I've stopped believing. Code review is the easy version and I want more of it; I've been building mostly alone, and a team that catches me is one of the things I'm looking for. Giving criticism was the harder direction for me — I used to avoid it, which didn't help anyone, so now I talk about the behaviour rather than the person.` },
  { id: "whyrole", keys: ["why this role", "why us", "why 100x", "why apply", "want this role", "why this job", "why are you interested"],
    q: "Why do you want this role?",
    a: `Because the interesting problem right now isn't the model, it's everything we hand the model. I spent the last year on that plumbing — a multi-provider LLM layer with structured output and per-tenant cost controls, a LangGraph agent for Kubernetes incidents, and then MCP-Hardener, which exists because connecting an agent to a tool server is a one-liner and what it gets is usually completely unguarded. It's backend engineering with real consequences, which is what I'm good at.` },
  { id: "whyagents", keys: ["why agents", "drawn to", "interested in agents", "what excites you", "agent systems"],
    q: "What draws you to agent systems?",
    a: `Connecting an agent to a tool server is a one-liner, and what it gets back is usually completely unguarded — delete is as reachable as read, and a tool's description is read by the model as instructions. That gap is the thing I keep coming back to, and it's why I built MCP-Hardener. It's a security problem and a plumbing problem at the same time, which suits me.` },
  { id: "bestfit", keys: ["best for this role", "best candidate", "why are you the best", "stand out", "right person", "what makes you", "why should we hire"],
    q: "Why are you the best person for this role?",
    a: `Because the gap on most agent teams is the engineering around the model, and that's what I've been doing. A multi-provider LLM layer with streaming and schema-structured output, a LangGraph agent turning Kubernetes crash logs into remediation guides, and MCP-Hardener. I also bring the boring strengths: a 299-permission layer across 380-plus endpoints, a migration safe to re-run before a 14,000-user cutover, 350-plus tests on my own project with nobody making me. And I'm available immediately, happy fully remote, and fast — I hadn't used the Gemini Live API or Cloudflare Workers before I built this bot.` },
  { id: "looking", keys: ["looking for", "want in a role", "ideal job", "career goals", "next role", "what matters to you in"],
    q: "What are you looking for in your next role?",
    a: `Agent and LLM systems, with real users on the other end, and people who are better than me at it. I've been building this kind of thing mostly alone on my own time, and the thing I'm missing is a team with a higher bar than mine — code review that catches me, and systems under real load. I'd also like to own something end to end rather than a slice of it.` },
  { id: "personal", keys: ["outside work", "hobbies", "hobby", "free time", "fun", "on your resume", "about you personally", "interests", "personally"],
    q: "Tell me something about yourself that isn't on your resume.",
    a: `I play football — have done since I was a kid — and I watch a lot of sport generally. I follow new technology closely, probably more than is healthy. For a while I edited video for a YouTube channel that got past five thousand subscribers, which taught me more about holding someone's attention than any amount of writing did. And the long-term thing I want is to build a self-sufficient business that solves a real problem.` },
  { id: "youtube", keys: ["youtube", "editing", "video", "subscribers", "channel", "editor", "content creation"],
    q: "Tell me about the YouTube editing.",
    a: `I edited video for a YouTube channel that grew past five thousand subscribers. It taught me more about holding someone's attention than any amount of writing did — if the first few seconds don't land, nothing after them matters. I use that more than I expected to when deciding what to put in front of someone first.` },
  { id: "resume", keys: ["walk me through", "your resume", "your cv", "take me through", "summarise your", "summarize your"],
    q: "Walk me through your resume.",
    a: `Quickly: B.Tech in computer science at SRM Kattankulathur, 2022 to 2026, CGPA 8.13. Then an internship at ADNOC Refining in Abu Dhabi, building Python ETL for refinery logs and cutting about twenty hours a week of manual work. Then Innov8 Soft Technologies in Dubai, where I owned payroll, notifications and role-based access control on a multi-tenant HR SaaS — a 299-permission layer across 380-plus endpoints. Alongside that, projects of my own: a LangGraph ETL pipeline, KubeMedic, and MCP-Hardener, which I'm on now.` },
  { id: "whycs", keys: ["why computer science", "why did you choose", "why engineering", "why software", "get into tech", "why programming"],
    q: "Why did you choose computer science?",
    a: `Tech was the thing I kept coming back to as a kid in Abu Dhabi, long before it was a career plan, and computer science was the version of that I could go and study. The part I didn't expect was AI — that got hold of me at university, to the point where I published a research paper on detecting lung cancer from CT scans with deep learning. Everything I've chosen since has pointed that way.` },
  { id: "pressure", keys: ["pressure", "tight deadline", "deadlines", "deadline", "stress", "stressed", "crunch", "time pressure"],
    q: "How do you work under pressure and tight deadlines?",
    a: `Deadlines are honestly where I'm at my best — I'd rather have a date than an open-ended brief. This bot is the recent example: a day to build it, including two APIs I'd never touched. The way I handle it is to get something working end to end badly first, then make it good, so there's always something shippable. What I've learned not to do is quietly absorb more scope while the date stays fixed.` },
  { id: "prioritise", keys: ["prioritise", "prioritize", "urgent", "juggle", "competing", "triage", "too much on"],
    q: "How do you prioritise when everything is urgent?",
    a: `I look at what actually breaks if it slips, and what blocks someone else — the thing another person is waiting on goes first, because my delay becomes their delay. Then I'm honest about bandwidth instead of agreeing to everything. That's something I've had to learn: I used to say yes reflexively and overcommit, so now I check what's already on the list before answering.` },
  { id: "teamwork", keys: ["team", "alone", "collaborate", "collaboration", "with others", "prefer working", "solo", "teammates"],
    q: "Do you prefer working alone or on a team?",
    a: `A team, and I think I'm good in one — I tend to end up as the person who unblocks other people, so the team's output goes up more than mine does. I can go heads-down when something needs deep focus, and most of my own projects were built that way. But doing it entirely alone is what I'm trying to get away from; what I want next is a team with a higher bar than mine.` },
  { id: "learnfast", keys: ["learn something quickly", "learn fast", "pick up", "picked up", "new tool", "unfamiliar", "self taught", "teach yourself"],
    q: "Tell me about a time you had to learn something quickly.",
    a: `This bot, honestly. I had a day, and I'd never used the Gemini Live API or Cloudflare Workers — so I built the simplest thing that could speak, then layered on the WebSocket proxy, the barge-in and the fallbacks. Before that it was LangGraph for KubeMedic and the MCP spec for MCP-Hardener, both picked up inside a real project rather than a tutorial. Having something that has to work by a date is what makes it stick for me.` },
  { id: "ambiguity", keys: ["ambiguity", "ambiguous", "unclear", "vague", "requirements", "ill defined", "figure out what"],
    q: "How do you deal with ambiguity or unclear requirements?",
    a: `I ask the question that changes the answer, and I don't ask the rest. Usually that's about consequences — what happens if this runs twice, who's allowed to call this, what the number means when the data is missing. Where I can't get an answer I pick the safer reading, build it, and say out loud what I assumed so it's easy to correct. Waiting for perfect clarity just moves the risk later.` },
  { id: "motivates", keys: ["motivates", "motivation", "drives you", "excites you", "enjoy most", "love about", "passion"],
    q: "What motivates you?",
    a: `Building something that solves a real problem for someone, and that holds up. The unglamorous half is what I actually enjoy — the migration you can safely run twice, the permission check nobody can skip. The long-term version is that I want to build a self-sufficient business that solves a real problem in the world, so working on things that matter to the people using them is the practice for that.` },
  { id: "manager", keys: ["manager say", "boss say", "reference", "colleagues say", "describe you", "former manager", "team say about you"],
    q: "What would your last manager say about you?",
    a: `That I deliver when I said I would, and that I own the thing rather than the ticket — at Innov8 I had payroll, notifications and access control end to end and nobody had to chase me. I think they'd also say I go quiet when I'm deep in something, which reads as unapproachable until you know me. And probably that I'd rather raise the awkward question about permissions early than discover it in production.` },
  { id: "workstyle", keys: ["working style", "work style", "how do you work", "your process", "routine", "day to day"],
    q: "How would you describe your working style?",
    a: `Deep focus in long blocks, and a bias towards getting something running early so there's a real thing to argue about. I write tests as I go — 350-plus on my own project — because it's how I know the claim is true. I like owning a whole slice end to end. And I'd rather over-communicate the assumption I made than have someone find it a week later.` },
  { id: "dream", keys: ["dream", "long term", "longterm", "ambition", "ten years", "aspire", "ultimate goal", "five years", "future"],
    q: "What's your long-term ambition?",
    a: `Two things. I want to grow into leading teams — broader operational strategy, helping scale a business, not just the code inside it. And the longer-term dream is to build a self-sufficient business that solves a real problem in the world, something that stands on its own rather than a startup for its own sake. The nearer step is deeper ownership and getting properly good in front of a room.` },
  { id: "leadership", keys: ["leadership", "lead a team", "led a team", "mentor", "manage people", "management", "take charge"],
    q: "Do you have leadership experience?",
    a: `Not formally managing anyone yet, and I'd rather say that straight. What I have is ownership — at Innov8 I ran payroll, notifications and access control end to end, decided how the permission model worked, and defended those calls. Leading teams is exactly where I want to grow next, along with being better in front of larger, cross-functional groups. So it's an honest gap and a deliberate direction, not something I'm claiming.` },
  { id: "security", keys: ["security", "secure", "why do you care", "safety", "guardrails", "risk", "threat"],
    q: "Why do you care so much about security?",
    a: `Because discipline doesn't hold at three in the morning, and systems shouldn't depend on it. Working on payroll made that concrete — people get paid from that code. With agents it's sharper: handing an agent a tool server is a one-liner, and what it gets is usually completely unguarded, where delete is as reachable as read. I'd rather the blast radius be a property of the configuration than of the upstream author's good intentions.` },
  { id: "testing", keys: ["testing", "tests", "test coverage", "quality", "how do you test", "unit test"],
    q: "How do you think about testing?",
    a: `Tests are how I earn the right to claim something works. MCP-Hardener has 350-plus and nobody was making me write one. The ETL pipeline has twenty-five that run with no database and no API key, so they actually get run. I also trust probing over reading — the payroll month-lock bug I found by attacking a processed run, not by reviewing code.` },
  { id: "thisbot", keys: ["this bot", "voice bot", "build this", "made this", "how does this work", "this app", "this demo", "built this"],
    q: "How did you build this voice bot?",
    a: `Three tiers, so it can't dead-end on you. Tier one is the Gemini Live API over a WebSocket — mic in, spoken audio out, with barge-in. If that can't start, tier two uses the browser's own speech recognition and synthesis around a text model. If there's no network, tier three answers from a prepared bank. The key bit is that the browser never holds the API key: a Cloudflare Worker proxies the socket and sends the setup frame itself, so the persona can't be swapped by editing the page's JavaScript.` },
  { id: "keepup", keys: ["keep up", "stay current", "stay up to date", "follow technology", "newsletters", "learn new things"],
    q: "How do you keep up with new technology?",
    a: `By building with it — reading about something doesn't stick for me. MCP is the clearest case: the spec was new, so I went and built a hardening layer for it and found out where it's weak. Otherwise I follow it fairly closely out of genuine interest; upcoming tech is what I read about for fun. But the filter is whether I can make something with it.` },
  { id: "contact", keys: ["contact", "reach you", "email", "linkedin", "github", "get in touch"],
    q: "How can I reach you?",
    a: `Easiest is email — adityadurjay at gmail dot com. I'm on LinkedIn as das-aditya and GitHub as aoutix, and the projects I've talked about are up there.` },
];

const payload = {
  note: "Offline answer bank. Used only when the live model cannot be reached.",
  fallback: `I can't reach my live voice right now, so I'm answering from what I prepared. Ask me about my story, what I'm best at, where I want to grow, what people get wrong about me, how I push myself, or any of my projects. ${projectBlurb}`,
  entries: [...entries, ...extra],
};

writeFileSync(new URL("../public/data/answers.json", import.meta.url), JSON.stringify(payload, null, 2));
console.log(`answers.json written: ${payload.entries.length} entries`);

// ---------------------------------------------------------------- the page panel
// The #answers panel on the page is the same twelve entries, rendered into index.html
// between markers, so the written answers are real HTML (readable with no JavaScript)
// and can never drift from the bank the voice falls back on. public/js/answers.js
// adds the behaviour on top: search, filters, selection, and asking out loud.

const META = {
  story:        { label: "Life story",    initials: "LS", group: "Himself", tags: ["career"] },
  superpower:   { label: "Superpower",    initials: "SP", group: "Himself", tags: ["security", "backend"] },
  growth:       { label: "Growth",        initials: "GR", group: "Himself", tags: ["career"] },
  misconception:{ label: "Misconception", initials: "MC", group: "Himself", tags: ["career"] },
  limits:       { label: "Limits",        initials: "LM", group: "Himself", tags: ["career"] },
  projects:     { label: "Projects",      initials: "PR", group: "Work",    tags: ["agents", "security"] },
  experience:   { label: "Work",          initials: "WK", group: "Work",    tags: ["backend", "data"] },
  stack:        { label: "Stack",         initials: "ST", group: "Work",    tags: ["backend"] },
  ai:           { label: "AI",            initials: "AI", group: "Work",    tags: ["agents"] },
  education:    { label: "Education",     initials: "ED", group: "Background", tags: ["career"] },
  why:          { label: "Why him",       initials: "WH", group: "Background", tags: ["backend", "career"] },
  location:     { label: "Based in",      initials: "BA", group: "Background", tags: ["career"] },
  failure:      { label: "A failure",     initials: "FL", group: "Himself", tags: ["career", "backend"] },
  conflict:     { label: "Disagreement",  initials: "DG", group: "Himself", tags: ["career", "security"] },
  whyrole:      { label: "Why agents",    initials: "WA", group: "Background", tags: ["agents"] },
  looking:      { label: "Looking for",   initials: "LF", group: "Background", tags: ["career"] },
  bestfit:      { label: "Why him",       initials: "BF", group: "Background", tags: ["agents", "career"] },
  whyleft:      { label: "Why he left",   initials: "WL", group: "Work",    tags: ["career"] },
  status:       { label: "Availability",  initials: "AV", group: "Contact", tags: ["career"] },
  personal:     { label: "Outside work",  initials: "OW", group: "Himself", tags: ["career"] },
  research:     { label: "Research",      initials: "RS", group: "Background", tags: ["data"] },
  whyagents:    { label: "Why agents",    initials: "WG", group: "Work",    tags: ["agents"] },
  strengths:    { label: "Strengths",     initials: "SG", group: "Himself", tags: ["career"] },
  weaknesses:   { label: "Weaknesses",    initials: "WK2", group: "Himself", tags: ["career"] },
  earlylife:    { label: "Growing up",    initials: "GU", group: "Background", tags: ["career"] },
  resume:       { label: "Resume",        initials: "RE", group: "Work",    tags: ["career"] },
  whycs:        { label: "Why CS",        initials: "WC", group: "Background", tags: ["career"] },
  pressure:     { label: "Pressure",      initials: "PS", group: "Himself", tags: ["career"] },
  prioritise:   { label: "Prioritising",  initials: "PQ", group: "Himself", tags: ["career"] },
  teamwork:     { label: "Teamwork",      initials: "TW", group: "Himself", tags: ["career"] },
  learnfast:    { label: "Learning fast", initials: "LQ", group: "Himself", tags: ["career"] },
  ambiguity:    { label: "Ambiguity",     initials: "AM", group: "Himself", tags: ["career"] },
  motivates:    { label: "Motivation",    initials: "MO", group: "Himself", tags: ["career"] },
  manager:      { label: "Manager says",  initials: "MS", group: "Work",    tags: ["career"] },
  workstyle:    { label: "Work style",    initials: "WS", group: "Himself", tags: ["career"] },
  dream:        { label: "Ambition",      initials: "AB", group: "Background", tags: ["career"] },
  leadership:   { label: "Leadership",    initials: "LD", group: "Himself", tags: ["career"] },
  security:     { label: "Security",      initials: "SC", group: "Work",    tags: ["security"] },
  testing:      { label: "Testing",       initials: "TS", group: "Work",    tags: ["backend"] },
  thisbot:      { label: "This bot",      initials: "TB", group: "Work",    tags: ["agents"] },
  keepup:       { label: "Keeping up",    initials: "KU", group: "Himself", tags: ["career"] },
  sport:        { label: "Sport",         initials: "SR", group: "Himself", tags: ["career"] },
  youtube:      { label: "YouTube",       initials: "YT", group: "Himself", tags: ["career"] },
  criticism:    { label: "Criticism",     initials: "CR", group: "Himself", tags: ["career"] },
  contact:      { label: "Contact",       initials: "CT", group: "Contact", tags: ["career"] },
};

const GROUP_ICON = {
  Himself: '<svg class="ui-icon" viewBox="0 0 16 16"><circle cx="8" cy="6" r="2.5"/><path d="M3.5 13.5c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5"/></svg>',
  Work: '<svg class="ui-icon" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>',
  Background: '<svg class="ui-icon" viewBox="0 0 16 16"><path d="M2.5 6 8 3.5 13.5 6 8 8.5z"/><path d="M4.5 7.2v3.3c0 .8 1.6 1.5 3.5 1.5s3.5-.7 3.5-1.5V7.2"/></svg>',
  Contact: '<svg class="ui-icon" viewBox="0 0 16 16"><path d="m3.5 8.4 2.8 2.8 6.2-6.4"/></svg>',
  All: '<svg class="ui-icon" viewBox="0 0 16 16"><path d="M2.5 9h3l1 1.5h3l1-1.5h3"/><path d="M2.5 9 4 3.5h8L13.5 9v3.5h-11z"/></svg>',
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wordCount = (s) => s.trim().split(/\s+/).length;

const rich = payload.entries.map((e, i) => {
  const m = META[e.id];
  if (!m) throw new Error(`no panel metadata for entry "${e.id}" — add it to META in build-answers.mjs`);
  return { ...e, ...m, tone: (i % 5) + 1, words: wordCount(e.a) };
});

const rowsHtml = rich.map((e) => `
                  <button class="ui-win__row" type="button" role="option" id="ans-row-${e.id}" aria-selected="false" aria-controls="ans-doc-${e.id}" data-row data-id="${e.id}" data-group="${e.group}" data-tags="${e.tags.join(" ")}" data-q="${esc(e.q)}">
                    <span class="ui-avatar" data-tone="${e.tone}" aria-hidden="true">${e.initials}</span>
                    <span class="ui-win__who">${esc(e.label)}</span>
                    <span class="ui-win__sub">${esc(e.q)}</span>
                    <span class="ui-win__st" data-st>Ready</span>
                    <span class="ui-win__age">${e.words}</span>
                  </button>`).join("");

const docsHtml = rich.map((e) => `
              <article class="ans-doc" id="ans-doc-${e.id}" data-doc="${e.id}" aria-labelledby="ans-row-${e.id}">
                <div class="ui-msg ui-msg--me"><span class="ui-msg__text">${esc(e.q)}</span></div>
                <div class="ui-msg ui-msg--bot">
                  <span class="ui-agent ui-msg__av" aria-hidden="true"></span>
                  <span class="ui-msg__col">
                    <span class="ui-chat__answer">${esc(e.a)}</span>
                    <span class="ans-doc__foot">
                      <button class="ans-doc__say" type="button" data-say="${esc(e.q)}">Ask this out loud</button>
                      <span class="ans-doc__meta">${e.words} words${e.tags.map((t) => ` · #${t}`).join("")}</span>
                    </span>
                  </span>
                </div>
              </article>`).join("");

const groups = ["Himself", "Work", "Background", "Contact"];
const tagCounts = new Map();
for (const e of rich) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const navHtml = [
  `
                <button class="ui-win__nav is-on" type="button" data-filter="all" aria-pressed="true">${GROUP_ICON.All}All<em>${rich.length}</em></button>`,
  ...groups.map((g) => {
    const n = rich.filter((e) => e.group === g).length;
    return `
                <button class="ui-win__nav" type="button" data-filter="group:${g}" aria-pressed="false">${GROUP_ICON[g]}${g}<em>${n}</em></button>`;
  }),
  `
                <span class="ui-win__label">Topics</span>`,
  ...tags.map(([t, n]) => `
                <button class="ui-win__nav" type="button" data-filter="tag:${t}" aria-pressed="false"><span class="ui-win__hash" aria-hidden="true">#</span>${t[0].toUpperCase() + t.slice(1)}<em>${n}</em></button>`),
].join("");

const page = new URL("../public/index.html", import.meta.url);
let html = readFileSync(page, "utf8");
const inject = (name, body) => {
  const re = new RegExp(`(<!-- answers:${name}:start -->)[\\s\\S]*?(<!-- answers:${name}:end -->)`);
  if (!re.test(html)) throw new Error(`index.html has no answers:${name} markers`);
  html = html.replace(re, `$1${body}\n                $2`);
};
inject("nav", navHtml);
inject("rows", rowsHtml);
inject("docs", docsHtml);
writeFileSync(page, html);
console.log(`index.html panel written: ${rich.length} rows, ${groups.length} groups, ${tags.length} topics`);
