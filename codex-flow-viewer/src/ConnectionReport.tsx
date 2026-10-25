import React from "react";
import type { ConnectionDiagnostics } from "./types";
import { basename } from "./types";

export function RecordedProjectPicker({
  projects,
  onChoose,
  disabled = false,
}: {
  projects: ConnectionDiagnostics["availableProjects"];
  onChoose: (path: string) => void;
  disabled?: boolean;
}) {
  if (!projects.length) return null;
  return (
    <div className="recorded-project-picker">
      <label>
        기록에 있는 프로젝트
        <select
          aria-label="기록에 있는 프로젝트"
          value=""
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value) onChoose(event.target.value);
          }}
        >
          <option value="">기록에서 확인된 프로젝트 선택</option>
          {projects.map((project) => (
            <option
              key={project.path}
              value={project.path}
              disabled={!project.exists}
            >
              {basename(project.path)} · 대화 {project.conversationCount}개
              {!project.exists ? " · 현재 폴더 없음" : ""} — {project.path}
            </option>
          ))}
        </select>
      </label>
      <p>
        현재 연결된 기록에서 확인한 실제 경로입니다. 선택한 뒤 프로젝트 연결을
        눌러 적용하세요.
      </p>
    </div>
  );
}

export default function ConnectionReport({
  diagnostics,
  onChoose,
  showProjects = true,
}: {
  diagnostics: ConnectionDiagnostics;
  onChoose: (path: string) => void;
  showProjects?: boolean;
}) {
  return (
    <section
      className={`connection-report ${diagnostics.status === "connected" ? "connected" : "needs-attention"}`}
      aria-label="연결 확인 결과"
    >
      <p role="status">
        <strong>{diagnostics.message}</strong>
      </p>
      <p className="connection-counts">
        기록 {diagnostics.scannedFiles}개 확인 · 연결된 대화{" "}
        {diagnostics.conversationCount}개
        {diagnostics.archivedFiles
          ? ` · 보관 기록 ${diagnostics.archivedFiles}개 포함`
          : ""}
      </p>
      {showProjects && !diagnostics.conversationCount && (
        <RecordedProjectPicker
          projects={diagnostics.availableProjects}
          onChoose={onChoose}
        />
      )}
      {!diagnostics.conversationCount && !diagnostics.issues.length && (
        <p>
          로컬 폴더의 존재와 별개로, Codex 대화에 기록된 프로젝트 경로가
          일치해야 표시됩니다.
        </p>
      )}
      {diagnostics.issues.length > 0 && (
        <details>
          <summary>읽기 오류 {diagnostics.issues.length}개 확인</summary>
          {diagnostics.issues.slice(0, 20).map((issue) => (
            <p className="connection-issue" key={issue.path + issue.code}>
              {issue.code} · {issue.path}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
