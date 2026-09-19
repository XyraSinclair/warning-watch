# Warning.watch: a digital early-warning watch

**Strategic design for discussion · Revised 5 September 2026 after Fable and Kimi consultation · Not a current threat assessment**

## The recommendation

Build a **continuous, machine-staffed digital early-warning system**: public aircraft observations, trackers, official notices, public posts, civilian infrastructure and environmental measurements, with AI agents investigating consequential changes. Aircraft are one legitimate standing instrument in a broad watch—not the whole system and not something to demote out of it.

The watch first asks **“what changed?”** Its investigators then ask:

> **Which pathway to nuclear harm is becoming more plausible, what evidence distinguishes it from the strongest alternative explanation, and which protective decision becomes better—or disappears—if we wait?**

The core product is a current situation picture: source health, newly observed changes, open incident threads, competing explanations, assigned investigations, and explicit reasons for operator attention. Briefs and protective-information views are outputs of that watch. We should notice and investigate while the operator is absent, not wait for a person to commission an essay.

**The corrected design:**

1. Observe broadly within lawful access, resource and privacy limits. Observation builds the baselines needed for validation; validation governs influence, not whether inexpensive observation may begin.
2. Maintain separate assessments of **first nuclear use, further escalation after use, and harm to a particular location**. They are not interchangeable.
3. Put automation at the beginning: standing sentinels, change triage, bounded investigation agents, source discovery, and watch handovers. Keep public strategic assertions human-owned and official warning delivery on its separately validated fast path.

The existing operational system can keep running under its present anomaly-reporting limits. This document proposes a new strategy; it does not authorize fresh purchases, change live alerts, or describe capabilities already built.

**Concrete collection register:** [https://github.com/XyraSinclair/warning-watch/blob/main/DIGITAL-SIGNAL-REGISTER.md](https://github.com/XyraSinclair/warning-watch/blob/main/DIGITAL-SIGNAL-REGISTER.md) — 12 watch families, 64 observable changes, 26 source surfaces, access/latency findings, and seven inspected ordinary responses. The 36-item atlas below supplies analytic questions; the register supplies digital instruments.

**Implementation note:** the initial collection, incident-memory, bounded
specialist/skeptic/synthesis, handover, and operator-review loops are implemented.
Their actual source coverage and limits are in [OPERATIONS.md](OPERATIONS.md).
This document remains the broader strategy; historical replay, learned routine
calendars, expanded discovery, and warning-delivery validation are not implied
by activation of that first tranche.

### What the consultations changed

Fable's central correction was that the first draft repaired the analytic layer but broke the collection layer: it delayed observation and automation until a human institution had validated them. Kimi independently proposed standing sentinels, persistent incident threads, domain investigators, a skeptical investigator, and explicit watch handovers. Both consultations were substantive design opinions, not evidence of predictive accuracy.

**Accepted:** machine watch first; aircraft remain standing; preserve event history; make the incident thread the unit of attention; investigate across source families; maintain a routine calendar and continuous source discovery.

**Not accepted literally:** Fable's near-zero-cost collection assumption and blanket baseline delay; Kimi's fixed corroborating-family rule, skeptic veto, universal six-to-twelve-month baseline prerequisite, and implication that quiet sensors establish safety. Costs and access vary. Authentic emergency instructions do not wait for a baseline or another model. Skepticism accompanies escalation rather than blocking time-critical review. Silence is informative only where a specific expected observation would actually have been visible.

The collection-management lesson is practical, not theatrical: name the important question, the observable that could answer it, the source able to see it, who investigates, and when the answer is no longer useful. The Army's public discussion of priority intelligence requirements explicitly connects broad questions to indicators, specific information requirements, collection tasks, and continuing reassessment. We adapt that organizational discipline to civilian public-source warning, not military targeting. [S14]

## 1. Define the thing we are trying to know

### Three distinct outcomes

| Outcome | The question | Why the distinction matters |
|---|---|---|
| First nuclear use in a conflict | Is a state approaching employment of a nuclear explosive weapon, including a coercive demonstration? | A frightening regional crisis is not itself evidence of a strategic attack on the United States. Peacetime testing is tracked separately. |
| Expansion after nuclear use | Will an initial use be followed by additional use, involvement of other states, or a broader exchange? | A service that cannot predict the first detonation could still help during subsequent decisions. A limited initial event is neither automatically contained nor automatically civilization-ending. |
| Location-specific harm | What credible threat, official instruction, or confirmed hazard affects this person's location? | A high geopolitical concern elsewhere does not establish imminent local blast or fallout danger. Exposure depends on an actual event and conditions, not the color of a global gauge. |

### Four decision horizons—not promised warning times

| Horizon | What we can try to contribute | Decisions it can support | Hard boundary |
|---|---|---|---|
| Strategic: weeks to days | Crisis context, posture changes, deteriorating restraints, competing explanations | Review travel, continuity arrangements, communications, and already-sensible preparedness | Long-term capability growth is not evidence of an imminent decision to use. |
| Crisis: days to hours | Verified changes in preparations, protective actions, crisis communications, and available offramps | Activate reversible continuity measures; ensure people know their local emergency arrangements | Public visibility may be delayed or absent. No general promise of advance notice. |
| Attack warning: minutes or less | Preserve and clearly relay authenticated official warnings when accessible | Follow location-relevant protective instructions | This project does not possess a missile-warning network. Public ADS-B archives are not a substitute. |
| After an event: minutes onward | Verified event status, authoritative local guidance, changes to hazard information, corrections | Shelter and follow official instructions; avoid rumor-driven movement | Do not wait for nuclear attribution to be scientifically complete before following an authentic protective warning. |

FEMA describes IPAWS as an authenticated, multipath official warning system. Ready.gov and CDC emphasize getting inside, staying inside, and staying tuned during radiation emergencies. Those are established functions and guidance, not things our statistical model should reinvent. [S4–S6]

**Design objective:** increase useful, defensible decision time—not just the number of minutes by which a post precedes a headline.

## 2. The central analytic idea: watch the loss of alternatives

A nuclear crisis is a contest of choices, perceptions, and constraints, not simply a buildup of observable hardware.

A particularly concerning *hypothesis* is a combination of:

- **Pressure:** a leadership perceives that vital objectives, its survival, or its ability to retaliate are in danger.
- **Preparation:** credible evidence indicates a change in relevant readiness or protective behavior, beyond routine activity.
- **Reduced restraint:** communications, verifiable limits, or viable political alternatives are deteriorating.
- **Time pressure or control problems:** actors believe they must decide before they can obtain adequate information.

This is a causal framework, **not a four-item checklist that must all light up**. Deliberate surprise, false warning, or unauthorized action can bypass much of it. Public evidence of one component should not be hallucinated from another: loud rhetoric does not establish readiness; readiness does not establish an attack decision; public silence does not establish loss of communications.

The stronger product is therefore a theater-specific record of **what changed in the decision environment**. For example: a verified attack affecting dual-use command infrastructure during a conventional conflict may matter more than a much larger, but routine, aviation anomaly. Acton's research explains why conventional and nuclear systems' entanglement can create inadvertent escalation risks. [S2–S3]

### The intellectual discipline

For each important fact, ask two different questions:

1. **Is the observation true?** Source provenance, authenticity, timing, independent corroboration.
2. **If true, what does it distinguish?** Does it favor nuclear preparation over an exercise, coercive signaling, conventional defense, a shared public scare, or a data error?

An observation can be completely authentic and almost useless for distinguishing these hypotheses. The U.S. government's analytic tradecraft primer explicitly separates information-quality checks, indicators, competing hypotheses, and challenges to key assumptions. [S1]

## 3. Eight pathways we must not collapse into one score

These are overlapping scenario families, not mutually exclusive probabilities or a claim to have enumerated every possible future.

| Pathway | What could lead to harm | Public observations worth investigating | What the system must admit it may miss |
|---|---|---|---|
| **P1. Deliberate strategic attack** | A leadership elects to initiate large-scale use | Crisis context, independently verified posture changes, authenticated protective actions, unusual persistence of preparations | A concealed decision using forces already ready; no necessary public “exodus.” |
| **P2. Limited use in a conventional conflict** | Leaders believe nuclear use could avert defeat, compel restraint, or change the conflict | State-specific declared stakes, military reversals, specific threats tied to events, credible changes beyond routine posture | Internal thresholds, actual orders, and whether an apparently conventional system is nuclear-armed. |
| **P3. Inadvertent escalation through entanglement** | Conventional actions are perceived to threaten nuclear forces, warning, or command functions | Credible reporting about relevant attacks and leaders' stated interpretations, reciprocal alerts, failures of clarification | Internal perceptions and the true functional consequences of an attack. Do not publish vulnerability maps. |
| **P4. False warning or dangerous misinterpretation** | An ambiguous event is treated as an attack or imminent attack | Verified official warning/correction, publicly acknowledged incident, crisis conditions that make misinterpretation dangerous | The decisive internal minutes. Public evidence may only emerge afterward. |
| **P5. Unauthorized use or loss of control** | Authority, custody, or command relationships fail | Authenticated institutional reports of a control problem, severe state disruption, credible incident reporting | Covert internal failure. Leadership drama or missing social posts are not evidence of compromised nuclear control. |
| **P6. Expansion after an initial use** | Retaliation, additional perceived threats, or failed bargaining widens use | Confirmed initial event, authoritative response statements, posture changes, communication and restraint measures | Whether private assurances are credible, and whether apparent restraint will hold. |
| **P7. Demonstration or test misread in a crisis** | A coercive demonstration, test, or exercise is misunderstood and prompts escalation | Official announcements, independently established event facts, conflicting interpretations and clarification | Warhead identity, intent, or internal interpretation from a visual track alone. |
| **P8. Nonstate nuclear or radiological attack** | Harm occurs outside the state-force pathways | Official threat/incident information and verified hazard reporting | Most preparatory activity. Treat radiological dispersal and nuclear detonation as different events, not a single “nuke” label. |

**The difficult implication:** some of the most consequential pathways may generate the fewest useful public precursors. That is a reason to build reliable preparedness and emergency-information functions, not to manufacture confidence from weaker proxies.

### Five theater lenses

Use **US/NATO–Russia** as the first deep interpretive dossier because it connects to the current project's initial audience and evidence experience—not because this document ranks current risk. Observe inherently global public sources globally where permitted; a regional expertise pilot must not artificially restrict worldwide environmental or safety feeds.

- **US/NATO–Russia:** distinguish alliance decisions, national nuclear authorities, conventional escalation, signaling, and verified crisis restraints. UK and French decisions are not interchangeable with U.S. decisions.
- **US–China:** explicitly examine conventional/nuclear ambiguity and both sides' perceptions of threats to strategic capabilities. Do not transplant a Russian event dictionary.
- **India–Pakistan:** require regional-language expertise and a separate account of crisis dynamics, declared stakes, and decision horizons.
- **Korean Peninsula:** distinguish public coercion, conventional operations, and the possibility of perceived threats to leadership survival; public insight into internal decisions may be especially limited.
- **Israel and regional escalation:** make opacity and attribution uncertainty explicit. An enrichment development, attack on a nuclear facility, radiological release, and nuclear-weapon use are different propositions.

All five need dated doctrine and capability dossiers maintained by subject-matter reviewers. Historical sources inform mechanisms; their dated force descriptions must not silently become current inventories.

## 4. The indicator atlas: 36 things to investigate, not 36 alarm switches

**Investigation priority:** A = first focused investigation; B = standing supporting observation and conditional investigation; C = context or slower research; H = observation health, never a threat vote; E = emergency/event verification. These are proposed attention priorities, not barriers to collection or measured predictive rankings.

“Source” describes a family to verify for lawful access, timeliness, and archival depth. It is not a promise of a free API. Every row is a *candidate analytic question* unless it concerns established official protective guidance.

| # | Candidate observation | Why it might matter | Strong alternative explanation / limitation | Source family; priority |
|---:|---|---|---|---|
| 1 | Confirmed direct conventional hostilities involving nuclear-armed adversaries | Establishes a relevant crisis pathway | A conventional conflict can remain conventional; it supplies context, not a nuclear decision | Attributed official accounts plus independently verified reporting; A |
| 2 | Leaders identify a specific development as threatening state or leadership survival | Reveals stated stakes and possible decision pressure | Coercive language, domestic politics, or propaganda; perceived stakes remain partly hidden | Original statements, regional-language analysis; A |
| 3 | A major conventional reversal changes the apparent options available | Could increase incentives for escalation under some doctrines | Withdrawal, negotiation, reinforcement, or acceptance of loss remain alternatives | Credible conflict assessments, not raw social-media loss counts; A |
| 4 | Credible reporting of an attack affecting dual-use warning or command functions | Opens an entanglement/misperception pathway | Misidentified facility or uncertain function/damage; do not infer successful strategic impairment | Expert-reviewed reporting and authoritative statements; A |
| 5 | A specific ultimatum is accompanied by actions and a narrowing deadline | Links declared intent to an observable sequence | Bargaining deadlines are extended or ignored; a deadline is not a countdown to use | Original statements and subsequent behavior; A |
| 6 | An authenticated, specific readiness order or official posture change | More diagnostic than generic hostile rhetoric | Signaling, precaution, or an order not implemented; exact wording and institutional authority matter | Official records and independent interpretation; A |
| 7 | Experts establish a material departure from normal strategic-force activity | May indicate preparation or survivability measures | Exercise, maintenance, defensive precaution, or visibility changes; readiness is not intent | Qualified independent assessment of public material; B |
| 8 | A declared exercise departs materially from its announced scope or conclusion | Challenges the routine-exercise explanation | Reporting lag, weather, extension for ordinary reasons | Official exercise notices, follow-up reporting, historical comparator; A |
| 9 | A nuclear-related exercise or rehearsal is confirmed | Relevant to signaling and readiness context | Often routine; exercise occurrence alone has weak diagnostic value | Original announcements, specialist context; B |
| 10 | Officials publicly report an incoming-attack concern or warning-system incident | Relevant to a fast misinterpretation pathway | False warning or misinformation; verification and corrections are urgent | Authenticated official communications; E |
| 11 | An embassy orders, rather than merely permits, departure of specified personnel or dependents | Reveals a consequential institutional protective decision | Conventional war, unrest, terrorism, health risks; different governments share information | Foreign-ministry/embassy notices with wording changes; A |
| 12 | A government publicly changes continuity arrangements in a disruptive way | Reveals preparations to maintain governance | Scheduled continuity exercise or precaution against nonnuclear hazards | Attributed official records; B |
| 13 | Authorities change shelter, civil-defense, or emergency preparedness instructions | Directly relevant to protective decisions | Routine preparedness campaign or exercise; retain geographic scope and reason | National and local emergency authorities; A/E |
| 14 | Institutions publicly activate exceptional medical or emergency staffing | Could indicate preparation for serious harm | Weather, pandemic, conventional mass casualties; low nuclear specificity | Official health/emergency announcements; B |
| 15 | Loss or suspension of a crisis communication channel is specifically confirmed | Removes a means of clarification and restraint | Public meetings can stop while private channels continue | Attributed statements about the channel itself; A |
| 16 | Negotiations or reciprocal arrangements fail in a consequential, documented way | May reduce available alternatives | Temporary bargaining tactic; some talks continue elsewhere | Diplomatic records and mediator statements; A |
| 17 | Mediators or allies undertake unusual emergency diplomacy | Can reveal concern or create a potential offramp | They may be responding to the same public reports as everyone else | Official diplomatic activity; A |
| 18 | Verified restraint: withdrawal, stand-down, restored communication, or compliance with an agreement | Evidence against a specific escalation hypothesis | Reversibility, incomplete verification, or restraint in only one domain | Original commitments plus evidence of implementation; A |
| 19 | Authorities issue significant airspace or maritime restrictions | Reveals an operational or protective change | Conventional conflict, launch/test safety, weather, or exercise | Civil aviation/maritime notices with stated grounds; B |
| 20 | Multiple carriers independently alter service to a region | Consequential private risk assessment | Common regulator order, weather, insurance restriction, or public news | Carrier and regulator announcements; B |
| 21 | Aggregate relevant aviation activity changes beyond matched routine patterns | Can open an investigation before a crisis is recognized, or corroborate another thread | Holidays, exercises, maintenance, coverage changes; a flight does not reveal payload or mission | Existing aviation observation with explicit coverage; B |
| 22 | Officially acknowledged government departures differ from stated normal operations | Could support a continuity or protection hypothesis | Scheduled travel, secrecy about routine movements, defensive signaling | Institutional public records; no surveillance of families; B |
| 23 | Public transport or essential services change under an emergency directive | Relevant to both revealed protection and users' options | Local accident, weather, labor action, routine security | Responsible authorities; B/E |
| 24 | Nuclear rhetoric becomes more specific about conditions, authority, or contemplated consequences | Improves the definition of a threat claim | Recycled language, mistranslation, unauthorized speaker, strategic ambiguity | Original text/audio and translation review; A |
| 25 | Official doctrine or force-policy changes alter the background framework | Changes which future observations should matter | Slow capability/policy change is not imminent intent; declaratory policy is not a mechanical trigger | Dated official publications and specialist interpretation; C |
| 26 | Legal mobilization or emergency powers materially change institutional options | Enables unusual actions or signals preparedness | Conventional conflict or domestic politics | Official gazettes and legislation; B |
| 27 | Insurance, freight, financial markets, or forecasts move sharply | May locate attention and perceived exposure | They often reprice the same public news; manipulation, liquidity, and risk premia confound interpretation | Market/industry notices with provenance; C |
| 28 | Publicly documented requisitioning or emergency procurement appears | Reveals resource commitment rather than speech alone | Conventional mobilization, disaster response; publication may be far too late | Public procurement/emergency records; C |
| 29 | A previously functioning source becomes unavailable | Identifies a loss of knowledge | Technical fault, commercial change, censorship, outage; motive not established | Direct observation of source availability; H |
| 30 | Coverage, observation cadence, or publication delay changes | Changes what non-observation can tell us | Ordinary service drift; apparent activity may be a measurement change | Feed metadata and independently checked observation history; H |
| 31 | Many reports reduce to one original claim, image, or event | Prevents false corroboration | Repetition can mimic consensus without adding evidence | Origin tracing and dated original material; H |
| 32 | A source retracts a claim or a verified contradiction emerges | Can reverse the premise of an assessment | Correction may be incomplete or disputed; propagate uncertainty explicitly | Original correction and independently supported contrary evidence; H |
| 33 | An authenticated official emergency warning applies to a location | Immediately changes the user's decision context | Drills, tests, expiry, and geographic mismatch must be distinguished; do not block a genuine alert for our own analysis | Official alerting authority, preserved wording; E |
| 34 | Independently established physical evidence indicates a major explosion | Supports event verification, not advance prediction | Conventional explosion, earthquake, unrelated footage; several modalities may still not establish nuclear origin | Competent scientific agencies and verified reporting; E |
| 35 | Authorities confirm a radiological hazard or issue area-specific guidance | Supports protective action without requiring certainty about weapon attribution | Power-plant accident, industrial release, measurement problem; risk is local and time-dependent | Radiation/public-health/emergency agencies; E |
| 36 | After confirmed use, further actions and restraint measures change | Updates the pathway to additional use and broadening harm | Retaliatory rhetoric is not a launch; event attribution and sequence can be wrong | Official and independently verified event reporting; A/E |

### Broad collection; differentiated influence

Start with the existing aircraft instrument alongside civil aviation notices, official advisory/document changes, public-post and multilingual news discovery, weather/space-weather context, and event-verification feeds. Add radiation, maritime, civilian infrastructure, procurement and additional regional sources as their actual access contracts are established. The concrete register identifies what is sampled, merely documented, and still unresolved.

Maintain separate permissions for **observation**, **opening an internal investigation**, **changing operator attention**, and **making a public assertion**. A noisy source can be worth recording because it cues a useful inquiry or explains a public scare. That does not make it a reliable nuclear predictor.

Record public attention, search interest and market reactions as context where practical; do not discard them merely because they are downstream of news. Their timing can reveal the common cause behind an apparent multi-source convergence. Do not turn pizza orders, single “Doomsday Plane” sightings, anonymous “DEFCON” labels or retail iodine demand into nuclear-warning triggers.

No collection of private family movements, sensitive tactical military locations, intercepted communications, or access obtained by circumvention. Breadth means more legitimate observational mechanisms, not invasive collection.

Two useful reality checks: NATO describes Steadfast Noon as an annual routine exercise without live weapons, while NAVAIR describes the E-6B as part of an ongoing operational and training enterprise. Seeing either is not equivalent to observing an attack decision. Authenticate the event and then ask what, if anything, differs from its ordinary role. [S11–S12]

## 5. Six analytic disciplines implemented by the watch

### A. A live book of competing explanations

Every consequential cluster gets at least these candidates: **routine activity; conventional preparation/defense; coercive nuclear signaling; preparations consistent with actual nuclear use; misperception/control failure; measurement or information artifact**. These can coexist; the question is which explains which facts.

Do not count supporting indicators. Record what each explanation predicts next, what would contradict it, and what information we lack. Absence only counts against an explanation if the event would probably have been visible to a functioning source in time. Otherwise the correct state is “unknown.”

**Why this is better:** it makes the system curious rather than merely reactive. An alert becomes a reason to resolve a question, not permission to tell a story.

### B. Separate three kinds of independence

- **Reporting independence:** are two articles repeating one government statement or social post?
- **Measurement independence:** are two observations generated by different sensors/providers?
- **Causal explanation:** are several actions consequences of one order, exercise, weather event, or public scare? They may establish the extent of a response without supplying independent evidence of its motive.

Three aviation cohorts from one archive are not three independent intelligence streams. An embassy notice, carrier cancellation, and market move may all be downstream of the same public announcement. Independently confirming that an event occurred is also not the same as independently confirming nuclear intent.

**Why this is better:** it prevents a cascade of copies from turning one ambiguous fact into apparent certainty.

### C. Maintain an observation model beside every threat hypothesis

Track whether we could see the proposed precursor at all: geographic coverage, eligibility, ordinary visibility, event time, first public availability, our observation time, verification time, and subsequent corrections. “No unusual aircraft observed” must never become “no unusual state behavior.”

Source loss lowers knowledge. It does not automatically raise or lower assessed danger. If independent evidence suggests deliberate concealment, record *that evidence* rather than deriving motive from an outage.

**Why this is better:** the system can say “we are blind here” without converting blindness into either reassurance or panic.

### D. Study revealed protection using counterfactuals

The promising question is not “are elites leaving?” but **“which institutions accepted unusual costs to protect people or preserve operations, compared with institutions facing similar routine conditions?”** Start with public institutional decisions, not passenger identities.

Compare the institution with its own previous crises and routine calendar; compare similar institutions under the same weather, security, and public-news conditions. Preserve the information timeline: a protective decision before a public shock and one after it are different observations, but an early decision still does not establish privileged knowledge of nuclear intent.

**Why this is better:** it tests an informational advantage instead of assuming one. Comparator divergence is a research hypothesis, not a magic causal identifier.

### E. Track reversibility and available decision time

Ask which changes are cheap signals and which materially reduce the ability to reverse course. Track independently verified implementation, persistence, geographic breadth, and responses—not just announcements. Record restraining developments with the same care as threatening ones.

Do not invent an “irreversibility score.” Some reversible signals can be dangerous, and some costly defensive preparations can reduce risk. The value is the explicit reasoning about choices, not a new scalar.

**Why this is better:** it focuses attention on changes that could alter the future rather than the most visually dramatic content.

### F. Choose the next question by decision value

Given an ambiguous cluster, ask: **what obtainable fact would most change the recommended action before its deadline?** Verifying whether an embassy notice is mandatory and new may be more useful than collecting another thousand aircraft positions.

Use a simple collection card: current uncertainty; competing answers; source that could discriminate; expected availability; decision affected; expiry time. Prefer independent disconfirmation over another source likely to repeat the same claim.

**Why this is better:** intelligence collection becomes a sequence of purposeful questions. More data is not automatically more warning.

## 6. What the user should actually see

The operator opens a **live incident board**, not just a global gauge or published essay: what changed, what is being investigated, who owns each question, what evidence remains unresolved, and which sources are healthy or blind. Theater assessments and the separate local-action panel are derived views.

Each assessment carries:

- **What changed:** concrete event, location, event time, first-public time, and source.
- **Our judgment:** the pathway affected and the strongest alternative explanation.
- **Confidence and visibility:** quality of support, disagreements, and what we cannot currently observe.
- **What would change the judgment:** named counterevidence and the next discriminating question.
- **Decision relevance:** action options, reversibility, and who the assessment applies to.
- **Next review:** an expiry/reassessment time, with corrections linked to the original judgment.

Do not conflate confidence with danger. A severe but poorly observed possibility is different from a well-established, low-specificity posture change. Do not attach a numerical nuclear-war probability or a “once in N years” label merely because a flight statistic has a rare tail.

### Example: entirely hypothetical, not today's situation

> **Heightened regional concern; nuclear preparation not established.** An authenticated departure order and an exercise extension were published during an active conventional crisis. The carrier cancellations add no independent evidence: they follow the same airspace restriction. Conventional defense remains a strong explanation. We have no verified change in nuclear employment status. The next useful check is whether the exercise concludes as revised and whether announced talks occur. Organizations with local personnel should review their existing continuity and travel plans. There is no location-specific emergency instruction in this assessment.

The intelligence is in the distinctions and the next question—not in making the paragraph sound frightening.

### A decision ladder, not a doom ladder

| Decision class | Appropriate output | Governance |
|---|---|---|
| Routine preparedness | Durable local preparation and official-alert enrollment information | Available irrespective of today's risk score |
| Analyst attention | A new, relevant, verified change or unresolved contradiction | Can be machine-queued; requires evidence lineage |
| Reversible organizational readiness | A reviewed assessment explaining why an existing plan merits activation | Human judgment; organization chooses action under its own responsibilities |
| Public strategic advisory | A consequential change with reviewed reasoning, alternatives, and clear applicability | Named editorial responsibility and independent review; never imply an official attack warning |
| Official emergency instruction | Clearly attributed, location- and time-relevant warning with original wording and updates | Do not make delivery contingent on our model or editorial availability; validate the issuing authority and distinguish tests/cancellations |

In an actual radiation emergency, the action surface should prioritize official guidance and nearby sheltering—not a speculative road-evacuation recommendation derived from aircraft or market data. Preparations for relocation well before an emergency are a separate decision. [S4–S6]

Keep protective guidance usable even when there was no strategic warning: accessible language, a short offline copy, and preparation for loss of power or connectivity. The human chain is reception → attention → comprehension → feasible action, not merely “push delivered.” Protective-action research identifies those predecision processes and the situational constraints on response. A notice that reaches someone but cannot be understood or acted on has not achieved the mission. [S13]

## 7. How this earns trust without pretending we have nuclear-war training labels

### A warning case library, not a tuned replay window

Construct chronological case files from both crises and matched non-events. Each fact gets **event time, first-public availability, and later archival revelation**. Assessments at time T may use only what was publicly available by T. Declassified evidence belongs in the explanation of what was hidden, not smuggled into the simulated forecaster's input.

The case roster should include the Cuban Missile Crisis, 1973, 1979/1980 false warnings, Able Archer 1983, the 1995 Norwegian research rocket, a South Asian crisis, the 2017 Korean crisis, and recent nuclear coercion during conventional conflict. Also include routine exercises, threatening rhetoric without escalatory behavior, large aviation holidays, earthquakes/industrial accidents, and deliberate disinformation. These are a proposed research roster, not equally documented near-launch cases.

**Three historical findings already constrain this design:**

| Historical finding | Design consequence |
|---|---|
| U.S. imagery established the Cuban missile deployment on 14–15 October 1962; the public disclosure came on 22 October. Part of the resolution remained secret. [S8] | A public-source system cannot claim the government's discovery date as its available warning time, or infer the absence of diplomacy from absent public detail. |
| During Able Archer 1983, even U.S. intelligence lacked the later assembled picture of the Soviet response. The official retrospective records that the extent of some alerts became known only after the exercise. [S9] | An announced exercise is neither automatically harmless nor proof of preparation for attack. The useful question is the other side's interpretation and response, often poorly visible. |
| The 1979–1980 false warnings produced actual precautionary activity. Other warning sensors contradicted the erroneous information. [S10] | Even genuine military reactions can be downstream of a false premise. Physical activity does not settle whether the underlying threat is real; independent checks matter. |

These are evidence about mechanisms and observability, not three successful retrospective predictions by this project.

Separate three judgments:

1. **Could the service recognize the evidence correctly and in time?**
2. **Would the assessment improve a decision relative to ordinary official/news awareness?**
3. **What actually happened?** No nuclear use does not prove a warning was foolish; a plausible story about a near miss does not prove it was correct.

### Measure things we can defend

- Authenticity and attribution errors; duplicate-origin inflation; mistranslations and correction propagation.
- Timeliness measured from first public availability, not from an event timestamp unknowable at the time.
- Analyst false escalations per observed case-period, with the denominator and uncertainty shown—not just rounded permitted counts.
- Performance on ordinary exercises and conventional crises, not only famous near misses.
- Whether a second evidence family changes the assessment when the first is removed.
- Whether users distinguish strategic concern from an immediate local instruction.
- Whether recommended actions remain reasonable across plausible competing explanations.
- Detection of source blindness without false reassurance or invented danger.

For tractable intermediate outcomes—an exercise ending, a meeting occurring, a departure notice changing—publish genuinely prospective, time-bounded forecasts and score them. This helps audit process quality; it **does not validate a nuclear-use probability model**. Any probability judgments about nuclear use should be separately elicited, explicit about priors and uncertainty, and never learned by relabeling aviation anomalies as war.

### Falsification gates

Reject a feature if it adds no incremental decision value beyond a strong official/news baseline; if its apparent lead vanishes when first-public times are respected; if ordinary exercises explain its performance; if source removal collapses supposed corroboration; or if it requires an unavailable source to be useful.

Do not retune on each famous case until the story looks good. Keep untouched cases and prospective observations. A small historical sample cannot establish universal sensitivity to a rare, changing geopolitical event.

### Adversarial design walkthrough

This is a reasoning exercise against the proposed rules, not an empirical validation of a built system.

| Challenge | Required behavior |
|---|---|
| Exercise, tankers, command aircraft, and airspace notices all appear together | Establish the exercise as the common cause; investigate genuinely unexplained deviations rather than adding four threat votes. |
| An embassy notice is followed by airline cancellations and market alarm | Establish temporal and source dependencies; separate the institutional decision from its public consequences. |
| Activity looks quiet because a source stopped reporting | Display reduced visibility; neither reassure nor infer deliberate concealment without additional evidence. |
| A state denies preparation while credible independent observations contradict it | Preserve the contradiction. An authentic official statement proves what was said, not that its factual claim is true. |
| A real surprise occurs without visible precursor | Do not imply that a quiet dashboard meant safety; keep official warnings and prepositioned protective guidance independent of the strategic score. |
| An authenticated emergency alert arrives while no analyst is on duty | Relay it with its authority and scope through the validated emergency path; do not await discretionary geopolitical review. |
| An alert is withdrawn or an image is proven old | Link and propagate the correction; retract dependent claims rather than merely allowing their score to decay. |
| Our own publication causes a burst of reports and market attention | Recognize the feedback loop and exclude descendants of our claim as independent support. Never monetize alarm volume as success. |

The design therefore rejects both extremes: “trust every official claim” and “official calm is evidence of concealment.” Both can become unfalsifiable. Responsibility is to preserve evidence and uncertainty, not to favor whichever narrative is more dramatic.

## 8. The execution plan: observation and agents first

These are concrete design work packages, not a claim that new collectors or agents were deployed in this planning session. Keep existing live behavior unchanged until its migration is reviewed and exercised.

### The watch loop

**Standing observation → change triage → incident thread → bounded investigations → revised situation picture → operator attention / approved outputs → retasking.**

1. **Source registry and evidence history.** Each source records its mechanism, lawful access, cost, geography/language, documented and measured delay, health, baseline maturity, ordinary confounds, and upstream dependencies. Each observation retains event time when known, source publication time, our observation time, original locator, relevant evidence, and later amendments. Unknown times remain unknown; future or inconsistent clocks are flagged.
2. **Cheap standing sentinels.** Use routine numeric comparisons, document-change detection and filtered event streams. Small-model extraction can help with text; expensive reasoning is reserved for actual questions. Sentinels report source changes and health, not unsupported world conclusions. They continue accumulating normal behavior during quiet periods.
3. **Change triage.** Group related observations by event, time and civilian geographic scope; compare with routine schedules and source health. Either retain as background, update an existing thread, or open a new one. Novel credible single-source evidence may warrant review; a universal two- or three-family gate would miss important events.
4. **Investigation tickets.** Assign a named uncertainty, relevant evidence, rival explanations, authorized sources, deadline, bounded work allowance and stop condition. A ticket asks “is this an actual newly ordered departure?” rather than “research nuclear war.” Several independent questions can run concurrently; agents do not create unlimited descendants.
5. **Incident memory and synthesis.** Findings update one versioned thread: facts, uncertainties, dependencies, corrections, plausible explanations, discriminating next observations and attention state. Merge duplicates without losing provenance; split mistakenly joined incidents; close with a reason, not silent score decay.
6. **Continuous collection management.** New findings change the questions, not merely the score. Increase relevant watch attention within configured limits; restore ordinary cadence when justified. Discovery and maintenance have reserved capacity so one dramatic story cannot blind the rest of the world.

### The machine watch staff

These are roles, not a requirement to keep eight large models continuously running. The scheduler invokes the relevant role on a change, deadline or scheduled review.

| Role | Trigger | Required result |
|---|---|---|
| Watch supervisor | New changes, overdue work, scheduled handover | Deduplicated incident queue; assigned priorities; explicit unattended/coverage state |
| Source/domain investigator | A source-specific uncertainty | Verified observation, measurement limitations, ordinary comparators |
| Original-source and language investigator | An attributed claim or material textual change | Original passage, correct speaker, substantive delta, translation uncertainty |
| Chronology/provenance investigator | Apparently new or widely repeated material | First-public history, original versus copies, corrections and dependence |
| Skeptical investigator | A consequential hypothesis or disputed escalation | Strongest supported rival, assigned disconfirmation checks, unresolved contradictions |
| Synthesis investigator | Material findings change an incident | What changed in the assessment, why it matters, next useful question |
| Discovery and coverage investigator | Scheduled family/region rotation or explicit collection gap | New source contract or documented gap; no unapproved spend or account creation |
| Watch maintenance/handover | Stale sources, completed shifts, expired tickets | Health failures, open questions, next deadlines, reasons for closure or continued watch |

Models are not witnesses. Fable, Kimi and another model agreeing about one article still yield one article's evidence. Independent investigators should receive original evidence and their assigned question before seeing another model's conclusion when that reduces anchoring.

### A complete investigation ticket

**Hypothetical question:** Did an embassy change from optional departure to ordered departure, and does that represent new information?

- **Owner and deadline:** one institutions investigator; complete before the next incident review, or return unresolved with the missing prerequisite.
- **Evidence:** original current notice, retained earlier version, source publication history, and the reports that triggered attention.
- **Rivals:** substantive new order; paraphrase of an old order; wording-only edit; nonnuclear local hazard; erroneous or forged report.
- **Required checks:** establish actual text and authority; compare versions and first-public time; identify stated reason; check whether allegedly corroborating carriers are obeying the same restriction.
- **Return:** supported finding or unresolved status, citations, contradiction, source limits, and the next discriminating question. No private correspondence, access changes or open-ended further tasking.

The ticket's question is narrow; its parent incident can still synthesize aircraft, advisories, posts and physical observations. A source may answer a factual question without answering the larger nuclear-intent question.

### Three hypothetical watch sequences

| Sequence | What the watch does | Useful result |
|---|---|---|
| Aircraft anomaly + new civil airspace notice + local reports | Open one thread. Aviation investigator checks actual samples and weather; notice investigator establishes the instruction; provenance investigator separates original reports from copies; skeptic checks a scheduled exercise or service fault. | Either a documented routine explanation, or an unresolved development worth operator review. No automatic nuclear label. |
| Credible institutional change with quiet aircraft data | Authenticate the changed order and its chronology immediately. Check aviation coverage, but do not wait for a flight surge or treat its absence as a veto. Task relevant official and local sources. | The system can notice a consequential precursor through institutions even when physical telemetry contributes little. |
| Viral explosion claim + questionable sensor reading | Investigate the media's age and origin; check the actual sensor and its quality; consult competent event and emergency sources. Any authentic applicable protective warning follows the separate fast path. | Fast correction if false; timely attention if unresolved; protective information is not delayed pending scientific attribution. |

For de-escalation, task evidence of implemented restoration, corrected claims and resumed services. Quiet posting or a lost sensor is not enough. Close or downgrade only the hypotheses those observations actually address.

### Operator attention and agent limits

- **Background:** routine observations and measured source health; no notification per item.
- **Investigating:** a visible incident with agents working and a next-review time.
- **Review needed:** a materially consequential, credible change, unresolved contradiction, deadline or visibility loss affecting an active incident. State why attention is justified and what remains uncertain.
- **Urgent review:** time-sensitive evidence could materially affect protective or continuity decisions. Show competing explanations alongside the notification; a skeptic cannot indefinitely veto attention.
- **Official warning:** the independently validated authority/jurisdiction path preserves actual/test, issue/effective/expiry, update and cancellation semantics. It does not wait for speculative analysis or a human shift change.

Every ticket has a work bound, deadline, owner and completion reason. Queue limits, per-source limits, and reserved coverage capacity prevent recursive agent sprawl. Repeated evidence updates an existing thread. Tool/model failures produce unresolved work, not fabricated success. Agents cannot buy data, create credentials, contact people, change public risk policy or publish a new strategic assertion on their own.

### The build order

| Work package | Concrete deliverable | Exit condition |
|---|---|---|
| **1. Observation foundation and first source tranche** | Source registry, retained evidence chronology, existing aviation as an input, several independent public source families | Ordinary responses, substantive changes, stale data and corrections are distinguishable; baseline accumulation begins |
| **2. Requirements and normality map, concurrently** | Initial decision contract; theater questions; routine schedules; source coverage matrix | Each priority question has a collection route or explicit visibility gap; this does not block broad passive observation |
| **3. Triage, incident threads and bounded agents** | Named investigations, source checks, rivals, dependence, synthesis and handover | A hypothetical or historical incident can move from observation to explained attention without unsupported facts or uncontrolled spawning |
| **4. Replay and shadow watch** | Time-fenced historical exercise plus prospective machine-opened threads reviewed by the operator | Useful discoveries, missed changes, corrections, latency and attention burden are measured; no cherry-picked nuclear-prediction claim |
| **5. Approved output surfaces** | Current situation picture, operator attention, reviewed strategic output, separately validated official-warning route | Actual surface and delivery paths exercised under the repository's review floor; current and unknown states are clearly distinguished |
| **6. Continuing discovery and earned influence** | Family/region/language sweeps, measured source histories, refined tasking | Added sources contribute new observations or useful disconfirmation rather than duplicate workload |

### Resource model

Continuous machines and bounded human editorial availability are compatible. A single operator cannot personally read every feed, but does not need to: machine observation, triage, investigation and handover are the point. Human expertise and accountability remain necessary for consequential public judgments, source-policy changes and review of failure cases.

Do not assume every feed is free, stable or cheap. Avoid a full model call per post, a complete social-web archive, or permanent large-model workers. Use filtered observations and change-driven investigations; retain enough original evidence for review under explicit source and retention terms. Record processing cost, open work, source failures and operator burden so breadth does not silently erode reliability.

## 9. Six questions that genuinely determine the product

The product direction is settled for this design: a continuous digital watch with agentic investigation. The following defaults govern its outputs and responsibilities; they are not a request to choose a newsletter instead.

1. **Whose decision are we improving first?** Default: the system operator and serious public readers, including households and continuity leads. They share an evidence picture but need different action and detail surfaces.
2. **Where must the advice be actionable?** Default: U.S. civilian protective-information context, one deep US/NATO–Russia dossier, global context without pretending equal coverage.
3. **Which decision earns the earliest warning?** Default: preserving travel, staffing, and communications options before a crisis—not claiming to beat military launch detection.
4. **What burden of false alarm is acceptable for each action?** Default: relatively sensitive internal review; much stricter public strategic assertions; official protective alerts retain their own authority. “No false alarms” is not a usable single requirement.
5. **Who is accountable for a consequential public judgment?** Default: continuous machine watch, human-owned public strategic assertions, explicit editorial availability and corrections. Machines can investigate while the editor is absent.
6. **What would make this project worth doing even if first-use prediction remains weak?** Default: better crisis understanding, less misinformation, preservation of low-regret choices, and reliable access to protective guidance. If only precise launch prediction counts, the current public-source approach cannot honestly promise the outcome.

**No false flagship choice:** strategic interpretation, digital sensing and protective information are parts of one early-warning system with different authority boundaries. The flagship is the watch itself.

### Elicit specialist knowledge before assigning weights

Use the same short packet independently with a nuclear-policy specialist, a regional-language analyst, a warning-methodology historian, and an emergency-management practitioner. Then reconcile disagreements in writing. These are proposed research conversations; none has been sent or arranged.

1. **Specify the event:** what exactly counts as first use, and what would change its relevance to the initial audience?
2. **Name the path:** which mechanism could produce that event without the preparations our current theory expects?
3. **Predict observations under both stories:** what would you expect to see under nuclear preparation *and* under an ordinary exercise or conventional crisis?
4. **Name the missing discriminator:** which fact would most change your judgment, and could a public service actually obtain it before the decision deadline?
5. **Challenge apparent independence:** which observations share an order, sensor, press source, or public shock?
6. **Make confidence falsifiable:** what observation would make you reverse your assessment, and what absence would carry no information?
7. **Specify a useful action:** what can a person or institution do differently, with what cost of being wrong and what risk from waiting?
8. **Audit blind spots:** which historical episode makes your method look bad, which uncertainties are irreducible, and where is your expertise weakest?

If numerical judgments are elicited, obtain individual ranges and rationales before showing others' estimates. Separate uncertainty about the fact, the mechanism, and the outcome. Preserve disagreement instead of averaging away different assumptions. No numerical weights enter production merely because several models or experts repeat them.

## 10. Bottom line

The ambitious version is a persistent digital watch: aircraft, public posts, official acts, operational notices, infrastructure and physical measurements; cheap observation; agents that investigate in parallel; one evolving evidence picture; specific reasons to pay attention.

**Observe broadly. Investigate changes. Make influence earn its place.** Keep the aircraft instrument, add the missing digital senses, and make the analytic disciplines run continuously instead of leaving them in a memo.

## Sources and scope

Read on 5 September 2026. Sources support the stated analytic methods, escalation mechanisms, monitoring limits, collection-management discipline and protective guidance. The indicator atlas, digital register, priorities, agent architecture and work packages are design proposals; no cited source validates their predictive performance. This document makes no assessment of present nuclear-war likelihood.

- **S1 — U.S. Government, A Tradecraft Primer: Structured Analytic Techniques for Improving Intelligence Analysis (March 2009).** Key-assumptions checks, quality of information, indicators, competing hypotheses, contrarian and imaginative techniques. https://www.cia.gov/resources/csi/static/Tradecraft-Primer-apr09.pdf
- **S2 — James M. Acton, Escalation through Entanglement (International Security, Summer 2018).** Peer-reviewed mechanism linking command-and-control vulnerability and inadvertent escalation; cited here for the mechanism, not a current risk estimate. https://www.belfercenter.org/publication/escalation-through-entanglement-how-vulnerability-command-and-control-systems-raises
- **S3 — James M. Acton, Is It a Nuke? Pre-Launch Ambiguity and Inadvertent Escalation (Carnegie, April 2020).** Delivery-system ambiguity, false positives/negatives, and historical examples; dated capability descriptions are not current inventories. https://assets.carnegieendowment.org/static/files/Acton_NukeorNot_final.pdf
- **S4 — FEMA, Integrated Public Alert & Warning System.** Official authenticated warning and multiple delivery pathways; access for a private application requires separate verification. https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system
- **S5 — Ready.gov, Radiation Emergencies.** Preparation, sheltering, official instructions, and exceptions when a shelter itself presents an immediate hazard. https://www.ready.gov/radiation
- **S6 — CDC, What to Do: Get Inside.** Radiation-emergency shelter guidance; not a justification for issuing an unsupported nuclear warning. https://www.cdc.gov/radiation-emergencies/response/get-inside.html
- **S7 — CTBTO, International Data Centre.** Waveform evidence does not by itself reliably distinguish a nuclear explosion; products are supplied to Member States, and radionuclide confirmation can be delayed. This is event verification, not a public pre-launch feed. https://www.ctbto.org/our-work/international-data-centre
- **S8 — U.S. Office of the Historian, Cuban Missile Crisis retrospective.** Discovery/public-disclosure chronology and the private component of the settlement; retired historical series, not a current feed. https://history.state.gov/milestones/1961-1968/cuban-missile-crisis
- **S9 — Foreign Relations of the United States, 1981–1988, Volume IV, Document 135.** Official retrospective on Able Archer, including the limits of contemporaneous knowledge and later PFIAB assessment. https://history.state.gov/historicaldocuments/frus1981-88v04/d135
- **S10 — National Security Archive, False Warnings of Soviet Missile Attacks Put U.S. Forces on Alert in 1979–1980 (2020).** Primary-document collection and editorial reconstruction; identifies uncertainty in retrospective accounts. https://nsarchive.gwu.edu/briefing-book/nuclear-vault/2020-03-16/false-warnings-soviet-missile-attacks-during-1979-80-led-alert-actions-us-strategic-forces
- **S11 — NATO, Nuclear deterrence policy and forces (updated May 2026).** Official account of separate national decision centers, dual-capable aircraft, and the routine exercise baseline; statements of policy, not independent evidence about intentions. https://www.nato.int/en/what-we-do/deterrence-and-defence/natos-nuclear-deterrence-policy-and-forces
- **S12 — NAVAIR, E-6B Mercury.** Official mission and training context; not evidence of the mission of a particular flight. https://www.navair.navy.mil/product/E-6B-Mercury
- **S13 — Lindell and Perry, The Protective Action Decision Model (Risk Analysis, 2012).** Reception, attention, comprehension, perceptions, and practical constraints on protective behavior; not a nuclear-war forecasting model. https://pubmed.ncbi.nlm.nih.gov/21689129/
- **S14 — U.S. Army Center for Army Lessons Learned, Priority Intelligence Requirement Management in Divisions and Corps (May 2025).** Public professional discussion connecting requirements, indicators, specific information requirements, collection management and ongoing reassessment. Used for organizational discipline, not tactical collection. https://www.army.mil/article/285410/priority_intelligence_requirement_management_in_divisions_and_corps

Research coverage: the first pass examined historical warning, strategic posture and protective decisions. The corrected pass added the explicitly requested Fable consultation, a substantive Kimi K3 consultation, three independent source-discovery audits, primary-source checks and seven bounded public response samples. Kimi's first lower-cap call returned no visible answer and contributes no findings. Suggestions were screened and several access/latency claims corrected against actual sources. The historical case library, global source enrollment and agent implementation remain work packages, not completed capabilities. No new production behavior, private intelligence access, commercial imagery subscription, or 24/7 human staffing is claimed.
