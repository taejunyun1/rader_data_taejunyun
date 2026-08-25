import { useId, useRef, useState } from "react";

const MAX_CONCURRENT_UPLOADS = 2;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
const ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");

type UploadStatus = "pending" | "uploading" | "completed" | "error";

interface UploadRow {
  id: string;
  file: File;
  status: UploadStatus;
  error?: string;
}

interface UploadRecord extends UploadRow {
  batchId: number;
  settled: boolean;
}

interface BatchState {
  remaining: number;
}

interface VisualUploadQueueProps {
  onComplete?: () => void | Promise<void>;
}

export default function VisualUploadQueue({ onComplete }: VisualUploadQueueProps) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const inputId = useId();
  const idSequence = useRef(0);
  const activeUploads = useRef(0);
  const queue = useRef<UploadRecord[]>([]);
  const records = useRef(new Map<string, UploadRecord>());
  const batches = useRef(new Map<number, BatchState>());
  const batchSequence = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  function updateRow(id: string, update: Partial<UploadRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...update } : row)));
  }

  function notifyComplete() {
    const callback = onCompleteRef.current;
    if (callback) void Promise.resolve(callback()).catch(() => undefined);
  }

  function settle(record: UploadRecord) {
    if (record.settled) return;
    record.settled = true;
    const batch = batches.current.get(record.batchId);
    if (!batch) return;
    batch.remaining -= 1;
    if (batch.remaining === 0) {
      batches.current.delete(record.batchId);
      notifyComplete();
    }
  }

  async function upload(record: UploadRecord) {
    updateRow(record.id, { status: "uploading" });
    try {
      const body = new FormData();
      body.append("file", record.file);
      const response = await fetch("/api/visual-assets", { method: "POST", body });
      if (!response.ok) {
        let message = `업로드 실패 (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: unknown; message?: unknown };
          if (typeof payload.error === "string") message = payload.error;
          else if (typeof payload.message === "string") message = payload.message;
        } catch {
          // Keep the status-based fallback when the server response is not JSON.
        }
        throw new Error(message);
      }
      record.status = "completed";
      updateRow(record.id, { status: "completed", error: undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      record.status = "error";
      record.error = message;
      updateRow(record.id, { status: "error", error: message });
    } finally {
      activeUploads.current -= 1;
      settle(record);
      pump();
    }
  }

  function pump() {
    while (activeUploads.current < MAX_CONCURRENT_UPLOADS && queue.current.length > 0) {
      const record = queue.current.shift();
      if (!record || record.status !== "pending") continue;
      record.status = "uploading";
      activeUploads.current += 1;
      void upload(record);
    }
  }

  function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (selectedFiles.length === 0) return;

    const batchId = batchSequence.current + 1;
    batchSequence.current = batchId;
    const newRecords = selectedFiles.map<UploadRecord>((file) => {
      idSequence.current += 1;
      const record: UploadRecord = {
        id: `${inputId}-${idSequence.current}`,
        file,
        status: ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number]) ? "pending" : "error",
        error: ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number]) ? undefined : "지원하지 않는 이미지 형식입니다.",
        batchId,
        settled: false,
      };
      records.current.set(record.id, record);
      return record;
    });

    batches.current.set(batchId, { remaining: newRecords.length });
    setRows((current) => [...current, ...newRecords]);
    newRecords.forEach((record) => {
      if (record.status === "pending") queue.current.push(record);
      else settle(record);
    });
    pump();
  }

  function removeRow(id: string) {
    const record = records.current.get(id);
    if (!record || (record.status !== "pending" && record.status !== "error")) return;
    queue.current = queue.current.filter((queued) => queued.id !== id);
    records.current.delete(id);
    setRows((current) => current.filter((row) => row.id !== id));
    settle(record);
    pump();
  }

  const completedCount = rows.filter((row) => row.status === "completed").length;
  const pendingCount = rows.filter((row) => row.status === "pending" || row.status === "uploading").length;
  const errorCount = rows.filter((row) => row.status === "error").length;
  const summary = rows.length > 0 && completedCount === rows.length
    ? `${rows.length}개 업로드 완료`
    : `${completedCount}개 완료 · ${pendingCount}개 진행 중 · ${errorCount}개 오류`;

  return (
    <section className="inbox-capture visual-upload-queue" aria-label="이미지 업로드">
      <div>
        <p className="reading-section__label">시각 자료</p>
        <h2>이미지 보존</h2>
        <p className="inbox-capture__hint">사진과 그래픽을 원본 그대로 보존하고, 분석은 서버에서 처리합니다.</p>
      </div>
      <label className="ui-button-secondary" htmlFor={inputId}>이미지 추가</label>
      <input
        id={inputId}
        aria-label="이미지 파일"
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        hidden
        onChange={handleFiles}
      />
      {rows.length > 0 && (
        <>
          <p aria-live="polite">{summary}</p>
          <ul aria-label="업로드 목록">
            {rows.map((row) => (
              <li key={row.id}>
                <div>
                  <strong>{row.file.name}</strong>
                  <span>{formatFileSize(row.file.size)}</span>
                </div>
                <span role="status" aria-label={`${row.file.name} 상태`}>
                  {statusLabel(row)}
                </span>
                {row.status === "uploading" && <progress aria-label={`${row.file.name} 업로드 진행률`} />}
                {row.error && <p>{row.error}</p>}
                {(row.status === "pending" || row.status === "error") && (
                  <button type="button" className="ui-button-secondary" aria-label={`${row.file.name} 업로드 제거`} onClick={() => removeRow(row.id)}>
                    제거
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function statusLabel(row: UploadRow) {
  if (row.status === "pending") return "대기 중";
  if (row.status === "uploading") return "업로드 중";
  if (row.status === "completed") return "완료";
  return "오류";
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}
