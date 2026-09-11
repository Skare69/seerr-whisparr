/*
 * Honesty surfaces. Every statement restates a limit measured against the
 * live providers during development; anything not measured is labelled
 * unproven rather than omitted. No data fetching — pure static content.
 */

export function LimitsPanel() {
  return (
    <div className="panel p-5">
      <h3 className="font-semibold">Known limits</h3>
      <p className="mt-1 text-sm text-muted">
        Each item below was measured against the live providers during
        development. When a result looks odd, the reason is usually one of these
        — not a bug and not an outage.
      </p>
      <ul className="mt-3 space-y-3 text-sm text-muted">
        <li>
          <strong className="font-medium text-ink">
            Movies exist only in TPDB.
          </strong>{" "}
          StashDB has no movie entity at all, so a movie search offers no
          StashDB option. Scenes exist in both catalogs, and results from the
          two providers are never merged into one list.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Cross-provider matching works for performers only.
          </strong>{" "}
          Identity is linked through explicit provider URLs on the performer.
          There is no reliable scene-level cross-link, so an unlinked performer
          says so plainly instead of showing a fabricated filmography.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Some result counts are absent on purpose.
          </strong>{" "}
          TPDB's unfiltered and title-only-filtered listings report a fake total
          capped at <code className="chip">10000</code>, so a count is shown
          only when it is genuinely real. Narrowed (filtered) queries do return
          real counts.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Sorting differs per provider.
          </strong>{" "}
          TPDB sorts by relevance, release recency and duration only — it has no
          trending or popularity order. StashDB scenes additionally offer title,
          date, duration, trending, popularity, created and updated; trending
          and popularity are StashDB's own ordering.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Filters differ per provider.
          </strong>{" "}
          StashDB scene filters have no year criterion (a date plus a modifier
          only, with no "between"), while TPDB has year and an exact-duration
          filter. TPDB has no tag-exclusion parameter; StashDB supports include,
          include-all and exclude.
        </li>
        <li>
          <strong className="font-medium text-ink">
            A studio can look empty until child studios are included.
          </strong>{" "}
          A StashDB studio may be a parent whose scenes live under child studios
          — Brazzers has 48 children, 0 direct scenes, and 14,658 with children
          — so searching a parent's direct scenes only is an explicit choice.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Date comparisons take symbols only.
          </strong>{" "}
          TPDB accepts only <code className="chip">&lt;=</code>,{" "}
          <code className="chip">&gt;=</code>,{" "}
          <code className="chip">&lt;</code>, <code className="chip">&gt;</code>{" "}
          and <code className="chip">=</code>; word forms are rejected by the
          provider itself.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Discover recency shelves stop at today.
          </strong>{" "}
          They are bounded to titles released on or before today (UTC) and
          exclude records without a release date.
        </li>
        <li>
          <strong className="font-medium text-ink">
            Library matching has known gaps.
          </strong>{" "}
          This Jellyfin build (12.0.0) ships empty ProviderIds and ignores
          parentId when ids are present, so library membership is proven via
          ancestors and availability matching leans on the Whisparr path.
        </li>
      </ul>
      <h4 className="mt-5 text-sm font-semibold">Provider usage terms</h4>
      <p className="mt-1 text-sm text-muted">
        Neither provider publishes usage terms covering third-party apps,
        artwork re-serving, caching or rate limits. Velvarr therefore caches
        nothing. This is an open question for the operator, not an approval:
        running Velvarr against these providers is not cleared by either
        provider in writing.
      </p>
    </div>
  );
}

export function ReleaseStatusPanel() {
  const rows: {
    area: string;
    state: "Proven" | "Not proven" | "CI only" | "Undecided";
    detail: string;
  }[] = [
    {
      area: "Acquisition to playback",
      state: "Not proven",
      detail:
        "No Whisparr add has ever been executed. The end-to-end journey for a movie and a scene is unproven until the operator nominates fixtures, a root folder and a quality profile, and authorizes the first controlled add.",
    },
    {
      area: "Your Jellyfin server",
      state: "Not proven",
      detail:
        "Only a local lab Jellyfin 12.0.0 was exercised. The operator's installed homelab Jellyfin is unproven.",
    },
    {
      area: "Removal",
      state: "Not proven",
      detail:
        "Removal is implemented but has never been executed against a real system — the entire removal ladder is proven against loopback fixtures only. It stays off unless VELVARR_ENABLE_REMOVAL=1 is set and an account holds the removal grant.",
    },
    {
      area: "Container behavior",
      state: "CI only",
      detail:
        "Verified in CI, including a container smoke test, because the development workstation has no container runtime.",
    },
    {
      area: "Licence",
      state: "Undecided",
      detail:
        "The repository has no LICENSE file; the licence choice remains the operator's.",
    },
  ];
  return (
    <div className="panel p-5">
      <h3 className="font-semibold">Release status</h3>
      <p className="mt-1 text-sm text-muted">
        What this build has actually proven, and what it has not. Nothing here
        is a promise.
      </p>
      <dl className="mt-3 space-y-3 text-sm">
        {rows.map((r) => (
          <div key={r.area}>
            <dt className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.area}</span>
              <span className="chip">{r.state}</span>
            </dt>
            <dd className="mt-1 text-muted">{r.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
