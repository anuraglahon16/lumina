# Superseded reports — not authoritative

These were produced by running the benchmark against `http://localhost:8787`
on 2026-09-18, on Node 21, before the deployed application had ever been
measured. They are kept because deleting a measurement to make a later one look
better is not something this project does, and because the difference between
them and the deployed run is itself a finding.

**They do not certify the deployed application, and two of their numbers are
known to be wrong about it:**

- **Document RAG scored 15/15 here and was completely broken deployed.** The
  Vercel function ran Node 24, where the pdf.js build vendored by `pdf-parse`
  throws `bad XRef entry` on every PDF. Nothing in a localhost run on Node 21
  could see that.
- **Embeddings ran locally here by configuration.** The deployed runtime
  resolved to Voyage, because `EMBEDDING_PROVIDER` was unset and
  `VOYAGE_API_KEY` was present.

The authoritative run is the one made against the deployed Preview URL and
recorded in `reports/phase7-deployed.md`. Read these only as history.
