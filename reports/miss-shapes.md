# What shape are the remaining citation misses?

> Uncited factual sentences that a source in the same run supports, from the
> granular arm of the evidence-replay A/B. Structural classification only.

- from: `2026-09-18T00:03:31.556Z`
- sentences: 49

## By shape

| shape | sentences | share |
|---|---:|---:|
| continuation_prose | 39 | 80% |
| evidence_gap_disclosure | 4 | 8% |
| list_introduction | 2 | 4% |
| quotation_fragment | 2 | 4% |
| framing_sentence | 2 | 4% |
| **total** | **49** | |

- `list_introduction`: a line introducing a list; organisational rather than a claim of its own
- `quotation_fragment`: not a sentence: the splitter broke inside a quoted title
- `evidence_gap_disclosure`: describes what the evidence does or does not cover; the contract requires these to stay uncited
- `framing_sentence`: announces what follows rather than asserting something checkable
- `continuation_prose`: an ordinary sentence continuing a point whose opening sentence carried the marker

## Every one of them

### continuation_prose

- (0.778) This compact representation uses far less memory than storing the items themselves.
- (1) A missing item can appear present if other items already set all of its hash positions to 1.
- (0.875) If the filter says "yes," the engine still checks the actual file to confirm.
- (0.75) In practice, this means the OOM Killer tends to target large non-system processes with many child processes.
- (0.692) This scoring approach means the OOM Killer typically targets large, non-system processes with many child processes.
- (0.727) Clustered and nonclustered indexes differ in their structure, location, quantity per table, and performance characteristics.
- (0.5) Read performance differs between the two.
- (0.611) It mentions that resolvers cache DNS records and that the TTL (time to live) on a record is supposed to determine how long resolvers cache it before e
- (0.667) It confirms that resolvers cache DNS records and that cached records expire based on their TTL (time to live), but it does not describe the mechanism 
- (0.857) Instead of sending gigabytes of data across a network to confirm two copies match, the system can compare cryptographic hashes.
- (0.833) Instead of sending entire files or datasets for comparison, a Merkle tree allows verification through hashes.
- (0.75) If the hashes match, verification is complete.
- (0.636) The evidence is a market report about the SSD industry's size, growth projections, and regional adoption trends.
- (0.6) However, the protocol has significant costs.
- (0.6) The protocol also addresses recovery from temporary failures.
- (0.615) The JVM determines when a method is "hot" enough to compile based on execution frequency metrics and a multi-stage decision process.
- (0.875) The JVM decides the next compilation step dynamically based on invocation counts, loop back-edge counts, and how busy each compiler's queue currently 
- (0.733) The JVM can route through level 2 instead of 3 when the C2 compilation queue is under pressure, adapting the decision based on current system load.
- (0.867) This works because WAL enforces a strict ordering: log entries are written to durable storage first, then the changes are applied to the database.
- (0.5) The main functionality includes three key aspects.
- (0.667) The heading "What Is Certificate Pinning?
- (0.5) The mechanism works through the filesystem's tree structure.
- (0.5) Both the snapshot and the active filesystem can then reference their respective versions of the data without redundancy.
- (0.833) When a network partition occurs, the system must choose between consistency or availability, but it cannot abandon partition tolerance itself.
- (0.667) In 2012, Eric Brewer clarified this aspect, noting that the often-cited "two out of three" framing can be misleading.
- (0.6) This means partition tolerance is the baseline requirement, and the real trade-off happens within that constraint.
- (0.667) In other words, the system keeps functioning even when network failures occur and nodes cannot communicate with each other.
- (0.714) The CAP theorem does not claim that you must sacrifice partition tolerance.
- (0.667) This is why the theorem is sometimes misunderstood.
- (0.667) A single column contains values of the same type that repeat or change gradually.
- (0.923) For example, ShopFlow's status column is a long run of "paid, paid, paid, shipped, paid...", a handful of distinct values repeating.
- (0.667) A single column contains values of the same type that repeat or change gradually.
- (1) For example, ShopFlow's status column is a long run of values like "paid, paid, paid, shipped, paid", just a handful of distinct values repeating.
- (1) By contrast, a row mixes different data types: a bigint order_id, a string status, and a decimal amount.
- (0.588) Since compression works by finding and exploiting repetition and similarity in data, columnar layouts present much better opportunities for compressio
- (0.571) The slowdown happens because of how cache coherence protocols work.
- (0.667) Even though the cores are operating on logically unrelated variables, the coherence mechanism treats them as a single unit.
- (0.571) The slowdown happens because of how cache coherence protocols work.
- (0.5) The fix involves separating variables that different threads access frequently.

### evidence_gap_disclosure

- (0.522) The evidence provided discusses the SSD market size, growth projections, regional adoption, and key players in the industry, but it does not contain a
- (0.5) The evidence provided discusses what the borrow checker is and its general role in Rust's memory management, but it does not explicitly detail what sp
- (0.5) To give you a complete answer about what specific violations the borrow checker catches at compile time, I would need evidence that explicitly lists t
- (0.5) The evidence discusses what causes head-of-line blocking in HTTP/2, specifically frame interleaving limits and flow control stalls at the application 

### list_introduction

- (0.667) The principal criteria for this score are:
- (0.667) The badness score is based on several criteria, primarily:

### quotation_fragment

- (0.524) Benefits, Risks & Best Practices" appears in the evidence, along with related topics like "Risks and Limitations of Certificate Pinning" and "Listiche
- (0.583) Benefits, Risks & Best Practices" and "Risks and Limitations of Certificate Pinning," which appear to be in the source but are not included in the evi

### framing_sentence

- (0.571) The practical difference matters when you need to detect concurrent writes.
- (0.571) The practical difference matters most when you need to detect concurrent writes.

