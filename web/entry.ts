// Browser entry. Bundled by scripts/build-web.mjs into index.html as the global `Cleone`.
import { collect, fetchProject, hasGithubToken, parseRepo, setGithubToken, type CandidateMeta } from "../lib/github";
import { draftEmail, scoreCandidate } from "../lib/offline";

export { hasGithubToken, parseRepo, setGithubToken };

export type FeedItem = {
  k: string;
  name: string;
  handle: string;
  art: string;
  url: string;
  score: number;
  sig: number;
  res: number;
  tim: number;
  tag: string;
  why: string;
  contact: string;
  meta: CandidateMeta;
};

export async function scan(repo: string, onStage: (s: string) => void) {
  const { owner, name } = parseRepo(repo);
  onStage("Reading the repository");
  const project = await fetchProject(owner, name);
  const { candidates, stats } = await collect(project, onStage);
  const items: FeedItem[] = candidates.map((c) => {
    const r = scoreCandidate(c);
    return {
      k: c.dedupe_key,
      name: c.name,
      handle: c.handle,
      art: c.artifact_title,
      url: c.artifact_url.replace(/^https?:\/\//, ""),
      score: r.score,
      sig: r.significance,
      res: r.resonance,
      tim: r.timing,
      tag: c.lane,
      why: r.why,
      contact: c.contact,
      meta: c.meta,
    };
  });
  return { project: { owner: project.owner, name: project.name, description: project.description }, items, stats };
}

export function email(project: { owner: string; name: string; description: string }, item: FeedItem): string {
  return draftEmail(project, { name: item.name, handle: item.handle, artifact_title: item.art, contact: item.contact, meta: item.meta });
}
