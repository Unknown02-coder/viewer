import React from "react";

export default function ConnectionFormError({
  error,
}: {
  error: { message: string; code?: string };
}) {
  const missing = /\((ENOENT|ENOTDIR)\)/.test(error.message);
  const message =
    error.code === "PROJECT_UNAVAILABLE"
      ? missing
        ? "입력한 프로젝트 폴더가 없습니다. 탐색기에서 실제 폴더 경로를 복사해 주세요."
        : "프로젝트 폴더를 읽지 못했습니다. 폴더 위치와 접근 권한을 확인해 주세요."
      : ["SOURCE_UNAVAILABLE", "SOURCE_READ_FAILED"].includes(error.code || "")
        ? "기록을 읽지 못했습니다. Codex 기록 위치와 접근 권한을 확인해 주세요."
        : error.message;
  return (
    <div className="form-error" role="alert">
      <p>{message}</p>
      <p>저장된 메모와 고정한 기록은 삭제하지 않습니다.</p>
      {message !== error.message && (
        <details>
          <summary>오류 자세히</summary>
          <p>{error.message}</p>
        </details>
      )}
    </div>
  );
}
