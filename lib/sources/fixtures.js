// SAMPLE responses shaped like each source's documented public format. Used by the automated tests and by SOURCE_MODE=sandbox.
// Every link points at sample.invalid (a domain that can never exist), and anything stored from here is marked synthetic,
// so sample vacancies can never be mistaken for real ones. These are NOT real jobs and are never used in production mode.

const body = (role, extra = "") => `We are looking for a ${role} to join our team. You will design, build and maintain services used by thousands of customers every day, work closely with product and design, review code, and own features from idea to release. ${extra}`;
const days = (n) => Math.floor(Date.now() / 1000) - n * 86400;
const iso = (n) => new Date(days(n) * 1000).toISOString();

export const FIXTURES = {
  greenhouse: {
    jobs: [
      { id: 4012, title: "Backend Engineer", updated_at: iso(1), first_published: iso(6), absolute_url: "https://sample.invalid/greenhouse/acme/jobs/4012", location: { name: "Lagos, Nigeria" },
        departments: [{ name: "Engineering" }], content: "&lt;p&gt;" + body("Backend Engineer", "Requirements: 3+ years of experience with Python and Django, PostgreSQL, Docker and AWS. A BSc in Computer Science or equivalent.") + "&lt;/p&gt;" },
      { id: 4013, title: "Product Designer", updated_at: iso(2), first_published: iso(20), absolute_url: "https://sample.invalid/greenhouse/acme/jobs/4013", location: { name: "Remote" },
        departments: [{ name: "Design" }], content: "&lt;p&gt;" + body("Product Designer", "You are fluent in Figma, UX research and user interface design.") + "&lt;/p&gt;" },
      { id: 4014, title: "Closed Role Sample", updated_at: iso(3), first_published: iso(30), absolute_url: "https://sample.invalid/closed/greenhouse-4014", location: { name: "Remote" },
        departments: [{ name: "Sales" }], content: "&lt;p&gt;" + body("Account Executive", "Experience in sales and customer support required.") + "&lt;/p&gt;" },
    ],
  },
  lever: [
    { id: "7c1f0a2e-0001", text: "Senior Data Engineer", hostedUrl: "https://sample.invalid/lever/globex/7c1f0a2e-0001", applyUrl: "https://sample.invalid/lever/globex/7c1f0a2e-0001/apply", createdAt: Date.now() - 4 * 864e5,
      categories: { location: "Remote - Africa", team: "Data", department: "Engineering", commitment: "Full-time" }, workplaceType: "remote",
      descriptionPlain: body("Senior Data Engineer", "Requirements: 5+ years of experience. Python, SQL, Airflow and AWS. Experience with machine learning pipelines is a plus."), additionalPlain: "We offer a flexible schedule.",
      lists: [{ text: "What you will do", content: "<li>Build data pipelines</li><li>Maintain the warehouse</li>" }], salaryRange: { min: 60000, max: 90000, currency: "USD", interval: "per-year-salary" } },
    { id: "7c1f0a2e-0002", text: "Customer Support Specialist", hostedUrl: "https://sample.invalid/lever/globex/7c1f0a2e-0002", createdAt: Date.now() - 40 * 864e5,
      categories: { location: "Abuja, Nigeria", team: "Support", commitment: "Contract" }, workplaceType: "on-site", descriptionPlain: body("Customer Support Specialist", "Excellent written English and customer support experience required.") },
  ],
  ashby: {
    jobs: [
      { id: "a-9001", title: "Frontend Engineer", department: "Engineering", team: "Web", location: "Remote (Global)", isRemote: true, isListed: true, employmentType: "FullTime", publishedAt: iso(3),
        jobUrl: "https://sample.invalid/ashby/initech/a-9001", applyUrl: "https://sample.invalid/ashby/initech/a-9001/application", descriptionPlain: body("Frontend Engineer", "Requirements: 2+ years of experience with React, TypeScript, HTML and CSS."),
        compensation: { summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 70000, maxValue: 100000 }] } },
      { id: "a-9002", title: "Unlisted Role", isListed: false, location: "Remote", jobUrl: "https://sample.invalid/ashby/initech/a-9002", descriptionPlain: body("Hidden role") },
    ],
  },
  rss: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Sample Careers</title>
<item><title>Marketing Manager at Sample Foods</title><link>https://sample.invalid/rss/jobs/301</link><guid>sample-301</guid><pubDate>${new Date(days(2) * 1000).toUTCString()}</pubDate><category>Marketing</category>
<description><![CDATA[<p>${body("Marketing Manager", "SEO, copywriting and marketing experience. Lagos, Nigeria. Full-time.")}</p>]]></description></item>
<item><title>Accountant at Sample Foods</title><link>https://sample.invalid/rss/jobs/302</link><guid>sample-302</guid><pubDate>${new Date(days(9) * 1000).toUTCString()}</pubDate>
<description><![CDATA[<p>${body("Accountant", "Accounting and Excel skills. ICAN or ACCA preferred.")}</p>]]></description></item></channel></rss>`,
  careerPage: `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Site Reliability Engineer", description: "<p>" + body("Site Reliability Engineer", "Linux, Kubernetes, Docker and AWS. 4+ years of experience.") + "</p>",
    datePosted: iso(5).slice(0, 10), validThrough: new Date(Date.now() + 20 * 864e6 / 10).toISOString(), employmentType: "FULL_TIME", hiringOrganization: { "@type": "Organization", name: "Sample Bank" },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Lagos", addressCountry: "NG" } }, baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 40000, maxValue: 60000, unitText: "YEAR" } },
    url: "https://sample.invalid/careers/sre-1", identifier: { "@type": "PropertyValue", value: "SRE-1" } })}</script></head><body><h1>Careers</h1></body></html>`,
  robots: "User-agent: *\nDisallow: /private/\nAllow: /careers/",
  remotive: { "job-count": 2, jobs: [
    { id: 9101, url: "https://sample.invalid/remotive/9101", title: "Python Developer", company_name: "Remote Co", category: "Software Development", tags: ["python", "django"], job_type: "full_time", publication_date: iso(1), candidate_required_location: "Worldwide", salary: "$50k - $80k",
      description: "<p>" + body("Python Developer", "Python, Django, REST API, PostgreSQL. 2+ years of experience.") + "</p>" },
    { id: 9102, url: "https://sample.invalid/remotive/9102", title: "EARN $5000 WEEKLY FROM HOME", company_name: "Quick Cash", tags: [], job_type: "contract", publication_date: iso(1), candidate_required_location: "Worldwide",
      description: "<p>" + body("home agent", "Pay a registration fee of $20 to start. Contact us on WhatsApp +234 801 234 5678. No experience needed, guaranteed income.") + "</p>" }] },
  arbeitnow: { data: [{ slug: "sample-qa-berlin", company_name: "Sample GmbH", title: "QA Engineer", description: "<p>" + body("QA Engineer", "Testing, QA, Git and agile.") + "</p>", remote: false, url: "https://sample.invalid/arbeitnow/qa-berlin", tags: ["qa"], job_types: ["full time"], location: "Berlin", created_at: days(2) }] },
  remoteok: [{ legal: "sample attribution notice" }, { id: "88001", slug: "sample-devops", position: "DevOps Engineer", company: "Sample Cloud", description: "<p>" + body("DevOps Engineer", "Docker, Kubernetes, CI/CD, AWS and Linux.") + "</p>", tags: ["devops", "aws"], location: "Worldwide", url: "https://sample.invalid/remoteok/88001", epoch: days(1), salary_min: 70000, salary_max: 110000 }],
};
