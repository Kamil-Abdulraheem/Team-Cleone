import { scoreJob, WEIGHTS, eduLevel, yearsFromCv, requirementsOf } from "../lib/match.js";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && extra ? "  -> " + extra : ""}`); };
const day = 86400;
const job = (o = {}) => ({ title: "Backend Developer", company: "Acme", location: "Remote", remote: 1, tags: "", employment_type: "", salary_min: null, salary_max: null, currency: "", posted_at: Date.now() / 1000 - day,
  description: "Build and maintain APIs with Python and Django on PostgreSQL. You will design services, review code and deploy with Docker. 3+ years of experience. A BSc in Computer Science.", ...o });
const me = { roles: "backend developer", skills: "python,flask,postgresql,docker", years: 4, education: 2, location: "Lagos, Nigeria", remote_only: 0, min_salary: 0, employment: "", cvText: "I design and deploy services, review code and build APIs" };
const part = (m, k) => m.parts.find((p) => p.key === k);

ok("weights add up to 100", Object.values(WEIGHTS).reduce((a, b) => a + b, 0) === 100);
const m = scoreJob(me, job());
ok("every score comes with named, weighted components", m.parts.length === 8 && m.parts.every((p) => p.weight > 0 && "status" in p));
ok("strong fit scores high and explains strengths", m.score >= 75 && m.why.some((w) => /backend developer/.test(w)) && m.why.some((w) => /python/.test(w)) && m.why.some((w) => /meets the 3/.test(w)), JSON.stringify(m.why));
ok("transferable skills: Flask experience counts toward Django", m.transferable.some((t) => /(flask|python).*django/i.test(t)) && part(m, "skills").score > 0.6 && part(m, "skills").score < 1);

// missing information is not a mismatch
const noSalary = scoreJob({ ...me, min_salary: 80000 }, job());
const goodSalary = scoreJob({ ...me, min_salary: 80000 }, job({ salary_min: 90000, salary_max: 110000, currency: "USD" }));
const badSalary = scoreJob({ ...me, min_salary: 80000 }, job({ salary_min: 30000, salary_max: 40000, currency: "USD" }));
ok("unstated salary is 'unknown', not a mismatch", part(noSalary, "salary").status === "unknown" && part(noSalary, "salary").score === null && noSalary.unknown.some((u) => /does not state its pay/.test(u)));
ok("unknown pay does not lower the score; a real mismatch does", noSalary.score === m.score && badSalary.score < noSalary.score && goodSalary.score >= noSalary.score && part(badSalary, "salary").status === "mismatch");
ok("confidence says how much was known", noSalary.confidence < 1 && noSalary.confidence > 0.5 && scoreJob(me, job({ description: "Join us." })).confidence < m.confidence);
ok("a job with almost no detail is unknown on skills, not zero", part(scoreJob(me, job({ description: "Join our friendly team in a fast moving company doing great things for our customers." })), "skills").status === "unknown");

// gaps and mismatches
const gap = scoreJob({ ...me, years: 1, skills: "python" }, job());
ok("gaps are stated plainly with numbers", gap.gaps.some((g) => /3\+? years/.test(g) && /you list 1/.test(g)) && gap.gaps.some((g) => /postgresql/.test(g)), JSON.stringify(gap.gaps));
ok("lower education than asked is a gap", scoreJob({ ...me, education: 1 }, job()).gaps.some((g) => /bachelor/.test(g)) && scoreJob(me, job({ description: "Python and Django developer wanted for our product team." })).unknown.some((u) => /qualification/.test(u)));
ok("remote-only preference is never outvoted", scoreJob({ ...me, remote_only: 1 }, job({ remote: 0, location: "Berlin" })).score <= 30);
ok("remote jobs limited to other countries are flagged", scoreJob(me, job({ description: job().description + " Candidates must be based in the US only." })).gaps.some((g) => /limited to candidates/.test(g)) && !scoreJob(me, job({ description: job().description + " Open to candidates in Africa." })).gaps.some((g) => /limited/.test(g)));
ok("employment preference is compared only when both are known", scoreJob({ ...me, employment: "full-time" }, job({ employment_type: "contract" })).gaps.some((g) => /contract/.test(g)) && part(scoreJob({ ...me, employment: "full-time" }, job()), "employment").status === "unknown");
ok("on-site job in another city is a location mismatch", part(scoreJob(me, job({ remote: 0, location: "Berlin" })), "location").status === "mismatch" && part(scoreJob(me, job({ remote: 0, location: "Lagos" })), "location").status === "match");

// adjacent opportunities
const adj = scoreJob(me, job({ title: "DevOps Engineer" }));
ok("adjacent roles are found and labelled", adj.adjacent === true && adj.why.some((w) => /Adjacent to your target role/.test(w)) && !m.adjacent);
ok("an unrelated role scores low", scoreJob(me, job({ title: "Pastry Chef", description: "Bake bread and cakes every morning for our busy bakery in town. Experience with ovens." })).score < 40);
ok("AI-added facts are scored by the same rules", requirementsOf(job({ description: "Join us." }), { skills: ["rust"], years: { rust: 5 }, edu: 3 }).skills.includes("rust") && scoreJob(me, job({ description: "Join us." }), { skills: ["rust"], years: { rust: 5 } }).gaps.some((g) => /rust/.test(g)));
ok("CV reading helpers", eduLevel("MSc Computer Science") === 3 && eduLevel("HND Accounting") === 2 && yearsFromCv("Over 6 years of work as a developer") === 6 && yearsFromCv("") === 0);
console.log(`match.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
