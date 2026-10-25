export type Status =
  "running" | "completed" | "failed" | "interrupted" | "unknown";
export interface FileChange {
  id: string;
  path: string;
  relativePath: string;
  kind: string;
  diff: string;
  content: string;
  added: number | null;
  removed: number | null;
  evidenceId: string;
  status: string;
}
export interface Artifact {
  id: string;
  label: string;
  path: string;
  kind: "linked";
  evidenceId: string;
}
export interface Task {
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  truncated?: boolean;
  id: string;
  turnId: string;
  title: string;
  text: string;
  files: FileChange[];
  evidenceIds: string[];
  status: Status;
  verification: "none";
  grouping: string;
  kind: "execution" | "description";
}
export interface Turn {
  receivedSummary?: string;
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  truncated?: boolean;
  id: string;
  title: string;
  requests: { id: string; text: string; line: number }[];
  tasks: Task[];
  plans: { id: string; text: string; evidenceId: string }[];
  artifacts: Artifact[];
  result: string;
  status: Status;
  evidenceIds: string[];
}
export interface Evidence {
  receiverReference?: {
    receiptId: string;
    conversationId: string;
    receivedAt: string;
  };
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  truncated?: boolean;
  reference?: {
    page: number;
    turnIndex: number;
    itemIndex: number;
    turnId: string;
    itemId: string;
    snapshotId: string;
    conversationId: string;
  };
  id: string;
  turnId: string;
  sourcePath: string;
  line: number;
  timestamp: string | null;
  kind: string;
  text: string;
  phase: string | null;
  status: string | null;
  command?: string;
  exitCode?: number | null;
  files?: FileChange[];
  attemptedFiles?: FileChange[];
  childId?: string;
}
export interface Session {
  mcpProjectId?: string;
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  title?: string;
  coverage?: Coverage;
  capturedAt?: string;
  importedAt?: string;
  snapshotId?: string;
  originalThreadId?: string;
  id: string;
  project: string;
  sourcePath: string;
  version: string;
  originator: string;
  turns: Turn[];
  evidence: Evidence[];
  revision: string;
  latestTimestamp: string | null;
  pendingBytes: number;
  invalidLines: number[];
  limitations: string[];
  loadedAt: string;
}
export interface SessionSummary {
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  coverage?: Coverage;
  id: string;
  title: string;
  project: string;
  turnCount: number;
  taskCount: number;
  status: Status;
  revision: string;
  latestTimestamp: string | null;
}
export interface Config {
  mcpProjectId?: string | null;
  mcpProjectName?: string | null;
  notice?: string | null;
  sourceKind?: "codex" | "chatgpt" | "chatgpt-mcp";
  selectedImportId?: string | null;
  connectionId: string;
  diagnostics?: ConnectionDiagnostics;
  project: string;
  sessionsRoot: string;
  mode: "live" | "import";
  pollInterval: number;
  error: string | null;
}
export interface ConnectionDiagnostics {
  status: string;
  message: string;
  scannedFiles: number;
  parsedFiles?: number;
  archivedFiles?: number;
  conversationCount: number;
  availableProjects: {
    path: string;
    conversationCount: number;
    exists: boolean;
  }[];
  issues: { path: string; code: string }[];
}
export interface ConnectionSnapshot {
  config: Config;
  sessions: SessionSummary[];
}
export interface Preferences {
  selected: string | null;
  expanded: string[];
  pinned: string[];
  notes: Record<string, string>;
  titles: Record<string, string>;
  positions: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  relations: { source: string; target: string }[];
}
export type Tab = "summary" | "files" | "evidence";
export const statusLabel: Record<Status, string> = {
  running: "진행 중",
  completed: "종료",
  failed: "실패",
  interrupted: "중단",
  unknown: "상태 미확인",
};
export interface Coverage {
  traversal: "complete" | "partial";
  text: "complete" | "partial";
  truncatedMessages: number;
}
export interface ImportedConversation {
  id: string;
  title: string;
  available: boolean;
  coverage: Coverage | null;
  importedAt: string | null;
  versionCount: number;
  snapshotId: string | null;
  turnCount: number;
  error: string | null;
}
export const displayStatus = (status: Status, sourceKind?: string) =>
  sourceKind === "chatgpt" || sourceKind === "chatgpt-mcp"
    ? sourceKind === "chatgpt-mcp"
      ? "수신 기록"
      : status === "completed"
        ? "답변 기록"
        : status === "running"
          ? "답변 진행 중"
          : "원문 상태 " + statusLabel[status]
    : statusLabel[status];
export const originalSnapshotUrl = (id: string, snapshotId: string) =>
  `/api/chatgpt/imports/${encodeURIComponent(id)}/source/${encodeURIComponent(snapshotId)}`;
export const emptyPreferences = (): Preferences => ({
  selected: null,
  expanded: [],
  pinned: [],
  notes: {},
  titles: {},
  positions: {},
  relations: [],
});
export const basename = (value: string) =>
  value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || value;
export function uniqueFiles(files: FileChange[]) {
  return [
    ...new Map(
      files.map((f) => [f.path.toLowerCase().replaceAll("\\", "/"), f]),
    ).values(),
  ];
}

export interface DirectProject {
  id: string;
  name: string;
  conversationCount: number;
  createdAt: string;
}
export interface DirectStatus {
  status: string;
  recordingAvailable: boolean;
  activeClients: {
    name: string;
    version: string;
    initializedAt: string;
    lastSeen: string;
    lastCallAt: string | null;
  }[];
  lastInitializedAt: string | null;
  lastToolCallAt: string | null;
  recordCount: number;
  lastReceivedAt: string | null;
  projectCount: number;
}
