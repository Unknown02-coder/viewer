export const sourceId = "11111111-1111-4111-8111-111111111111";
export function snapshot({
  threadId = "thread-one",
  title = "가져온 대화",
  text = "답변 원문입니다.",
  truncated = false,
  turns,
  complete = true,
  capturedAt = "2026-10-25T08:00:00.000Z",
} = {}) {
  turns ??= [
    {
      id: "turn-one",
      status: "completed",
      startedAt: 1789188163.155,
      completedAt: 1789188163.123,
      items: [
        {
          type: "userMessage",
          id: "question-one",
          content: [{ type: "text", text: "질문 원문을 보여줘" }],
        },
        {
          type: "agentMessage",
          id: "answer-one",
          text,
          ...(truncated ? { truncated: true } : {}),
        },
      ],
    },
  ];
  return {
    format: "codex-flow.chatgpt-snapshot",
    schemaVersion: 1,
    sourceInstanceId: sourceId,
    capturedAt,
    pages: [
      {
        request: { threadId, turnLimit: 2, maxOutputCharsPerItem: 20000 },
        receivedAt: capturedAt,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                schemaVersion: 1,
                thread: {
                  id: threadId,
                  kind: "chatgpt",
                  title,
                  cwd: null,
                  updatedAt: 1789190549.683,
                },
                page: {
                  order: "newest_first",
                  limit: 2,
                  nextCursor: complete ? null : turns.at(-1)?.id,
                  hasMore: !complete,
                },
                turns,
                attachments: [],
              }),
            },
          ],
        },
      },
    ],
  };
}
export const bytes = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
