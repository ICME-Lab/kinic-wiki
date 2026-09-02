// Where: workers/wiki-mcp/scripts/review-fixture.mjs
// What: Defines the stable database, paths, and content used by OpenAI review automation.
// Why: Seeding and verification must use one exact fixture contract.

export const REVIEW_DATABASE_NAME = "openai-review-fixture";
export const REVIEW_SCRATCH_PREFIX = "/OpenAIReview/scratch";
export const REVIEW_FOLDERS = ["/Knowledge", "/Knowledge/review", "/OpenAIReview", REVIEW_SCRATCH_PREFIX];
export const REVIEW_FILES = [
  {
    path: "/Knowledge/review/release-checklist.md",
    content: [
      "# Review release checklist",
      "",
      "Before release, verify authenticated discovery, private context retrieval, search evidence, isolated writes, etag-protected cleanup, and successful Web and mobile runs.",
      "",
      "Release only when every check passes. If any check fails, apply the [rollback rule](/Knowledge/review/rollback-rule.md)."
    ].join("\n"),
    metadata_json: JSON.stringify({ title: "Review release checklist", tags: ["openai-review", "release", "checklist"] })
  },
  {
    path: "/Knowledge/review/rollback-rule.md",
    content: [
      "# Review rollback rule",
      "",
      "If any review check fails, stop the release, preserve the previous production version, remove only scratch artifacts created by that run, and report the failed check before retrying.",
      "",
      "Resume only after the [release checklist](/Knowledge/review/release-checklist.md) passes in full."
    ].join("\n"),
    metadata_json: JSON.stringify({ title: "Review rollback rule", tags: ["openai-review", "rollback"] })
  }
];
