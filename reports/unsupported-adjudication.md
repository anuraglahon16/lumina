# Adjudication: are the unsupported sentences unsupported?

> Human labels on every sentence the lexical validator called unsupported.
> The 0.5 overlap score is the thing being checked here, not the authority.

- from: 2026-09-18T00:03:31.556Z (granular arm)
- sentences: 35, adjudicated 35, undecided 0

## Distribution

| adjudication | sentences | share |
|---|---:|---:|
| evidence_gap_disclosure | 26 | 74% |
| fully_supported_paraphrase | 8 | 23% |
| partially_supported | 1 | 3% |
| **total adjudicated** | **35** | |

## What that means for the metric

| | rate |
|---|---:|
| lexical validator false negatives, among sentences it flagged | 23% |
| genuinely unsupported or overstated | 0% |
| measurement artifacts that should never have been in the denominator | 74% |

Evidence-gap disclosures found: 7 by the absence patterns during the run, 
26 more only by reading. All of them are required by the prompt to carry
no citation, and all of them were counted against completeness.

| completeness | value |
|---|---:|
| as measured | 0.806 |
| corrected, disclosures out of the denominator (437 sentences) | **0.867** |
| ceiling from citation attachment alone, artifacts excluded | 1.000 |
| if genuinely unsupported sentences were not written | 1.000 |

## Are the refusals true?

19 of 26 evidence-gap disclosures are not true of the evidence the answer had.

| question | refusal accurate | what the passages actually contain |
|---|---|---|
| How does write amplification arise in so | yes | nothing on the topic |
| What does the borrow checker in Rust pre | **no** | Prevents memory errors (use-after-free, dangling pointers, etc.) at compile time |
| What does TLS certificate pinning protec | **no** | Certificate pinning effectively breaks this attack lifecycle because the application will reject any certifica |
| What causes head-of-line blocking in HTT | **no** | HTTP/3 runs over QUIC, which provides independent streams at the transport layer, eliminating both TCP and HTT |

A disclosure is only exempt from citation because it reports a real gap.
One that reports a gap the evidence does not have is not a disclosure at
all: it is an answer refusing material it was given, and it costs the
reader the answer they asked for.

## Second review

12 entries carried a second independent review; 1 disagreed.

| id | first | second | sentence |
|---|---|---|---|
| u29 | partially_supported | fully_supported_paraphrase | The theorem's core insight on this point is that network partitioning  |

Disagreements are reported, not resolved by picking one. A sentence two
readings place differently is evidence about the category boundary.

## Every sentence

### evidence_gap_disclosure

**u02** (lexical 0) — I cannot answer this question from the available evidence.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u03** (lexical 0.267) — To answer your question properly, I would need evidence that explains the technical aspects of how SSDs handle write operations and the factors that lead to write amplification.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u04** (lexical 0.35) — The document focuses on market size projections, regional adoption patterns, and general growth drivers for the SSD market, but does not address the technical mechanisms of write amplification or how 
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u05** (lexical 0.19) — To answer your question properly, I would need evidence that covers the technical aspects of SSD operation, such as how garbage collection, wear leveling, and flash memory cell management contribute t
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u06** (lexical 0) — I cannot answer this question from the evidence provided.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u07** (lexical 0.273) — It does not discuss the technical mechanisms of solid state drives, including write amplification or how it arises in SSDs.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u08** (lexical 0.167) — To answer your question properly, I would need evidence that covers the internal operations and technical characteristics of SSD technology.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u09** (lexical 0.294) — The material indicates the borrow checker is fundamental to Rust's memory safety model but cuts off before fully elaborating on the particular compile-time violations it blocks.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u10** (lexical 0.421) — However, the article excerpt cuts off before covering the specific compile-time protections the borrow checker enforces, such as preventing use-after-free errors, data races, or double-free issues.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u11** (lexical 0.412) — It establishes that the borrow checker is fundamental to Rust's memory safety guarantees, but a complete answer about what it prevents would require additional information beyond what is available her
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u13** (lexical 0.167) — The evidence provided is a table of contents or index from a Palo Alto Networks article on certificate pinning, but it does not contain the actual content explaining what certificate pinning protects 
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u14** (lexical 0.2) — To answer your question properly, I would need the full article content that defines the threats pinning mitigates and the operational or security costs it introduces.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u15** (lexical 0) — I don't have sufficient evidence to answer your question.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u16** (lexical 0.238) — The evidence provided is a table of contents from a Palo Alto Networks resource on certificate pinning, but it contains only section headings without the actual content that would explain what TLS cer
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u17** (lexical 0.2) — To answer your question properly, I would need the full text of the sections titled "What Is Certificate Pinning?
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u18** (lexical 0) — I don't have sufficient detail in the evidence to answer your question.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u19** (lexical 0.304) — The evidence block contains only a table of contents from a Palo Alto Networks resource on certificate pinning, listing section headings such as "Risks and Limitations of Certificate Pinning" and "Cer
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u20** (lexical 0.385) — To answer what TLS certificate pinning protects against and what it breaks, I would need the full text of those sections, which is not provided here.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u21** (lexical 0.364) — The evidence provided discusses what causes head-of-line blocking in HTTP/2 but does not contain information about HTTP/3 or why it avoids this problem.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u22** (lexical 0.167) — However, the evidence only mentions HTTP/3 in passing as a mitigation option and does not explain the technical differences in how HTTP/3 addresses these issues.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u23** (lexical 0.3) — To answer why HTTP/3 avoids these blocking problems, I would need evidence that covers HTTP/3's design.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u24** (lexical 0.3) — The evidence provided discusses head-of-line blocking in HTTP/2 but does not contain information about HTTP/3 or how it differs in this regard.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u25** (lexical 0.455) — To answer what specifically causes HoL blocking in HTTP/2 but not HTTP/3, I would need evidence that covers HTTP/3's design.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u26** (lexical 0.2) — I cannot answer this question from the provided evidence.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u27** (lexical 0.3) — The evidence mentions HTTP/3 only in passing as a mitigation option ("moving to HTTP/3") without explaining the mechanism.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

**u28** (lexical 0.438) — To answer your question properly, I would need evidence that describes HTTP/3's design and how it handles the framing and flow control issues that plague HTTP/2.
  - Describes what the evidence does or does not cover. The synthesis prompt requires these to carry no citation, so it should never have been in the completeness denominator.

### fully_supported_paraphrase

**u01** (lexical 0.2) — This one-directional error is what makes the tradeoff practical.
  - entailed by: A Bloom filter answers that question with very little memory. It can say: "No, this item is definitely not present." "Maybe. This item..."
  - Corrected. I called this framing; source 1 states the one-directional error and ties the definite "no" to skipping expensive work, which is what the sentence asserts.

**u12** (lexical 0.429) — The decision to compile isn't based on a single threshold alone.
  - entailed by: Solution: Understand that thresholds can vary based on method complexity and invocation patterns.
  - Source 1 says thresholds vary with method complexity and invocation patterns, which is the same claim in other words. The lexical bar missed it because the sentence shares almost no content words with the passage.

**u30** (lexical 0.333) — A key point is that partition tolerance is not optional in practice.
  - entailed by: in practice, the real choice is between consistency and availability, because partition tolerance is almost always required
  - "Almost always required" and "not optional in practice" are the same claim. No content words in common beyond "partition tolerance", which is why the overlap score is 0.333.

**u31** (lexical 0.429) — This variety in data types and patterns within a single row makes it much harder for compression algorithms to find patterns to exploit.
  - entailed by: Because a columnar layout puts like values next to like values, the compressor has far more to work with.
  - The passage states the columnar side of the contrast explicitly; the row side is its direct complement and the same passage is what the answer's cited sentences draw on.

**u32** (lexical 0.167) — This heterogeneity makes rows harder to compress effectively.
  - entailed by: Because a columnar layout puts like values next to like values, the compressor has far more to work with. The same data often compresses 2-4x smaller columnar than row-major.
  - Same passage, same contrast, stated more briefly. A four-word sentence has almost no content words to overlap with, which is the clearest case of the bar failing on brevity rather than on substance.

**u33** (lexical 0.333) — The performance impact can be severe.
  - entailed by: Close to 20x (an order of magnitude)... I have seen the multiplier anywhere from 15x to 48x
  - Corrected. I labelled this overstated_beyond_evidence from a terminal dump that truncated every passage to 250 characters, which cut off before source 2's benchmark. Source 2 measures 15x to 48x slowdowns and calls them "an order of magnitude apart". That supports "severe" plainly.

**u34** (lexical 0.333) — The performance impact can be severe.
  - entailed by: Close to 20x (an order of magnitude)... I have seen the multiplier anywhere from 15x to 48x
  - Same sentence, same correction.

**u35** (lexical 0.4) — The tradeoff is worth it for variables that see heavy concurrent access, since the caching overhead otherwise dominates the actual computation time.
  - entailed by: Same amount of computation, same number of threads, and the only difference is whether the two counters are crammed onto the same cacheline... The fix is almost brutally direct: make any variable that
  - Corrected. I labelled this unsupported from the same truncated view. Source 2 holds both halves: the measured multiplier with computation held constant is the caching overhead dominating, and "any variable that different cores will write frequently" is the heavy-concurrent-access condition.

### partially_supported

**u29** (lexical 0.444) — The theorem's core insight on this point is that network partitioning is unavoidable in distributed systems.
  - supported: that network partitioning is unavoidable in distributed systems
  - not supported: that this is the theorem's core insight
  - Source 2 says partition tolerance is almost always required and that the real choice is between consistency and availability, so the substantive half stands. That this is the theorem's "core insight" is the answer's framing, not the source's.

