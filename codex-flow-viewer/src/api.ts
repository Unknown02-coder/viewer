export async function api<T>(
  url: string,
  method = "GET",
  value?: unknown,
  connectionId?: string,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      ...(connectionId ? { "X-Viewer-Connection": connectionId } : {}),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error || "기록을 불러오지 못했습니다."),
      { code: result.code },
    );
  return result;
}
