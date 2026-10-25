import type { Turn, Evidence } from "./types";

const excerpt = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\(<?[^)]+>?\)/g, "$1")
    .replace(/[#*`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function overviewRows(
  turns: Turn[],
  matching: Set<string> = new Set(),
  filtered = false,
  evidence: Evidence[] = [],
) {
  const messages = new Map(
    evidence
      .filter((item) => item.kind === "message")
      .map((item) => [item.id, item]),
  );
  return turns
    .filter((turn) => turn.requests.length > 0)
    .map((turn, index) => {
      const description = turn.tasks
        .map((task) => messages.get(task.id))
        .findLast((item) => item?.text.trim());
      const plan = turn.plans.findLast((plan) => plan.text.trim());
      const answer = turn.result.trim();
      return {
        turn,
        number: index + 1,
        excerpt: excerpt(answer || description?.text || plan?.text || ""),
        excerptLabel: answer
          ? "답변 발췌"
          : description
            ? "작업 설명 발췌"
            : plan
              ? "계획 발췌"
              : "답변 기록 없음",
        fileCount: new Set(
          turn.tasks
            .flatMap((task) => task.files)
            .map((file) => file.path.toLowerCase().replaceAll("\\", "/")),
        ).size,
      };
    })
    .filter(
      ({ turn }) =>
        !filtered ||
        matching.has(turn.id) ||
        turn.tasks.some((task) => matching.has(task.id)),
    );
}
